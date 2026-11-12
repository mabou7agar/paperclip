// Operator-only, synthetic, no-provider qualification of an immutable artifact.
// No existing repository, ledger, account or provider transcript is read.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [serviceArg, chunkArg, readerArg, serviceHash, chunkHash, evidence] = process.argv.slice(2);
const [service, chunk, reader] = await Promise.all([serviceArg, chunkArg, readerArg].map(p => realpath(p)));
assert.equal(process.getuid(), 1000);
for (const value of [service, chunk, reader, evidence]) assert.ok(path.isAbsolute(value ?? ''));
const hash = b => createHash('sha256').update(b).digest('hex');
assert.equal(hash(await readFile(service)), serviceHash);
const source = await readFile(chunk, 'utf8'); assert.equal(hash(Buffer.from(source)), chunkHash);
const entryPattern = /if\s*\(process\.argv\[2\]\s*===\s*["']--source-memory-worker["']\)/g;
const entries = [...source.matchAll(entryPattern)]; assert.equal(entries.length, 1, 'Unique worker CLI entry required');
const entryLine = source.slice(0, entries[0].index).split('\n').length - 1;
assert.match(source.split('\n')[entryLine], /^\s*if\s*\(process\.argv\[2\]\s*===\s*["']--source-memory-worker["']\)\s*\{\s*$/);
// preserveModuleLocation intentionally makes the ordinary argv target the
// emitted service. Prove this mapped bundle artifact has that same source,
// rather than pretending the emitted service normally imports the chunk.
const emittedMap = JSON.parse(await readFile(service + '.map', 'utf8'));
const bundleMapBytes = await readFile(chunk + '.map');
const bundleMap = JSON.parse(bundleMapBytes);
const emittedOrigins = await Promise.all(emittedMap.sources.map(p => realpath(path.resolve(path.dirname(service), emittedMap.sourceRoot ?? '', p))));
const linked = [];
for (let i = 0; i < bundleMap.sources.length; i++) {
  const p = path.resolve(path.dirname(chunk), bundleMap.sourceRoot ?? '', bundleMap.sources[i]);
  if (emittedOrigins.includes(p)) linked.push({ path: p, content: bundleMap.sourcesContent[i] });
}
assert.equal(linked.length, 1);
assert.equal(hash(Buffer.from(linked[0].content)), hash(await readFile(linked[0].path)), 'Bundle map must contain the exact qualified source');
const bundleSourceLink = { origin: linked[0].path, originSha256: hash(Buffer.from(linked[0].content)), bundleMapSha256: hash(bundleMapBytes) };
const manifestPath = path.join(path.dirname(reader), 'tooling-9c477cebfff7-manifest.json');
const manifestBytes = await readFile(manifestPath);
assert.equal(hash(manifestBytes), '0024f01f17032a78c99cd2b14c8c58ddf5501025c24e9528e9c448679514b71a');
const manifest = JSON.parse(manifestBytes); assert.equal(manifest.files.length, 38);
const pageBytes = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8', timeout: 5000 }).trim());
assert.ok(Number.isSafeInteger(pageBytes) && pageBytes >= 4096 && pageBytes <= 262144);
for (const file of manifest.files) {
  const target = path.resolve(reader, file.path); assert.ok(target.startsWith(reader + path.sep));
  assert.equal(hash(await readFile(target)), file.sha256);
}
const actualReaderFiles = [];
async function inventory(directory) {
  for (const name of await readdir(directory)) {
    const target = path.join(directory, name), info = await lstat(target);
    assert.ok(!info.isSymbolicLink(), 'Reader fixture must contain no symlinks');
    if (info.isDirectory()) await inventory(target);
    else { assert.ok(info.isFile()); actualReaderFiles.push(path.relative(reader, target)); }
  }
}
await inventory(reader);
assert.deepEqual(actualReaderFiles.sort(), manifest.files.map(f => f.path).sort(), 'Exact code-only reader tree');
const reaperStatus=process.env.SOURCE_LIFECYCLE_REAPER_STATUS;
assert.ok(path.isAbsolute(reaperStatus??''));
assert.ok(path.resolve(reaperStatus)!==path.resolve(evidence)&&!path.resolve(reaperStatus).startsWith(path.resolve(evidence)+path.sep),'Reaper status must be outside evidence');
assert.equal(existsSync(evidence),false,'Use a new exclusive evidence directory');
const preflightDeadline=performance.now()+1000;let preflightReaper;
do{preflightReaper=(await rows(reaperStatus)).find(e=>e.kind==='started');if(!preflightReaper)await delay(5);}while(!preflightReaper&&performance.now()<preflightDeadline);
assert.ok(preflightReaper);assert.equal(preflightReaper.pid,process.ppid);assert.equal(preflightReaper.mainPid,process.pid);assert.equal(preflightReaper.subreaper,true);assert.equal(preflightReaper.helperSha256,hash(await readFile(new URL(import.meta.url))));
process.kill(process.ppid,0); // Existence/permission check only, no signal sent.
await mkdir(evidence, { mode: 0o700 }); // Refuse an existing result directory.
const receipts = path.join(evidence, 'receipts.jsonl');
const record = async value => {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(receipts, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
};
let root, caughtFailure;
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8', NODE_OPTIONS: '', NODE_PATH: '',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PYTHONDONTWRITEBYTECODE: '1' };
const allowedPrograms=[];let platformProbeProgram;
let parent, worker, parentKilled = false, error = '';
const spawnRecords = [];
async function waitExit(child, ms = 2000) {
 const until = performance.now() + ms;
 while (child.exitCode === null && child.signalCode === null && performance.now() < until) await delay(10);
 assert.ok(child.exitCode !== null || child.signalCode !== null, 'Parent exit deadline exceeded');
}

async function state(pid, mainThread = false) {
  try {
    const raw = await readFile('/proc/' + pid + (mainThread ? '/task/' + pid : '') + '/stat', 'utf8');
    const f = raw.slice(raw.lastIndexOf(')') + 1).trim().split(' ').filter(Boolean);
    return { pid, exists: true, state: f[0], ppid: Number(f[1]), pgid: Number(f[2]), sessionId: Number(f[3]),
      cpuTicks: Number(f[11]) + Number(f[12]), birth: f[19], rssPages: Number(f[21]), raw };
  } catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') return { pid, exists: false }; throw e; }
}
const inactive = s => !s.exists || s.state === 'Z' || s.state === 'X';
async function rows(file) {
  try {
    const text = await readFile(file, 'utf8');
    // An active observer may still be appending its last line.
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
  }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
function metrics(events) {
  return { externalCommands: events.filter(e => e.kind === 'exec').length,
    forbiddenExecutionAttempts: events.filter(e => e.kind === 'forbidden-exec').length,
    providerExecutionAttempts: events.filter(e => e.kind === 'forbidden-exec' && e.provider).length,
    platformProbeCommands:events.filter(e=>e.kind==='exec'&&e.platformProbe).length,
    networkAttempts: events.filter(e => e.kind === 'network').length };
}

// Observe the actual lowest asynchronous process boundary, preserving execFile's
// promisify semantics. All synchronous entry points are covered separately.
function observerCode(log) {
  return `import fs from 'node:fs';
import cp from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const log=${JSON.stringify(log)};
const note=e=>fs.appendFileSync(log,JSON.stringify({mono:String(process.hrtime.bigint()),pid:process.pid,...e})+'\\n');
let approvedNativeSpawn=false;
const check=(file,api,childEnv,args=[],childCwd=process.cwd())=>{
 const program=String(file).split('/').at(-1);
 const cwd=path.resolve(String(childCwd??process.cwd()));
 const paths=String(file).includes('/')?[path.resolve(cwd,String(file))]:((childEnv??process.env).PATH??'').split(':').map(d=>path.resolve(cwd,d,String(file)));
 let resolved;for(const p of paths){try{resolved=fs.realpathSync(p);break}catch(e){if(e.code!=='ENOENT')throw e}}
 const probeEnvironments=${JSON.stringify([env,{PATH:env.PATH,HOME:"/nonexistent",LANG:"C.UTF-8",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0",NODE_OPTIONS:"",NODE_PATH:"",NODE_NO_WARNINGS:"1"}])};
 const effectiveEnv=childEnv??process.env;
 const probeEnvPinned=probeEnvironments.some(probeEnvironment=>Object.keys(effectiveEnv).length===Object.keys(probeEnvironment).length&&Object.entries(probeEnvironment).every(([key,value])=>effectiveEnv[key]===value));
 const probePathPinned=String(file)===${JSON.stringify(platformProbeProgram)}||(!String(file).includes('/')&&((effectiveEnv.PATH??'').split(':').every(p=>path.isAbsolute(p)&&p.length>0)));
 const platformProbe=resolved===${JSON.stringify(platformProbeProgram)}&&probePathPinned&&probeEnvPinned&&args.length===1&&args[0]==='GNU_LIBC_VERSION';
 const allowed=platformProbe||${JSON.stringify(allowedPrograms)}.includes(resolved)||(resolved===fs.realpathSync(process.execPath)&&approvedNativeSpawn);
 if(!allowed){note({kind:'forbidden-exec',api,program,resolved,provider:/codex|claude|acpx|agy|aider|opencode|copilot|gemini|grok|kimi|cline|cursor/.test(program)});throw Error('qualifier_forbidden_exec');}
 note({kind:'exec',api,program,resolved,...(platformProbe?{platformProbe:true,args}: {})});
};
const spawnOriginal=cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn=function(options){const childEnv=options.envPairs?Object.fromEntries(options.envPairs.map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)]})):process.env;check(options.file,'spawn',childEnv,(options.args??[]).slice(1),options.cwd);return spawnOriginal.call(this,options)};
for(const key of ['spawnSync','execFileSync']){const original=cp[key];cp[key]=(...args)=>{if(args.some(a=>a&&typeof a==='object'&&!Array.isArray(a)&&a.shell))check('shell',key);const options=args.find(a=>a&&typeof a==='object'&&!Array.isArray(a));check(args[0],key,options?.env,Array.isArray(args[1])?args[1]:[],options?.cwd);return original(...args)}}
const shellOriginal=cp.execSync;cp.execSync=(...args)=>{check('shell','execSync');return shellOriginal(...args)};
net.Socket.prototype.connect=function(){note({kind:'network',api:'Socket.connect'});throw Error('qualifier_network_attempt')};
dgram.Socket.prototype.send=function(){note({kind:'network',api:'dgram.send'});throw Error('qualifier_network_attempt')};
syncBuiltinESMExports();
`;
}


function entryObserverCode(modulePath,lineNumber) {
  return `
import {Session} from 'node:inspector';
const inspector=new Session();inspector.connect();
const post=(method,params={})=>new Promise((resolve,reject)=>inspector.post(method,params,(e,r)=>e?reject(e):resolve(r)));
await post('Debugger.enable');
inspector.on('Debugger.breakpointResolved',({params})=>note({kind:'breakpoint-bound',breakpointId:params.breakpointId,location:params.location}));
const breakpoint=await post('Debugger.setBreakpointByUrl',{url:${JSON.stringify(pathToFileURL(modulePath).href)},lineNumber:${lineNumber}});
note({kind:'breakpoint-created',initialLocations:breakpoint.locations.length});
if(breakpoint.locations.length)note({kind:'breakpoint-bound',breakpointId:breakpoint.breakpointId});
inspector.on('Debugger.paused',({params})=>{const frame=params.callFrames[0];const expected=params.hitBreakpoints?.includes(breakpoint.breakpointId)&&frame?.location.lineNumber===${lineNumber};note({kind:expected?'worker-entry-reached':'unexpected-pause',location:frame?.location,url:frame?.url,hitBreakpoints:params.hitBreakpoints});inspector.post('Debugger.resume')});
note({kind:'import-start'});
setInterval(()=>note({kind:'pulse'}),10).unref();
`;
}

try {
  root=await mkdtemp(path.join(tmpdir(),'source-bundle-lifecycle-'));
  for(const name of ['git','python3','python'])for(const directory of env.PATH.split(':')){
 try{allowedPrograms.push(await realpath(path.join(directory,name)));break;}catch(e){if(e.code!=='ENOENT')throw e;}
}
assert.ok(allowedPrograms.some(p=>p.endsWith('/git')));
platformProbeProgram=await realpath('/usr/bin/getconf');assert.equal(platformProbeProgram,'/usr/bin/getconf');

  await record({ step: 'provenance', helperSha256: hash(await readFile(new URL(import.meta.url))), node: process.version, uid: process.getuid(), service, chunk, reader, serviceHash, chunkHash, bundleSourceLink, entryLine, readerManifestSha256: hash(manifestBytes), pageBytes, isolationRequired: 'nonroot/networknone/no credentials/no production mounts', measurementScope: 'Attempts at patched Node child-process/socket APIs in parent and worker, pinned executable paths. One exact /usr/bin/getconf GNU_LIBC_VERSION platform probe is allowed and reported separately; every other getconf argument remains forbidden. Native descendants, DNS, addons, worker_threads, process.binding/internal paths are not instrumented; private no-network container/no credentials confines these separately. Worker --eval bootstrap runs BEFORE observer installation; it is covered only by its exact runtime export match, saved source/hash and container isolation. Host receipt inventories all bundle files and full overlay hashes.' });
  const reaperStart=preflightReaper;
  const oomBaseline=(await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill\s+(\d+)/m)?.[1];assert.ok(oomBaseline!==undefined,'Cgroup v2 OOM counter required before artifact cases');
  await record({step:'preflight-isolation-observers',reaperStart,oomBaseline});
  // Positive controls are rejected BEFORE executing a CLI or connecting a socket.
  // This verifies observation, and is explicitly not a real provider probe.
  const controlLog = path.join(evidence, 'observer-control.jsonl');
  const control = path.join(root, 'control.mjs');
  await writeFile(control, observerCode(controlLog) + `
import assert from 'node:assert/strict';
import {spawn as namedSpawn,spawnSync as namedSpawnSync,execFileSync as namedExecFileSync,execFile as namedExecFile,fork as namedFork} from 'node:child_process';
for(const action of [()=>cp.spawn('codex',[]),()=>namedSpawn('codex',[]),()=>namedSpawnSync('codex',[]),()=>namedExecFileSync('codex',[]),()=>namedExecFile('codex',[]),()=>namedFork('codex',[]),()=>namedSpawnSync('git',[],{shell:true}),()=>namedExecFileSync('/usr/bin/getconf',['PATH'])]) assert.throws(action,/qualifier_forbidden_exec/);
const libc=namedExecFileSync('/usr/bin/getconf',['GNU_LIBC_VERSION'],{encoding:'utf8',timeout:1000,maxBuffer:1024});assert.match(libc,/^glibc\\s+[0-9.]+\\s*$/);
const socket=new net.Socket();try{assert.throws(()=>socket.connect({host:'127.0.0.1',port:9}),/qualifier_network_attempt/)}finally{socket.destroy()}
`);
  execFileSync(process.execPath, [control], { env, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
  const controlMetrics = metrics(await rows(controlLog));
  assert.equal(controlMetrics.forbiddenExecutionAttempts, 8);assert.equal(controlMetrics.externalCommands,1);assert.equal(controlMetrics.platformProbeCommands,1); assert.equal(controlMetrics.providerExecutionAttempts, 5); assert.equal(controlMetrics.networkAttempts, 1);
  await record({ step: 'observer-positive-control', ...controlMetrics, actualExecutions: 1,actualProviderExecutions:0,actualExecutionScope:'Pinned /usr/bin/getconf GNU_LIBC_VERSION only', actualConnections: 0 });

  // Qualify this Node build's same-thread inspector mechanism on synthetic
  // modules before spending the actual artifact's lifecycle attempt.
  const inspectorLog=path.join(evidence,'inspector-control.jsonl');
  const inspectorModule=path.join(root,'inspector-module.mjs');
  const debuggerModule=path.join(root,'debugger-module.mjs');
  await writeFile(inspectorModule,'if (process.argv[2] === "--source-memory-worker") {\n globalThis.synthetic=true;\n}\n');
  await writeFile(debuggerModule,'debugger;\nexport const synthetic=true;\n');
  const inspectorControl=path.join(root,'inspector-control.mjs');
  const inspectorControlCode=observerCode(inspectorLog)+entryObserverCode(inspectorModule,0)+
    `await import(${JSON.stringify(pathToFileURL(inspectorModule).href)});note({kind:'import-complete'});await import(${JSON.stringify(pathToFileURL(debuggerModule).href)});inspector.disconnect();`;
  await writeFile(inspectorControl,inspectorControlCode);
  execFileSync(process.execPath,[inspectorControl],{env,timeout:10000,killSignal:'SIGKILL',stdio:['ignore','pipe','pipe']});
  const controlEvents=await rows(inspectorLog),entry=controlEvents.filter(e=>e.kind==='worker-entry-reached'),unexpected=controlEvents.filter(e=>e.kind==='unexpected-pause');
  assert.equal(entry.length,1);assert.equal(unexpected.length,1);
  assert.ok(controlEvents.some(e=>e.kind==='breakpoint-bound'&&BigInt(e.mono)<BigInt(entry[0].mono)));
  assert.ok(controlEvents.some(e=>e.kind==='import-complete'&&BigInt(e.mono)>BigInt(entry[0].mono)));
  await record({step:'inspector-positive-control',exactEntryMarkers:entry.length,unexpectedDebuggerMarkers:unexpected.length,controlSha256:hash(Buffer.from(inspectorControlCode)),passed:true});

  const repo = path.join(root, 'repo'); await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout:10000,killSignal:'SIGKILL' }).trim();
  git('init', '-q', '-b', 'candidate'); git('remote', 'add', 'origin', 'https://github.com/synthetic/lifecycle');
  await writeFile(path.join(repo, 'example.ts'), 'export const context = "synthetic lifecycle";\n');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic',
    '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic');
  const revision = git('rev-parse', 'HEAD');
  const scope = { companyId: randomUUID(), projectId: randomUUID(), repositoryId: 'github.com/synthetic/lifecycle' };
  const input = { ...scope, issueId: randomUUID(), runId: randomUUID(), phase: 'implementation',
    provider: 'synthetic', model: 'never-paid', cwd: repo, repoUrl: 'https://github.com/synthetic/lifecycle', remoteAuthority: false };
  const config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, state: path.join(root, 'new-state'), reader,
    manifest: manifestPath, bindings: [{ ...scope, roots: [repo] }] }));

  async function driver(mode, operation) {
    const eventLog = path.join(evidence, mode + '-worker.jsonl');
    const parentLog = path.join(evidence, mode + '-parent-events.jsonl');
    let selectedConfig=config;
    if(mode==='cancel'){selectedConfig=path.join(root,'cancel-config.json');await writeFile(selectedConfig,JSON.stringify({version:1,state:path.join(root,'cancel-untouched-state'),reader,manifest:manifestPath,bindings:[{...scope,roots:[repo]}]}));}
    const spawnRecord = path.join(evidence, mode + '-spawn.json'); spawnRecords.push(spawnRecord);
    const wrapper = path.join(root, mode + '-wrapper.mjs');
    let code = observerCode(eventLog)+`
process.on('exit',code=>note({kind:'worker-exit',code}));
process.on('uncaughtExceptionMonitor',()=>note({kind:'uncaught-error'}));
process.on('unhandledRejection',()=>{note({kind:'unhandled-rejection'});process.exit(1)});
`;
    code += entryObserverCode(chunk,entryLine);
    code += `await import(${JSON.stringify(pathToFileURL(chunk).href)});\nnote({kind:'import-complete'});\n`;
    await writeFile(wrapper, code); await writeFile(path.join(evidence, mode + '-wrapper.mjs'), code);
    const file = path.join(root, mode + '-parent.mjs');
    const parentCode = observerCode(parentLog) + `
import {realpathSync} from 'node:fs';import {createHash} from 'node:crypto';
const original=cp.spawn;let workerSpawned=false,qualifiedBootstrap;
cp.spawn=(command,args,options)=>{const worker=args?.includes('--source-memory-worker');if(worker){
 if(workerSpawned)throw Error('Only one worker spawn per parent');workerSpawned=true;
 if(args[2]!==qualifiedBootstrap)throw Error('Bootstrap must exactly match the qualified service export');
 fs.writeFileSync(${JSON.stringify(path.join(evidence,mode+'-bootstrap.mjs'))},args[2],{flag:'wx'});
 if(args.length!==6||args[0]!=='--input-type=module'||args[1]!=='--eval'||args[4]!=='--source-memory-worker'||args[5]!==String(process.pid))throw Error('Unexpected worker argv');
 if(realpathSync(args[3])!==${JSON.stringify(service)})throw Error('Native worker must target the qualified emitted service');
 const originalEntry=args[3],bootstrapSha256=createHash('sha256').update(args[2]).digest('hex');
 args=[...args];args[3]=${JSON.stringify(wrapper)};
 const child=(()=>{approvedNativeSpawn=true;try{return original(command,args,options)}finally{approvedNativeSpawn=false}})();
 child.once('spawn',()=>{const raw=fs.readFileSync('/proc/'+child.pid+'/stat','utf8');const f=raw.slice(raw.lastIndexOf(')')+1).trim().split(/\\s+/);fs.writeFileSync(${JSON.stringify(spawnRecord)},JSON.stringify({parentPid:process.pid,workerPid:child.pid,detached:options.detached,pgid:Number(f[2]),sessionId:Number(f[3]),birth:f[19],originalEntry,bootstrapSha256}),{flag:'wx'});});return child;
}return original(command,args,options)};syncBuiltinESMExports();
const module=await import(${JSON.stringify(pathToFileURL(service).href)});
const{prepareSourceMemory}=module;qualifiedBootstrap=module.SOURCE_MEMORY_WORKER_BOOTSTRAP;if(typeof qualifiedBootstrap!=='string')throw Error('Qualified bootstrap export required');
const result=await prepareSourceMemory(${JSON.stringify(input)},${JSON.stringify(operation)},${JSON.stringify(selectedConfig)});
process.stdout.write(JSON.stringify({kind:'result',result})+'\\n');
`;
    await writeFile(file, parentCode); await writeFile(path.join(evidence, mode + '-parent.mjs'), parentCode);
    await record({step:'generated-driver',mode,wrapperSha256:hash(Buffer.from(code)),parentShimSha256:hash(Buffer.from(parentCode))});
    return { file, eventLog, parentLog, spawnRecord };
  }

  for (const [mode, operation] of [['phase', 'phase'], ['duplicate', 'commit']]) {
    const prepared = await driver(mode, operation);
    let output;
    try {output = execFileSync(process.execPath, [prepared.file], { env, encoding: 'utf8', timeout: 190000,killSignal:'SIGKILL', maxBuffer: 524288 });}
    catch(failure){await writeFile(path.join(evidence,mode+'-failure-output.log'),String(failure.stdout??''));await writeFile(path.join(evidence,mode+'-failure-stderr.log'),String(failure.stderr??'').slice(0,16384));throw failure;}
    await writeFile(path.join(evidence, mode + '-output.jsonl'), output);
    const parsed = output.trim().split('\n').filter(line => line.startsWith('{"kind":')).map(JSON.parse); const result = parsed.find(x => x.kind === 'result')?.result;
    assert.equal(result?.revision, revision);
    if (mode === 'phase') assert.ok(result.citations.length > 0);
    else { assert.equal(result.event, 'duplicate'); assert.equal(result.blobReads, 0); }
    const workerEvents = await rows(prepared.eventLog);
    const spawnInfo=JSON.parse(await readFile(prepared.spawnRecord,'utf8'));
    assert.equal(hash(await readFile(path.join(evidence,mode+'-bootstrap.mjs'))),spawnInfo.bootstrapSha256);
    await record({step:mode+'-bootstrap-verified',bootstrapSha256:spawnInfo.bootstrapSha256});
    assert.ok(!workerEvents.some(e=>e.kind==='unexpected-pause'));
    assert.ok(workerEvents.some(e => e.kind === 'breakpoint-bound')); 
    const entries = workerEvents.filter(e => e.kind === 'worker-entry-reached');
    assert.equal(entries.length, 1, 'Positive control must reach the real CLI entry');
    assert.ok(workerEvents.some(e=>e.kind==='breakpoint-bound'&&BigInt(e.mono)<BigInt(entries[0].mono)));
    const complete = workerEvents.find(e => e.kind === 'import-complete');
    assert.ok(complete && BigInt(entries[0].mono) < BigInt(complete.mono), 'Entry marker works before import completes');
    const parentEvents=await rows(prepared.parentLog);
    const parentMetrics=metrics(parentEvents),workerMetrics=metrics(workerEvents);
    const workerGitCommands=workerEvents.filter(e=>e.kind==='exec'&&e.program==='git'&&e.pid===spawnInfo.workerPid).length;
    const parentNodeCommands=parentEvents.filter(e=>e.kind==='exec'&&e.program===path.basename(process.execPath)&&e.pid===spawnInfo.parentPid).length;
    if(mode==='phase')assert.ok(workerGitCommands>0,'Worker Git positive observation');assert.equal(parentNodeCommands,1);
    const groupDeadline=performance.now()+5000,groupStart=performance.now();let liveGroup;
    do{liveGroup=[];for(const name of await readdir('/proc'))if(/^\d+$/.test(name)){const p=await state(Number(name));if(p.exists&&p.pgid===spawnInfo.pgid&&!inactive(p))liveGroup.push(p);}
      await record({step:mode+'-group-after-parent-exit',elapsedMs:performance.now()-groupStart,members:liveGroup.map(p=>({pid:p.pid,birth:p.birth}))});
      if(liveGroup.length)await delay(20);
    }while(liveGroup.length&&performance.now()<groupDeadline);
    assert.equal(liveGroup.length,0,'Worker group must stop within five seconds without forced cleanup');
    assert.equal((await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill\s+(\d+)/m)?.[1],oomBaseline,'No OOM during positive artifact controls');
    const observed = metrics([...workerEvents,...parentEvents]);
    assert.equal(observed.forbiddenExecutionAttempts, 0);assert.equal(observed.providerExecutionAttempts,0);assert.ok(observed.platformProbeCommands<=1); assert.equal(observed.networkAttempts, 0);
    await record({ step: mode, revision, citations: result.citations?.length??null, blobReads: result.blobReads, workerGitCommands,parentNodeCommands,parentMetrics,workerMetrics, ...observed });
  }

  const prepared = await driver('cancel', 'phase');
  const oomBefore=(await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill\s+(\d+)/m)?.[1];assert.equal(oomBefore,oomBaseline);
  const cancelStartMono=process.hrtime.bigint();await record({step:'cancel-preflight',oomBefore,cancelStartMono:String(cancelStartMono)});
  parent = spawn(process.execPath, [prepared.file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  parent.on('error', e => { error += String(e); });
  parent.stderr.on('data', b => { if (error.length < 4096) error += b; });
  parent.stdout.resume();
  const spawnDeadline = performance.now() + 15000;
  let spawned;
  while (!spawned && performance.now() < spawnDeadline) {
    try { spawned = JSON.parse(await readFile(prepared.spawnRecord, 'utf8')); } catch(e) { if(e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    if(!spawned) await delay(10);
  }
  assert.ok(spawned, 'Worker spawn: ' + error);
  worker = { pid: spawned.workerPid, birth: spawned.birth, pgid: spawned.pgid, sessionId:spawned.sessionId, exists: true };
  assert.equal(spawned.parentPid, parent.pid); assert.equal(spawned.detached, true);
  assert.equal(worker.pgid, worker.pid);assert.equal(worker.sessionId,worker.pgid); assert.ok((await state(worker.pid)).exists);
  const importDeadline = performance.now() + 20000; let blocked, pulseSample;
  while (performance.now() < importDeadline) {
    const events = await rows(prepared.eventLog);
    assert.ok(!events.some(e=>e.kind==='unexpected-pause'));
    assert.ok(!events.some(e => e.kind === 'import-complete'), 'Import completed before cancellation');
    assert.ok(!events.some(e => e.kind === 'worker-entry-reached'), 'Entry reached before the observed blocked-import window');
    const begin = events.find(e => e.kind === 'import-start');
    const lastPulse = events.filter(e => e.kind === 'pulse').at(-1) ?? begin;
    const current = await state(worker.pid,true);
    if(lastPulse && current.exists && pulseSample?.mono !== lastPulse.mono) pulseSample={mono:lastPulse.mono,cpuTicks:current.cpuTicks,observedMono:String(process.hrtime.bigint())};
    if (events.some(e => e.kind === 'breakpoint-bound') && pulseSample && begin && lastPulse && current.exists && current.state === 'R' && current.birth === worker.birth &&
      process.hrtime.bigint() - BigInt(lastPulse.mono) >= 250000000n && current.cpuTicks > pulseSample.cpuTicks && current.rssPages * pageBytes >= 67108864) {
      blocked = { importStart: begin.mono, lastPulse: lastPulse.mono, pulseLagMs: Number(process.hrtime.bigint() - BigInt(lastPulse.mono)) / 1e6,
        cpuScope:'main-thread /proc/pid/task/pid/stat',pulseSample, pageBytes, rssBytes: current.rssPages * pageBytes, current };
      break;
    }
    await delay(10);
  }
  assert.ok(blocked, 'No measured blocked large-import window; do not manufacture a pass');
  await record({ step: 'blocked-import-before-kill', ...blocked });
  const killRequestedMono = process.hrtime.bigint();
  const killAt = performance.now(); assert.equal(parent.kill('SIGKILL'), true); parentKilled = true; await waitExit(parent);
  const parentDeathObservedMono = process.hrtime.bigint();
  let final;
  for (let i = 0; i < 50; i++) { final = await state(worker.pid); await record({ step: 'after-kill', elapsedMs: performance.now() - killAt, final });
    if (inactive(final) || final.birth !== worker.birth) break; await delay(100); }
  assert.ok(inactive(final) || final.birth !== worker.birth, 'Worker did not stop within five seconds');
  const runningGroup = [];
  for (const name of await readdir('/proc')) if (/^\d+$/.test(name)) {
    const p = await state(Number(name)); if (p.exists && p.pgid === worker.pgid && !inactive(p)) runningGroup.push(p);
  }
  assert.equal(runningGroup.length, 0);
  const reapDeadline=performance.now()+2000;let reaped;
  do{reaped=(await rows(reaperStatus)).find(e=>e.kind==='reaped'&&e.pid===worker.pid&&e.birth===worker.birth);if(!reaped)await delay(10);}while(!reaped&&performance.now()<reapDeadline);
  assert.ok(reaped,'Actual adopted worker wait status required');assert.equal(reaped.signal,9);assert.equal(reaped.coreDump,false);
  assert.equal((await readFile('/sys/fs/cgroup/memory.events','utf8')).match(/^oom_kill\s+(\d+)/m)?.[1],oomBefore, 'No cgroup OOM kill may explain termination');
  const reaperEvents=await rows(reaperStatus);
  assert.ok(!reaperEvents.some(e=>['forced-cleanup','interrupted'].includes(e.kind)),'Supervisor must not cause the observed termination');
  const cancelReaped=reaperEvents.filter(e=>e.kind==='reaped'&&BigInt(e.mono)>=cancelStartMono);
  assert.equal(cancelReaped.length,1);assert.equal(cancelReaped[0].pid,worker.pid);
  const adoptedLive=[];for(const name of await readdir('/proc'))if(/^\d+$/.test(name)&&Number(name)!==process.pid){const p=await state(Number(name));if(p.exists&&p.ppid===process.ppid)adoptedLive.push({pid:p.pid,birth:p.birth,state:p.state});}
  assert.equal(adoptedLive.length,0,'No unexplained adopted helper process');
  let cancelState;try{const files=await readdir(path.join(root,'cancel-untouched-state'));cancelState={exists:true,files};}catch(e){if(e.code!=='ENOENT')throw e;cancelState={exists:false,files:[]};}
  assert.deepEqual(cancelState,{exists:false,files:[]},'Cancellation must not open or mutate a ledger');
  for(const file of [prepared.eventLog,prepared.parentLog]){const raw=await readFile(file,'utf8');assert.ok(raw===''||raw.endsWith('\n'),'Final observer log may not contain a truncated record');}
  assert.equal(hash(await readFile(service)),serviceHash);assert.equal(hash(await readFile(chunk)),chunkHash);
  assert.equal(hash(await readFile(chunk+'.map')),bundleSourceLink.bundleMapSha256);
  assert.equal(hash(await readFile(bundleSourceLink.origin)),bundleSourceLink.originSha256);
  assert.equal(hash(await readFile(manifestPath)),hash(manifestBytes));
  for(const f of manifest.files)assert.equal(hash(await readFile(path.resolve(reader,f.path))),f.sha256);
  actualReaderFiles.length=0;await inventory(reader);assert.deepEqual(actualReaderFiles.sort(),manifest.files.map(f=>f.path).sort());
  const cancelSpawn=JSON.parse(await readFile(prepared.spawnRecord,'utf8'));assert.equal(hash(await readFile(path.join(evidence,'cancel-bootstrap.mjs'))),cancelSpawn.bootstrapSha256);
  await record({step:'cancel-bootstrap-verified',bootstrapSha256:cancelSpawn.bootstrapSha256});
  await record({step:'post-run-artifact-reader-hashes',serviceHash,chunkHash,manifestHash:hash(manifestBytes),readerFiles:manifest.files.length,allUnchanged:true});
  const observed = metrics([...await rows(prepared.eventLog), ...await rows(prepared.parentLog)]);
  const afterEvents=await rows(prepared.eventLog);
  assert.ok(!afterEvents.some(e=>['unexpected-pause','uncaught-error','unhandled-rejection','worker-exit','worker-entry-reached','import-complete'].includes(e.kind)),'Expected hard termination before body, not a JS crash or successful job');
  const cancelWorkerExecs=afterEvents.filter(e=>e.kind==='exec'&&e.pid===worker.pid).length;assert.equal(cancelWorkerExecs,0,'No business execution anywhere in the cancel case');
  assert.ok(!afterEvents.some(e => ['worker-entry-reached','import-complete'].includes(e.kind) && BigInt(e.mono) <= parentDeathObservedMono),
    'Worker entry was observed before parent death; no blocked-import pass');
  assert.equal(observed.forbiddenExecutionAttempts, 0);assert.equal(observed.providerExecutionAttempts,0);assert.ok(observed.platformProbeCommands<=1); assert.equal(observed.networkAttempts, 0);
  await record({ step: 'cancel-pass', killRequestedMono: String(killRequestedMono), parentDeathObservedMono: String(parentDeathObservedMono), elapsedMs: performance.now() - killAt, final, runningGroupMembers: 0,cancelWorkerExecs,cancelReaped,adoptedLive, reaped,cancelState,stateInventorySha256:hash(Buffer.from(JSON.stringify(cancelState))),terminationScope:'Actual SIGKILL observed by a non-signalling subreaper before CLI entry; no JS exit/error or business activity. Consistent with independent native watchdog; do not claim CLI body handled death.',afterDeathMarkers: afterEvents.filter(e => ['worker-entry-reached','import-complete'].includes(e.kind) && BigInt(e.mono)>parentDeathObservedMono), ...observed });
  console.log(JSON.stringify({ schema: 'source-bundle-lifecycle.v1', serviceHash, chunkHash, helperAssertionsPassed: true,finalVerdictRequires:'supervisor exit0/terminal forcedCleanupfalse uninterrupted/no cleanup deadline; helper cleanupErrors[]; copy complete reaper status to evidence',
    phaseAndDuplicate: true, blockedImportMeasured: true, cancelledWorker: worker.pid, final,
    observed: 'process/network boundary records with rejected positive controls; no literal provider-count assertion' }));
 } catch (failure) {
  caughtFailure=failure;
  try { await record({step:'failed',error:String(failure),stderr:error}); } catch (receiptError) { console.error('Failure receipt unavailable: '+String(receiptError)); }
  throw failure;
} finally {
  const cleanupErrors=[];
  if(parent && !parentKilled && parent.exitCode===null && parent.signalCode===null) {
    try { parent.kill('SIGKILL'); await waitExit(parent); } catch(e) {cleanupErrors.push(String(e));}
  }
  for(const file of spawnRecords) {
    try {
      const saved=JSON.parse(await readFile(file,'utf8'));
      const leader=await state(saved.workerPid);
      if(leader.exists && leader.birth!==saved.birth) throw Error('PID reused; refuse group cleanup');
      const members=[];
      for(const name of await readdir('/proc'))if(/^\d+$/.test(name)){
        const p=await state(Number(name));if(p.exists&&p.pgid===saved.pgid&&!inactive(p))members.push(p);
      }
      if(members.length){
        // This PGID was created detached by this driver. Its leader may already
        // be gone while Git/Python children retain that same process group.
        assert.equal(saved.sessionId,saved.pgid);
        assert.ok(members.every(p=>p.sessionId===saved.sessionId&&BigInt(p.birth)>=BigInt(saved.birth)));
        process.kill(-saved.pgid,'SIGKILL');
        const until=performance.now()+2000;let remaining;
        do{remaining=[];for(const name of await readdir('/proc'))if(/^\d+$/.test(name)){const p=await state(Number(name));if(p.exists&&p.pgid===saved.pgid&&!inactive(p))remaining.push(p);}if(remaining.length)await delay(20);}while(remaining.length&&performance.now()<until);
        assert.equal(remaining.length,0,'Owned group cleanup did not settle');
        await record({step:'forced-owned-group-cleanup',group:saved.pgid,members:members.map(p=>({pid:p.pid,birth:p.birth}))});
      }
    } catch(e) {if(e.code!=='ENOENT'&&e.code!=='ESRCH')cleanupErrors.push(String(e));}
  }
  if(root)for(const name of await readdir('/proc'))if(/^\d+$/.test(name)&&Number(name)!==process.pid){
    try{const p=await state(Number(name));if(!p.exists||inactive(p))continue;
      const argv=await readFile('/proc/'+name+'/cmdline','utf8');
      if(argv.split('\0').some(a=>a.startsWith(root+'/')&&(a.endsWith('-wrapper.mjs')||a.endsWith('-parent.mjs')))){
        const confirm=await state(p.pid);if(!confirm.exists||confirm.birth!==p.birth)continue;
        process.kill(p.pgid===p.pid&&p.sessionId===p.pid?-p.pid:p.pid,'SIGKILL');
        await record({step:'fallback-owned-driver-cleanup',pid:p.pid,birth:p.birth});
      }
    }catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')cleanupErrors.push(String(e));}
  }
  try {if(root)await rm(root,{recursive:true,force:true});}catch(e){cleanupErrors.push(String(e));}
  try {await record({step:'fixture-cleanup',cleanupErrors});}catch(e){cleanupErrors.push(String(e));}
  if(cleanupErrors.length)throw new AggregateError([...(caughtFailure?[caughtFailure]:[]),...cleanupErrors.map(e=>Error(e))],'Cleanup incomplete');
}
