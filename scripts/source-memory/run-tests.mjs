// Run the actual .mjs contracts on Node 24 without a third-party loader. Workers
// see emitted sibling JS just as in a server build; this is NOT semantic tsc.
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../../', import.meta.url));
const core = ['source-memory-retention','source-memory','source-memory-remote','source-citation-consumer','source-citation-reader','heartbeat/source-memory','heartbeat/source-memory-run-state'];
const fixtures = ['source-citation-authorization.ts','task-workspace-access.ts','authorization.ts','access.ts',
 'native-runtime/completion-validation.ts','native-runtime/canonical.ts','native-runtime/paperclip-control-plane-port.ts','trust-preset-resolver.ts','task-repository-acquisition.ts','execution-identity.ts',
 '../errors.ts','../lib/agent-permissions.ts','test-fixtures/source-citation-authorization.mjs'];
const tests = ['source-memory-binding','source-memory-current','source-citation-consumer','source-memory-lifetime-retention','source-memory-retention','heartbeat/source-memory-run-state'];
tests.push('source-memory','source-memory-events','source-memory-blob-integrity','heartbeat/source-memory-admission');
// Local focused checks may select changed suites; CI always executes the entire roster.
const selected = process.argv.slice(2);
if (selected.length && process.env.CI) throw new Error('CI must run all source-memory suites');
if (selected.some(name => !tests.includes(name))) throw new Error('Unknown source-memory suite');
if (selected.length) tests.splice(0, tests.length, ...selected);
const needsReader = tests.some(name => ['source-memory','source-memory-events','source-memory-blob-integrity','heartbeat/source-memory-admission'].includes(name));
if (needsReader && !process.env.SOURCE_MEMORY_READER_FIXTURE) {
 throw new Error('SOURCE_MEMORY_READER_FIXTURE is required: refusing to skip any of the 10 source-memory suites');
}
const scratch = await mkdtemp(path.join(tmpdir(), 'source-memory-tests-'));
const service = 'server/src/services/';
try {
 await writeFile(path.join(scratch,'package.json'),'{"type":"module"}');
 for (const file of [...core.map(f=>f+'.ts'),...fixtures,...tests.map(f=>f+'.test.mjs')]) {
  const to = path.join(scratch,service,file); await mkdir(path.dirname(to),{recursive:true});
  await cp(path.join(root,service,file),to);
  if (['source-memory.test.mjs','source-memory-blob-integrity.test.mjs'].includes(file)) {
    let testSource=await readFile(to,'utf8');
    for (const name of core) testSource=testSource.replaceAll('./'+name+'.ts','./'+name+'.js');
    await writeFile(to,testSource);
  }
  if (core.includes(file.slice(0,-3))) await writeFile(to.slice(0,-3)+'.js',stripTypeScriptTypes(await readFile(to,'utf8')));
 }
 const contract='packages/paperclip-runner/src/contracts/completion-result.ts';
 await mkdir(path.dirname(path.join(scratch,contract)),{recursive:true}); await cp(path.join(root,contract),path.join(scratch,contract));
 const result=spawnSync(process.execPath,['--experimental-vm-modules','--experimental-test-module-mocks','--test',...tests.map(f=>path.join(scratch,service,f+'.test.mjs'))],{stdio:'inherit',env:{...process.env,PAPERCLIP_SOURCE_MEMORY_CONFIG:'',SOURCE_MEMORY_HEARTBEAT_FIXTURE:path.join(scratch,service,'heartbeat/source-memory.js')}});
 process.exitCode=result.status ?? 1;
} finally {await rm(scratch,{recursive:true,force:true});}
