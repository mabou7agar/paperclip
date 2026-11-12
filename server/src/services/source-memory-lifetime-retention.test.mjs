// Synthetic-only A5 regressions; no reader bundle, live ledger or provider needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { SOURCE_MEMORY_RETENTION as policy, initializeSourceMemoryRetention, cleanupSourceMemoryRetention } from './source-memory.ts';

const moduleUrl = new URL('./source-memory.ts', import.meta.url).href;
function ledger() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE facts(key TEXT PRIMARY KEY,provenance TEXT); CREATE TABLE observations(key TEXT,run TEXT,operation TEXT,provenance TEXT,PRIMARY KEY(key,run,operation)); CREATE TABLE refs(ref TEXT PRIMARY KEY,revision TEXT); CREATE TABLE events(key TEXT PRIMARY KEY,ref TEXT,revision TEXT,queue TEXT)');
  return db;
}

test('legacy provenance retains unknown age through an idempotent additive migration', () => {
  const db = ledger();
  try {
    db.exec("INSERT INTO facts VALUES ('legacy','source'); INSERT INTO observations VALUES ('legacy','run','phase','source')");

    initializeSourceMemoryRetention(db);
    cleanupSourceMemoryRetention(db, 2 * policy.maxAgeMs);
    initializeSourceMemoryRetention(db);
    assert.equal(db.prepare("SELECT runtime_created_at_ms FROM facts").get().runtime_created_at_ms, null);
    assert.deepEqual(db.prepare('SELECT key,provenance FROM facts').get(), Object.assign(Object.create(null), {key:'legacy',provenance:'source'}));
    assert.equal(db.prepare('SELECT count(*) n FROM observations').get().n, 1);
  } finally { db.close(); }
});

async function runParent(script) {
  const parent = spawn(process.execPath, ['--input-type=module','-e',script], {stdio:['ignore','pipe','pipe']});
  let output='', errors='';
  parent.stdout.on('data', chunk=> output+=chunk);
  parent.stderr.on('data', chunk=> errors+=chunk);
  let timedOut = false;
  const deadline = setTimeout(()=> {
    timedOut = true;
    // Reap a mutant's surviving worker; do not leave a 60-second orphan.
    const pid = /worker-pid=(\d+)/.exec(output)?.[1];
    if (pid) {
      try { process.kill(process.platform === 'win32' ? Number(pid) : -Number(pid), 'SIGKILL'); } catch {}
    }
    parent.kill('SIGKILL');
  },5000);
  try {
    const [code] = await once(parent,'close');
    assert.equal(timedOut,false, 'worker survived parent exit until fixture cleanup');
    assert.equal(code,0, errors);
    assert.match(output,/ready/);
    return output;
  } finally { clearTimeout(deadline); }
}

test('IPC disconnect terminates a busy worker after its parent exits', {timeout:8000}, async () => {
  // No stdin parsing or EOF exit path. The live timer would keep an unguarded
  // worker alive for 60 seconds; the fixture must finish before its 5-second cap.
  await runParent(`import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['--input-type=module','-e',
      ${JSON.stringify(`import {guardSourceMemoryWorker} from ${JSON.stringify(moduleUrl)}; guardSourceMemoryWorker(60_000); setTimeout(()=>{},60_000); console.log('ready'); process.send('ready');`)}],
      {detached:process.platform!=='win32',stdio:['ignore',1,2,'ipc']});
    console.log('worker-pid='+child.pid);
    child.once('message',()=>process.exit(0));`);
});

test('worker-owned deadline kills worker and its local subprocess group', {timeout:8000,skip:process.platform==='win32'}, async () => {
  await runParent(`import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['--input-type=module','-e',
      ${JSON.stringify(`import {guardSourceMemoryWorker} from ${JSON.stringify(moduleUrl)}; import {spawn} from 'node:child_process'; guardSourceMemoryWorker(150); spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:['ignore',1,2]}); console.log('ready');`)}],{detached:true,stdio:['ignore',1,2,'ipc']});
    child.on('exit',(code,signal)=>{if(signal!=='SIGKILL') process.exitCode=1;});`);
});

