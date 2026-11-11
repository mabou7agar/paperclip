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

test('legacy provenance is retained without migration or pruning', () => {
  const db = ledger();
  try {
    db.exec("INSERT INTO facts VALUES ('legacy','source'); INSERT INTO observations VALUES ('legacy','run','phase','source')");
    const before = JSON.stringify(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all());
    initializeSourceMemoryRetention(db);
    cleanupSourceMemoryRetention(db, 2 * policy.maxAgeMs);
    assert.equal(JSON.stringify(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()), before);
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
