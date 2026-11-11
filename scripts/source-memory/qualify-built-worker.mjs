// One bounded operator invocation on the FINAL emitted artifact. No build,
// install, network, model/provider, existing repository or existing ledger I/O.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
assert.notEqual(process.getuid?.(), 0, 'Operator fixture must run nonroot');
const service = process.env.SOURCE_MEMORY_BUILT_SERVICE, reader = process.env.SOURCE_MEMORY_READER_FIXTURE;
assert.ok(service && path.isAbsolute(service) && service.endsWith('.js'), 'SOURCE_MEMORY_BUILT_SERVICE must name actual emitted JS');
assert.ok(reader && path.isAbsolute(reader), 'Verified code-only reader fixture required');
const root = await mkdtemp(path.join(tmpdir(), 'source-built-worker-'));
const cleanEnv = { PATH: process.env.PATH, HOME: '/nonexistent', LANG: 'C.UTF-8', NODE_OPTIONS: '', NODE_PATH: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
// Optional NEW operator-owned JSONL survives a later failed assertion. It
// contains only fixture PIDs/timestamps/artifact scope, never source or env.
const caseEvidence = process.env.SOURCE_MEMORY_WORKER_CASE_EVIDENCE;
if (caseEvidence) { assert.ok(path.isAbsolute(caseEvidence)); await writeFile(caseEvidence, '', { flag: 'wx', mode: 0o600 }); }
async function recordCase(value) {
  if (caseEvidence) await appendFile(caseEvidence, JSON.stringify({ at: new Date().toISOString(), ...value })+'\n');
}
const started = performance.now(); let driver, workerPid, killedParent = false, workerConfirmedStopped = false;
try {
  const repo = path.join(root, 'repo'); await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env: cleanEnv, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'candidate'); git('remote', 'add', 'origin', 'https://github.com/synthetic/built-worker');
  await writeFile(path.join(repo, 'example.ts'), 'export const evidence = "built worker";\n'); git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic');
  const revision = git('rev-parse', 'HEAD');
  const config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, state: path.join(root, 'new-state'), reader,
    manifest: path.join(path.dirname(reader), 'tooling-9c477cebfff7-manifest.json'), bindings: [{
      companyId: 'synthetic', projectId: 'synthetic', repositoryId: 'github.com/synthetic/built-worker', roots: [repo],
    }] }));
  const input = { companyId: 'synthetic', projectId: 'synthetic', issueId: 'synthetic-task', runId: 'synthetic-run',
    phase: 'implementation', provider: 'synthetic', model: 'never-paid', cwd: repo, repoUrl: 'https://github.com/synthetic/built-worker', remoteAuthority: false };
  const fixture = path.join(root, 'fixture.mjs');
  await writeFile(fixture, `import assert from 'node:assert/strict';
const {prepareSourceMemory}=await import(${JSON.stringify(pathToFileURL(service).href)});
const input=${JSON.stringify(input)},config=${JSON.stringify(config)};
const first=await prepareSourceMemory(input,'phase',config);
assert.equal(first.revision,${JSON.stringify(revision)});assert.ok(first.citations.length>0&&first.citations.length<=20);
const duplicate=await prepareSourceMemory(input,'commit',config);
assert.equal(duplicate.event,'duplicate');assert.equal(duplicate.blobReads,0);
process.stdout.write(JSON.stringify({revision:first.revision,citations:first.citations.length,duplicateBlobReads:duplicate.blobReads})+'\\n');
`);
  const proof = execFileSync(process.execPath, [fixture], { env: cleanEnv, encoding: 'utf8', timeout: 180_000, maxBuffer: 262_144 });
  const receipt = JSON.parse(proof.trim());
  await recordCase({ case: 'phase-and-duplicate', status: 'passed', ...receipt });
  const parent = path.join(root, 'parent.mjs');
  await writeFile(parent, `import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const original=childProcess.spawn;
childProcess.spawn=(command,args,options)=>{const child=original(command,args,options);if(args?.includes('--source-memory-worker'))child.once('spawn',()=>process.stdout.write(JSON.stringify({workerPid:child.pid})+'\\n'));return child};syncBuiltinESMExports();
const {prepareSourceMemory}=await import(${JSON.stringify(pathToFileURL(service).href)});
await prepareSourceMemory(${JSON.stringify(input)},'phase',${JSON.stringify(config)});
`);
  driver = spawn(process.execPath, [parent], { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; driver.stderr.on('data', b => { if (errors.length < 4096) errors += b; });
  const closed = once(driver, 'close');
  const pidReceipt = await Promise.race([
    new Promise((resolve, reject) => { let out=''; driver.stdout.on('data', b=>{out+=b;const line=out.split('\n')[0];if(out.includes('\n')){try{resolve(JSON.parse(line))}catch(e){reject(e)}}});driver.once('error',reject);closed.then(()=>reject(new Error('Parent exited before worker receipt: '+errors))); }),
    delay(15_000).then(() => { throw new Error('Worker spawn receipt deadline'); }),
  ]);
  workerPid = pidReceipt.workerPid; assert.ok(Number.isInteger(workerPid));
  await recordCase({ case: 'disconnect', status: 'worker-spawned', parentPid: driver.pid, workerPid });
  driver.kill('SIGKILL'); killedParent = true; await closed;
  await recordCase({ case: 'disconnect', status: 'parent-killed', parentPid: driver.pid, workerPid });
  async function stopped(pid) {
    try { process.kill(pid, 0); } catch (e) { if(e.code==='ESRCH') return true; throw e; }
    if(process.platform==='linux') { try { const value=await readFile('/proc/'+pid+'/stat','utf8');return /^\s*Z\b/.test(value.slice(value.lastIndexOf(')')+1)); } catch(e) {if(e.code==='ENOENT')return true;throw e;} }
    return false;
  }
  let workerStopped = false;
  for(let attempt=0;attempt<50;attempt++){if(await stopped(workerPid)){workerStopped=true;break}await delay(100)}
  workerConfirmedStopped = workerStopped;
  await recordCase({ case: 'disconnect', status: workerStopped ? 'passed' : 'failed', workerPid, workerStopped });
  assert.ok(workerStopped, 'Built worker must terminate after parent IPC disconnect');
  console.log(JSON.stringify({ schema: 'source-built-worker-qualification.v1', service,
    artifactSha256: createHash('sha256').update(await readFile(service)).digest('hex'), ...receipt,
    providerCalls: 0, killedParent, workerStopped, elapsedMs: Math.round(performance.now()-started) }));
} finally {
  if(driver?.exitCode===null&&!killedParent)driver.kill('SIGKILL');
  // Only this fixture's own recorded worker process can be stopped here.
  if(workerPid && !workerConfirmedStopped)try{process.kill(process.platform==='win32'?workerPid:-workerPid,'SIGKILL')}catch{}
  await rm(root, { recursive: true, force: true });
}