test('early bootstrap owns disconnect while the service import is still initializing', {timeout:8000}, async () => {
  const { SOURCE_MEMORY_WORKER_BOOTSTRAP } = await import('./source-memory.ts');
  // New data-only fixture module deliberately never finishes its initialization.
  // The exact production bootstrap must guard it before the core can register.
  const initializing = "process.stdout.write('ready\\n');process.send('ready');await new Promise(r=>setTimeout(r,60000));";
  // Production passes a local filename; use a disposable module with that same
  // argv layout instead of changing the bootstrap to accept arbitrary URLs.
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'source-worker-initializing-'));
  try {
    const entry = path.join(directory, 'initializing.mjs');
    await writeFile(entry, initializing);
    await runParent(`import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(SOURCE_MEMORY_WORKER_BOOTSTRAP)},${JSON.stringify(entry)},'--source-memory-worker',String(process.pid)],
        {detached:process.platform!=='win32',stdio:['ignore',1,2,'ipc']});
      console.log('worker-pid='+child.pid);
      child.once('message',()=>process.exit(0));`);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

// These cases use the exact bootstrap (or an explicitly labelled test-only
// short-deadline/startup fault) with NEW disposable modules. No reader or state.
for (const afterRelease of [false, true]) test(`independent watchdog kills synchronous import${afterRelease ? ' after core release and its descendant' : ''} on parent death`, {timeout:8000,skip:process.platform==='win32'}, async () => {
  const { SOURCE_MEMORY_WORKER_BOOTSTRAP } = await import('./source-memory.ts');
  const { mkdtemp, writeFile, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'source-watchdog-busy-'));
  try {
    const entry = path.join(directory, 'busy.mjs');
    await writeFile(entry, `${afterRelease ? `process.argv[2]='--watchdog-fixture-core-import';const {guardSourceMemoryWorker}=await import(${JSON.stringify(moduleUrl)});const release=guardSourceMemoryWorker();release();` : ''}
      import {spawn} from 'node:child_process';
      ${afterRelease ? `const descendant=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:['ignore',1,2]});console.log('descendant-pid='+descendant.pid);` : ''}
      console.log('ready');process.send('ready');for(;;){}`);
    const output = await runParent(`import {spawn} from 'node:child_process';
      const child=spawn(process.execPath,['--input-type=module','--eval',${JSON.stringify(SOURCE_MEMORY_WORKER_BOOTSTRAP)},${JSON.stringify(entry)},'--source-memory-worker',String(process.pid)],
        {detached:true,stdio:['ignore',1,2,'ipc']});
      console.log('worker-pid='+child.pid);child.once('message',()=>process.exit(0));`);
    // Pipes remain open while either process runs. Also distinguish a reparented
    // dead zombie from an actual live orphan (Node cannot reap a grandchild).
    for (const match of output.matchAll(/(?:worker|descendant)-pid=(\d+)/g)) {
      const pid = Number(match[1]); let live = false;
      try {
        process.kill(pid,0);
        const value = await readFile('/proc/'+pid+'/stat','utf8');
        live = !/^\s*Z\b/.test(value.slice(value.lastIndexOf(')')+1));
      } catch (error) { if (!['ESRCH','ENOENT'].includes(error.code)) throw error; }
      assert.equal(live,false,'Owned worker/descendant must not remain running');
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

for (const scenario of ['pid1','wrong-parent','deadline','watchdog-failure','normal']) test(`independent watchdog ${scenario} fails closed or exits normally`, {timeout:8000,skip:process.platform==='win32'}, async () => {
  const { SOURCE_MEMORY_WORKER_BOOTSTRAP } = await import('./source-memory.ts');
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'source-watchdog-contract-'));
  let child, timedOut=false;
  try {
    const entry=path.join(directory,'entry.mjs'), marker=path.join(directory,'imported');
    await writeFile(entry, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'imported');
      ${scenario==='normal' ? `process.argv[2]='--watchdog-fixture-core-import';const {guardSourceMemoryWorker}=await import(${JSON.stringify(moduleUrl)});const release=guardSourceMemoryWorker();release();console.log('normal');process.disconnect();` : `process.send('busy');for(;;){}`}`);
    let bootstrap=SOURCE_MEMORY_WORKER_BOOTSTRAP;
    if(scenario==='deadline') {
      assert.equal(bootstrap.split('180_000_000_000n').length-1,1);
      bootstrap=bootstrap.replace('180_000_000_000n','1_500_000_000n'); // test-only 1.5 s; no parent kill timer before 5 s
    }
    if(scenario==='watchdog-failure') {
      assert.equal(bootstrap.split("parentPort.postMessage('ready');").length-1,1);
      bootstrap=bootstrap.replace("parentPort.postMessage('ready');","throw Error('synthetic watchdog startup failure');");
    }
    child=spawn(process.execPath,['--input-type=module','--eval',bootstrap,entry,'--source-memory-worker',String(scenario==='pid1'?1:scenario==='wrong-parent'?process.pid+1:process.pid)],
      {detached:true,stdio:['ignore','pipe','pipe','ipc']});
    let output='';child.stdout.on('data',value=>output+=value);child.stderr.resume();
    const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL')}catch{}},5000);
    let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer)}
    assert.equal(timedOut,false,'Fixture cleanup must not enforce the product deadline');
    if(scenario==='pid1') { assert.equal(code,1); assert.equal(signal,null); assert.equal(output,'source_memory_parent_pid1_unsupported'); }
    else if(scenario==='normal') { assert.equal(code,0);assert.equal(signal,null);assert.match(output,/normal/); }
    else { assert.equal(signal,'SIGKILL'); }
    if(['pid1','wrong-parent','watchdog-failure'].includes(scenario)) await assert.rejects(readFile(marker),{code:'ENOENT'});
    else assert.equal(await readFile(marker,'utf8'),'imported');
  } finally {
    if(child?.exitCode===null&&child?.signalCode===null)try{process.kill(-child.pid,'SIGKILL')}catch{}
    await rm(directory,{recursive:true,force:true});
  }
});
