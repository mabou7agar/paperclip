// Owner-authorized correction regression only. Does not import or run the saved fixture suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { prepareSourceMemory } from './source-memory.ts';
import { createRemoteSourceReader } from './source-memory-remote.ts';

const reader = process.env.SOURCE_MEMORY_READER_FIXTURE;
assert.ok(reader, 'Use only the manifest-verified reader source, never an existing ledger');
assert.ok(process.getuid?.() !== 0, 'Regression must run nonroot');
const sha = value => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);

for (const remoteAuthority of [false, true]) {
  test(`${remoteAuthority ? 'remote' : 'local'}: forged blob cannot poison another task or frozen review`, async t => {
    const root = await mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || os.tmpdir(), 'blob-integrity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const attacker = path.join(root, 'attacker'), reviewer = path.join(root, 'reviewer');
    await mkdir(attacker);
    const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();
    git(attacker, 'init', '--quiet');
    git(attacker, 'remote', 'add', 'origin', 'https://github.com/synthetic/blob-integrity');
    await mkdir(path.join(attacker, 'src'));
    const good = Buffer.from('export const evidence = "authentic café 🧪";\n');
    await writeFile(path.join(attacker, 'src/Evidence.ts'), good);
    git(attacker, 'add', '.');
    git(attacker, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'synthetic frozen source');
    const revision = git(attacker, 'rev-parse', 'HEAD');
    const blob = git(attacker, 'rev-parse', 'HEAD:src/Evidence.ts');
    // Independent synthetic object stores: the frozen task retains the genuine object.
    await cp(attacker, reviewer, { recursive: true });
    const forged = Buffer.from('export const evidence = "injected false source";\n');
    const object = path.join(attacker, '.git/objects', blob.slice(0, 2), blob.slice(2));
    await chmod(object, 0o600);
    await writeFile(object, deflateSync(Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged])));
    // Establish that Git itself serves the forged bytes under the genuine id.
    assert.equal(git(attacker, 'cat-file', 'blob', blob), forged.toString().trim());
    const scope = { companyId: 'synthetic-company', projectId: 'synthetic-project', repositoryId: 'github.com/synthetic/blob-integrity' };
    const state = path.join(root, 'state'), configFile = path.join(root, 'config.json');
    await writeFile(configFile, JSON.stringify({ version: 1, state, reader,
      manifest: path.join(path.dirname(reader), 'tooling-9c477cebfff7-manifest.json'),
      bindings: [{ ...scope, roots: [root], remoteRoots: [root] }],
    }));
    const input = { ...scope, issueId: 'task-A', runId: 'run-A', phase: 'implementation', provider: 'synthetic', model: 'none',
      cwd: attacker, repoUrl: 'https://github.com/synthetic/blob-integrity', remoteAuthority, query: 'evidence' };
    const remote = cwd => remoteAuthority ? createRemoteSourceReader({ cwd, baseCwd: root, assertOwned: async () => {}, execute: async request => {
      try { return { exitCode: 0, ...await execute(request.command, request.args, { cwd: request.cwd,
        env: { PATH: process.env.PATH, ...request.env }, maxBuffer: 20_000_000 }) }; }
      catch { return { exitCode: 1, stdout: '', stderr: '' }; }
    } }) : undefined;
    await assert.rejects(prepareSourceMemory(input, 'phase', configFile, remote(attacker)), /source_memory_blob_digest_mismatch/);
    // Inspect only this regression's newly created synthetic databases.
    const scopeState = path.join(state, 'runtime-v1', sha(JSON.stringify(scope)));
    const cachePath = path.join(scopeState, 'reader/knowledge-v3.sqlite');
    const cache = new DatabaseSync(cachePath, { readOnly: true });
    assert.equal(cache.prepare('SELECT count(*) AS n FROM blob_cache').get().n, 0);
    cache.close();
    const ledger = new DatabaseSync(path.join(scopeState, 'runtime.sqlite'), { readOnly: true });
    for (const table of ['events', 'refs', 'facts', 'observations']) assert.equal(ledger.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    ledger.close();
    // A different task in the exact same cache scope must obtain only genuine frozen source.
    const reviewInput = { ...input, cwd: reviewer, issueId: 'task-B', runId: 'run-B', phase: 'review' };
    const evidence = await prepareSourceMemory(reviewInput, 'phase', configFile, remote(reviewer));
    assert.equal(evidence.revision, revision);
    assert.equal(evidence.blobReads, 1);
    assert.ok(evidence.citations.length > 0);
    for (const hit of evidence.citations) {
      assert.equal(hit.citation.sha256, sha(good));
      assert.ok(hit.content.includes('authentic café 🧪'));
      assert.ok(!hit.content.includes('injected'));
    }
    // Cross-task reuse remains safe after verified raw bytes are cached.
    const frozen = await prepareSourceMemory({ ...reviewInput, issueId: 'task-C', runId: 'run-C' }, 'phase', configFile, remote(reviewer));
    assert.equal(frozen.blobReads, 0);
    assert.deepEqual(frozen.citations, evidence.citations);
    const verifiedCache = new DatabaseSync(cachePath, { readOnly: true });
    const rows = verifiedCache.prepare('SELECT blob,payload FROM blob_cache').all();
    assert.equal(rows.length, 1); assert.equal(rows[0].blob, blob);
    assert.equal(JSON.parse(rows[0].payload).content, good.toString());
    verifiedCache.close();
    assert.equal(git(reviewer, 'rev-parse', 'HEAD'), revision);
    assert.deepEqual(await readFile(path.join(reviewer, 'src/Evidence.ts')), good);
  });
}
