import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRemoteSourceReader } from './source-memory-remote.ts';
import { prepareSourceMemory, assertCurrentSourceCitation, affectedSourceFiles, attachSourceMemoryContext } from './source-memory.ts';

const base = await mkdtemp(path.join(os.tmpdir(), 'source-memory-fixture-'));
const repo = path.join(base, 'repo'); await mkdir(repo);
const isolatedGit = (args, options = {}) => execFileSync('git', args, { ...options, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...options.env } });
const git = (...args) => isolatedGit(['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
git('init', '--quiet'); git('remote', 'add', 'origin', 'https://github.com/example/synthetic'); git('config', 'user.name', 'Synthetic Fixture'); git('config', 'user.email', 'fixture@example.invalid');
const commit = () => { git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'synthetic source'); return git('rev-parse', 'HEAD'); };
await mkdir(path.join(repo, 'src')); await mkdir(path.join(repo, 'tests'));
await writeFile(path.join(repo, 'src/Contract.ts'), 'export interface Contract { id: number }\n');
await writeFile(path.join(repo, 'src/Caller.ts'), 'import type { Contract } from "./Contract";\nexport function call(c: Contract) { return c.id; }\n');
await writeFile(path.join(repo, 'tests/Contract.test.ts'), 'export const ContractFixture = 1;\n');
const first = commit();
const reader = process.env.SOURCE_MEMORY_READER_FIXTURE;
assert.ok(reader, 'Set SOURCE_MEMORY_READER_FIXTURE to the manifest-verified accepted reader bundle; never a production ledger');
const scope = { companyId: 'synthetic-company', projectId: 'synthetic-project', repositoryId: 'github.com/example/synthetic' };
const configFile = path.join(base, 'config.json');
const config = { version: 1, state: path.join(base, 'state'), reader, manifest: path.join(path.dirname(reader), 'tooling-9c477cebfff7-manifest.json'), bindings: [{ ...scope, roots: [repo] }] };
await writeFile(configFile, JSON.stringify(config));
const input = { ...scope, issueId: 'synthetic-task', runId: 'synthetic-run', phase: 'implementation', provider: 'synthetic-provider', model: 'fixture', cwd: repo, repoUrl: 'https://github.com/example/synthetic', remoteAuthority: false };
let initial, current;
after(async () => { await rm(base, { recursive: true, force: true }); });

test('isolated runtime source-memory contract', async t => {
  await t.test('unconfigured service performs no repository work', async () => {
    assert.equal(await prepareSourceMemory({ ...input, cwd: '/does-not-exist' }, 'phase', ''), null);
  });
  await t.test('changed commit yields bounded, verified committed-source citations', async () => {
    initial = await prepareSourceMemory(input, 'phase', configFile);
    assert.equal(initial.revision, first); assert.equal(initial.event, 'changed');
    assert.ok(initial.citations.length > 0 && initial.citations.length <= 20);
    for (const hit of initial.citations) { assertCurrentSourceCitation(initial, hit.citation); assert.ok(hit.content.length <= 4000); }
  });
  await t.test('duplicate event after worker restart reads zero blobs', async () => {
    const repeated = await prepareSourceMemory(input, 'commit', configFile);
    assert.equal(repeated.event, 'duplicate'); assert.equal(repeated.blobReads, 0); assert.deepEqual(repeated.citations, []);
    assert.equal(git('rev-parse', 'HEAD'), first);
  });
  await t.test('concurrent duplicate events coalesce durably across workers', async () => {
    const results = await Promise.all([1, 2].map(i => prepareSourceMemory({ ...input, runId: `concurrent-${i}` }, 'commit', configFile)));
    assert.ok(results.every(r => r.event === 'duplicate' && r.blobReads === 0));
  });
  await t.test('native and legacy prompt variants receive evidence without rewriting completion provenance', () => {
    const revision = { version: 1, assignment: { owner: 'task_markdown', description: { id: 'task', revision: 'unchanged' } } };
    const context = { paperclipTaskMarkdown: 'full', paperclipTaskMarkdownCompact: 'compact', paperclipTaskMarkdownAssignment: 'assignment', paperclipTaskMarkdownAssignmentCompact: 'small', paperclipTurnContext: revision };
    attachSourceMemoryContext(context, initial);
    for (const key of ['paperclipTaskMarkdown', 'paperclipTaskMarkdownCompact', 'paperclipTaskMarkdownAssignment', 'paperclipTaskMarkdownAssignmentCompact']) assert.match(context[key], /Maintained source evidence/);
    assert.equal(context.paperclipTurnContext, revision);
    attachSourceMemoryContext(context, null); assert.equal(context.paperclipSourceMemoryMarkdown, undefined);
  });
  await t.test('renames and deletes publish one new snapshot; old citations are stale', async () => {
    await rename(path.join(repo, 'src/Contract.ts'), path.join(repo, 'src/NewContract.ts'));
    await rm(path.join(repo, 'src/Caller.ts'));
    const revision = commit();
    current = await prepareSourceMemory(input, 'phase', configFile);
    assert.equal(current.revision, revision); assert.equal(current.event, 'changed');
    assert.ok(current.citations.every(h => !['src/Contract.ts', 'src/Caller.ts'].includes(h.citation.path)));
    assert.throws(() => assertCurrentSourceCitation(current, initial.citations[0].citation), /stale_citation/);
    await assert.rejects(prepareSourceMemory(input, 'verify', configFile, undefined, initial), /stale_before_dispatch/);
  });
  await t.test('planning, implementation and review independently verify same candidate', async () => {
    for (const phase of ['planning', 'implementation', 'review']) {
      const evidence = await prepareSourceMemory({ ...input, phase, runId: phase }, 'phase', configFile);
      assert.equal(evidence.phase, phase); assert.equal(evidence.revision, current.revision); assert.equal(evidence.event, 'duplicate');
    }
  });
  await t.test('dirty work stays separate and does not switch branches or rewrite files', async () => {
    await writeFile(path.join(repo, 'src/NewContract.ts'), 'export interface Contract { changed: true }\n');
    await writeFile(path.join(repo, 'untracked.ts'), 'export const separate = true;\n');
    const evidence = await prepareSourceMemory(input, 'phase', configFile);
    assert.ok(evidence.dirty.trackedBytes > 0); assert.equal(evidence.dirty.untrackedPaths, 1);
    assert.equal(evidence.revision, current.revision);
    assert.match(await readFile(path.join(repo, 'src/NewContract.ts'), 'utf8'), /changed: true/);
  });
  await t.test('scope, root and remote-authority boundaries refuse unapproved reads', async () => {
    assert.equal(await prepareSourceMemory({ ...input, companyId: 'other' }, 'phase', configFile), null);
    await assert.rejects(prepareSourceMemory({ ...input, cwd: base }, 'phase', configFile), /root_denied/);
    await assert.rejects(prepareSourceMemory({ ...input, remoteAuthority: true, cwd: '/does-not-exist' }, 'phase', configFile), /remote_source_attestation_unavailable/);
    await assert.rejects(prepareSourceMemory({ ...input, provider: null }, 'phase', configFile), /execution_identity_missing/);
    git('remote', 'set-url', 'origin', 'https://github.com/example/wrong');
    await assert.rejects(prepareSourceMemory(input, 'phase', configFile), /repository_mismatch/);
    git('remote', 'set-url', 'origin', 'https://github.com/example/synthetic');
  });
  await t.test('remote Git-only transport enforces confinement and preserves dirty work separately', async () => {
    let checks = 0, owned = true;
    const execute = async request => {
      try { const result = await promisify(execFile)(request.command, request.args, { cwd: request.cwd, env: { PATH: process.env.PATH, ...request.env }, maxBuffer: 20_000_000 }); return { exitCode: 0, ...result }; }
      catch { return { exitCode: 1, stdout: '', stderr: '' }; }
    };
    const guardFolder = path.join(reader, 'reference/paperclip-execution-isolation/src');
    const guards = { safe: await readFile(path.join(guardFolder, 'SafeGitRepository.mjs'), 'utf8'), storage: await readFile(path.join(guardFolder, 'GitStorageRepository.mjs'), 'utf8') };
    const rawRead = createRemoteSourceReader({ cwd: repo, baseCwd: base, execute, assertOwned: async () => { checks++; assert.ok(owned); } });
    const read = request => rawRead({ ...request, guards: request.guards ?? guards });
    const remoteConfigFile = path.join(base, 'remote.json');
    await writeFile(remoteConfigFile, JSON.stringify({ ...config, state: path.join(base, 'remote-state'), bindings: [{ ...scope, roots: [], remoteRoots: [repo] }] }));
    const evidence = await prepareSourceMemory({ ...input, remoteAuthority: true }, 'phase', remoteConfigFile, read);
    assert.equal(evidence.revision, current.revision); assert.equal(evidence.event, 'changed'); assert.ok(evidence.blobReads > 0);
    assert.ok(evidence.dirty.trackedBytes > 0); assert.ok(checks >= 2);
    assert.ok(evidence.citations.every(h => !h.content.includes('changed: true')));
    const duplicate = await prepareSourceMemory({ ...input, remoteAuthority: true }, 'commit', remoteConfigFile, read);
    assert.equal(duplicate.blobReads, 0); assert.equal(duplicate.event, 'duplicate');
    await assert.rejects(read({ args: ['show', 'HEAD:src/NewContract.ts'], maxBytes: 1000 }), /remote_read_refused/);
    const outside = createRemoteSourceReader({ cwd: base, baseCwd: repo, execute, assertOwned: async () => {} });
    await assert.rejects(outside({ args: ['rev-parse', 'HEAD'], maxBytes: 1000, guards }), /remote_read_refused/);
    const linked = path.join(base, 'foreign-metadata'); await mkdir(linked);
    await writeFile(path.join(linked, '.git'), `gitdir: ${path.join(repo, '.git')}\n`);
    const foreign = createRemoteSourceReader({ cwd: linked, baseCwd: linked, execute, assertOwned: async () => {} });
    await assert.rejects(foreign({ args: ['rev-parse', 'HEAD'], maxBytes: 1000, guards }), /remote_read_refused/);
    let changed = false;
    const raceRead = async request => {
      const value = await read(request);
      if (!changed && request.args[0] === 'cat-file' && request.args[1] === '--batch') {
        changed = true; await writeFile(path.join(repo, 'src/Race.ts'), 'export const race = true;\n'); commit();
      }
      return value;
    };
    const raceConfig = path.join(base, 'race.json');
    await writeFile(raceConfig, JSON.stringify({ ...config, state: path.join(base, 'race-state'), bindings: [{ ...scope, roots: [], remoteRoots: [repo] }] }));
    await assert.rejects(prepareSourceMemory({ ...input, remoteAuthority: true }, 'phase', raceConfig, raceRead), /stale_source|source_changed_during_preparation/);
    const recovered = await prepareSourceMemory({ ...input, remoteAuthority: true }, 'phase', raceConfig, read);
    assert.equal(recovered.event, 'changed'); assert.equal(recovered.revision, git('rev-parse', 'HEAD'));
    owned = false;
    await assert.rejects(prepareSourceMemory({ ...input, remoteAuthority: true }, 'phase', remoteConfigFile, read), /remote_read_refused/);
  });
  await t.test('a frozen review checkout remains independent from a changing task branch', async () => {
    const frozen = path.join(base, 'frozen');
    isolatedGit(['clone', '--quiet', '--no-hardlinks', '--local', repo, frozen]);
    isolatedGit(['-C', frozen, 'remote', 'set-url', 'origin', input.repoUrl]);
    isolatedGit(['-C', frozen, '-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', first]);
    const frozenConfig = path.join(base, 'frozen.json');
    await writeFile(frozenConfig, JSON.stringify({ ...config, bindings: [{ ...scope, roots: [repo, frozen] }] }));
    const live = git('rev-parse', 'HEAD');
    const review = await prepareSourceMemory({ ...input, cwd: frozen, phase: 'review', issueId: 'frozen-review' }, 'phase', frozenConfig);
    assert.equal(review.revision, first); assert.equal(git('rev-parse', 'HEAD'), live);
    assertCurrentSourceCitation(review, review.citations[0].citation);
  });
  await t.test('unrelated detached task candidates do not share a ref cursor', async () => {
    const roots = [];
    for (const name of ['alpha', 'beta']) {
      const target = path.join(base, name); roots.push(target);
      isolatedGit(['clone', '--quiet', '--no-hardlinks', '--local', repo, target]);
      isolatedGit(['-C', target, 'remote', 'set-url', 'origin', input.repoUrl]);
      isolatedGit(['-C', target, 'checkout', '--quiet', '--detach', first]);
      await writeFile(path.join(target, `${name}.ts`), `export const ${name} = true;\n`);
      isolatedGit(['-C', target, 'add', '.']);
      isolatedGit(['-C', target, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', name]);
    }
    const file = path.join(base, 'detached.json');
    await writeFile(file, JSON.stringify({ ...config, bindings: [{ ...scope, roots }] }));
    const a = await prepareSourceMemory({ ...input, cwd: roots[0], issueId: 'alpha', phase: 'review', query: 'alpha' }, 'phase', file);
    const b = await prepareSourceMemory({ ...input, cwd: roots[1], issueId: 'beta', phase: 'review', query: 'beta' }, 'phase', file);
    assert.notEqual(a.taskRef, b.taskRef); assert.notEqual(a.revision, b.revision);
    assert.ok(a.citations.some(h => h.citation.path === 'alpha.ts')); assert.ok(b.citations.some(h => h.citation.path === 'beta.ts'));
  });
  await t.test('heartbeat preparation is inert when disabled or recovering and checks remote epoch before transport', async () => {
    assert.ok(process.env.SOURCE_MEMORY_HEARTBEAT_FIXTURE, 'Compile the three new service files and set SOURCE_MEMORY_HEARTBEAT_FIXTURE');
    const { prepareHeartbeatSourceMemory } = await import(process.env.SOURCE_MEMORY_HEARTBEAT_FIXTURE);
    const saved = process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
    const authority = { epoch: 1, writerRunId: input.runId, location: { remoteCwd: repo, leaseId: 'lease', providerLeaseId: 'allocation' } };
    const parameters = { recordRevision: async () => {}, authorize: async () => ({ ...scope, frozenSha: git("rev-parse", "HEAD") }), identity: input, workspace: { cwd: repo, repoUrl: input.repoUrl }, persistedWorkspaceId: "workspace", recovering: false, authority,
      remote: { baseCwd: base, execute: async () => { throw Error('transport must not run'); } },
      assertOwned: async () => {}, readAuthority: async () => ({ ...authority, epoch: 2 }) };
    try {
      delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
      const disabled = await prepareHeartbeatSourceMemory(parameters); assert.equal(disabled.evidence, null); await disabled.observeCommit();
      process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = configFile;
      assert.equal((await prepareHeartbeatSourceMemory({ ...parameters, recovering: true })).evidence, null);
      const enabled = await prepareHeartbeatSourceMemory({ ...parameters, authority: null, remote: null });
      assert.equal(enabled.evidence.revision, git('rev-parse', 'HEAD')); await enabled.beforeDispatch(); await enabled.observeCommit();
      const remoteConfig = path.join(base, 'heartbeat-remote.json');
      await writeFile(remoteConfig, JSON.stringify({ ...config, bindings: [{ ...scope, roots: [], remoteRoots: [repo] }] }));
      process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = remoteConfig;
      await assert.rejects(prepareHeartbeatSourceMemory(parameters), /remote_read_refused/);
    } finally { if (saved === undefined) delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG; else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = saved; }
  });
  await t.test('repository clean filters never execute and include-based config is refused', async () => {
    const marker = path.join(base, 'executed');
    const malicious = `node -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe")'`;
    git('config', 'filter.attack.clean', malicious); git('config', 'filter.attack.required', 'true');
    await writeFile(path.join(repo, '.gitattributes'), '*.ts filter=attack\n');
    await writeFile(path.join(repo, 'src/NewContract.ts'), 'export interface Contract { dirty: true }\n');
    await prepareSourceMemory(input, 'phase', configFile);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    git('config', 'include.path', path.join(base, 'extra-config'));
    await assert.rejects(prepareSourceMemory(input, 'phase', configFile), /worker_failed/);
    git('config', '--unset', 'include.path');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  });
  await t.test('affected callers, contracts and tests retain lexical/inferred standing', () => {
    const queue = affectedSourceFiles([
      { path: 'module/Contract.ts', content: 'export interface Contract {}', hash: 'a' },
      { path: 'caller/Use.ts', content: 'import { Contract } from "../module/Contract"', hash: 'b' },
      { path: 'tests/Contract.test.ts', content: 'Contract', hash: 'c' },
      { path: 'unrelated/Other.ts', content: 'unrelated', hash: 'd' },
    ], ['module/Contract.ts']);
    assert.equal(queue.length, 3); assert.equal(queue[0].relation, 'changed_source');
    assert.equal(queue.find(q => q.role === 'possible_caller').relation, 'lexical_reference');
    assert.equal(queue.find(q => q.role === 'test').relation, 'lexical_reference');
  });
});
