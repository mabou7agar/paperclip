// Source-controlled successor to the retained operator wrapper. New bootstrap
// argv mapping changes only index 3; eval source, IPC, environment and bounds stay.
// Operator-only packaging qualification. The original fixture owns fresh Git,
// SQLite and cancellation cases. This wrapper changes only its worker entry to
// the exact production bundle chunk; it does not change production sources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [fixtureArgument, chunkArgument, fixtureHash, chunkHash] = process.argv.slice(2);
assert.notEqual(process.getuid?.(), 0, 'Qualification must run nonroot');
assert.ok(path.isAbsolute(fixtureArgument ?? '') && path.isAbsolute(chunkArgument ?? ''));
assert.match(fixtureHash ?? '', /^[a-f0-9]{64}$/);
assert.match(chunkHash ?? '', /^[a-f0-9]{64}$/);
const fixture = await realpath(fixtureArgument);
const chunk = await realpath(chunkArgument);
assert.ok(chunk.endsWith('.mjs') && chunk !== fixture);
// Esbuild artifact names are literal paths. Reject template metacharacters
// rather than embedding an arbitrary caller path into a generated fixture.
assert.match(chunk, /^[A-Za-z0-9_./-]+$/);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = await readFile(fixture), chunkBytes = await readFile(chunk);
assert.equal(digest(fixtureBytes), fixtureHash, 'Frozen fixture hash changed');
assert.equal(digest(chunkBytes), chunkHash, 'Frozen bundle chunk hash changed');
assert.ok(chunkBytes.includes(Buffer.from('--source-memory-worker')));
const service = process.env.SOURCE_MEMORY_BUILT_SERVICE;
const reader = process.env.SOURCE_MEMORY_READER_FIXTURE;
assert.ok(path.isAbsolute(service ?? '') && path.isAbsolute(reader ?? ''));

let source = fixtureBytes.toString('utf8');
const importNeedle = 'const {prepareSourceMemory}=await import(';
assert.equal(source.split(importNeedle).length - 1, 2, 'Expected both frozen fixture parents');
// The normal parent uses fileURLToPath(import.meta.url) as its child entry. The
// bundled parent points at this chunk. Keep the real parent preparation,
// serialization, environment, IPC and child lifecycle; map that entry only.
const parentShim = `import bundledChildProcess from 'node:child_process';import {syncBuiltinESMExports as syncBundleSpawn} from 'node:module';
const bundleSpawn=bundledChildProcess.spawn;
bundledChildProcess.spawn=(command,args,options)=>{if(args?.includes('--source-memory-worker')){if(args.length!==6||args[0]!=='--input-type=module'||args[1]!=='--eval'||args[4]!=='--source-memory-worker'||args[5]!==String(process.pid))throw Error('Worker bootstrap argv changed');args=[...args];args[3]=${JSON.stringify(chunk)};}return bundleSpawn(command,args,options)};syncBundleSpawn();
`;
source = source.replace(importNeedle, parentShim + importNeedle);
const spawnNeedle = 'childProcess.spawn=(command,args,options)=>{const child=original(command,args,options);';
assert.equal(source.split(spawnNeedle).length - 1, 1, 'Expected frozen cancellation parent');
source = source.replace(spawnNeedle,
  `childProcess.spawn=(command,args,options)=>{if(args?.includes('--source-memory-worker')){if(args.length!==6||args[0]!=='--input-type=module'||args[1]!=='--eval'||args[4]!=='--source-memory-worker'||args[5]!==String(process.pid))throw Error('Worker bootstrap argv changed');args=[...args];args[3]=${JSON.stringify(chunk)};}const child=original(command,args,options);`);

const scratch = await mkdtemp(path.join(tmpdir(), 'source-bundle-qualification-'));
try {
  const driver = path.join(scratch, 'qualification.mjs');
  await writeFile(driver, source, { mode: 0o600 });
  // Save the exact derived fixture for the independent reviewer; it contains
  // code and artifact paths only. No provider environment or credentials.
  if (process.env.SOURCE_MEMORY_BUNDLED_DRIVER_EVIDENCE) {
    await writeFile(process.env.SOURCE_MEMORY_BUNDLED_DRIVER_EVIDENCE, source,
      { mode: 0o600, flag: 'wx' });
  }
  const output = execFileSync(process.execPath, [driver], {
    cwd: process.cwd(), timeout: 240_000, maxBuffer: 1_048_576,
    env: { PATH: process.env.PATH, HOME: '/nonexistent', LANG: 'C.UTF-8',
      NODE_OPTIONS: '', NODE_PATH: '', COREPACK_ENABLE_NETWORK: '0',
      SOURCE_MEMORY_BUILT_SERVICE: service, SOURCE_MEMORY_READER_FIXTURE: reader,
      ...(process.env.SOURCE_MEMORY_WORKER_CASE_EVIDENCE ? { SOURCE_MEMORY_WORKER_CASE_EVIDENCE: process.env.SOURCE_MEMORY_WORKER_CASE_EVIDENCE } : {}) },
    encoding: 'utf8',
  });
  const receipt = JSON.parse(output.trim());
  assert.equal(receipt.schema, 'source-built-worker-qualification.v1');
  assert.equal(receipt.duplicateBlobReads, 0);
  assert.equal(receipt.providerCalls, 0);
  assert.equal(receipt.killedParent, true);
  assert.equal(receipt.workerStopped, true);
  console.log(JSON.stringify({ schema: 'source-bundled-worker-qualification.v1',
    fixture, fixtureSha256: fixtureHash, derivedDriverSha256: digest(source),
    bundleWorkerEntry: chunk, bundleWorkerSha256: chunkHash,
    method: 'real emitted parent with worker entry mapped to the production bundle chunk',
    proof: receipt }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
