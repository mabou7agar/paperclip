import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
  }
  return next(specifier, context);
} });
const { prepareHeartbeatSourceMemory } = await import('./source-memory.ts');

test('source-memory opt-in preserves unbound completion and bound refusal', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-unbound-compat-'));
  const previous = process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
  const config = path.join(root, 'config.json');
  const binding = { companyId: 'company', projectId: 'project', repositoryId: 'github.com/example/repo', roots: [path.join(root, 'unread-source')] };
  const configure = bindings => writeFile(config, JSON.stringify({ version: 1,
    state: path.join(root, 'unopened-state'), reader: path.join(root, 'unopened-reader'),
    manifest: path.join(root, 'unopened-manifest'), bindings }));
  let authorizations = 0;
  const input = overrides => ({
    identity: { companyId: 'company', projectId: 'project', issueId: 'task', runId: 'run',
      phase: 'review', provider: 'operator', model: 'no-provider' },
    workspace: { cwd: path.join(root, 'unread-source'), repoUrl: 'https://github.com/example/repo' },
    persistedWorkspaceId: 'workspace', recovering: false, authority: null, remote: null,
    authorize: async () => { authorizations++; throw Error('No source authorization expected'); },
    recordRevision: async () => { throw Error('No snapshot expected'); },
    assertOwned: async () => { throw Error('No dispatch expected'); },
    readAuthority: async () => { throw Error('No authority lookup expected'); },
    ...overrides,
  });
  const completion = () => ({ exitCode: 0, resultJson: { message: 'Keep ordinary task result',
    sourceCitations: [{ mode: 'historical', repo: 'untrusted' }],
    sourceCitationResults: [{ status: 'accepted' }], sourceCurrentEvidenceSatisfied: true } });
  const assertDisabled = async value => {
    const gate = await prepareHeartbeatSourceMemory(value);
    assert.equal(gate.evidence, null);
    await gate.beforeDispatch(); await gate.observeCommit();
    const result = completion(); await gate.consumeResult(result);
    assert.deepEqual(result, { exitCode: 0, resultJson: { message: 'Keep ordinary task result' } });
    assert.equal(authorizations, 0);
  };
  try {
    await t.test('unset config discards volunteered evidence without changing the result', async () => {
      delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
      await assertDisabled(input());
    });
    process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = config;
    await t.test('empty binding list has the same completion behavior as disabled', async () => {
      await configure([]); await assertDisabled(input());
    });
    await t.test('other company and other project cannot enable enforcement here', async () => {
      for (const foreign of [{ ...binding, companyId: 'other' }, { ...binding, projectId: 'other' }]) {
        await configure([foreign]); await assertDisabled(input());
      }
    });
    await t.test('projectless recovering review remains outside project opt-in', async () => {
      await configure([binding]);
      const value = input({ recovering: true, persistedWorkspaceId: null });
      value.identity.projectId = null; await assertDisabled(value);
    });
    await t.test('bound project missing its persisted workspace still refuses evidence', async () => {
      await configure([binding]);
      const gate = await prepareHeartbeatSourceMemory(input({ persistedWorkspaceId: null }));
      const result = completion(); await gate.consumeResult(result);
      assert.equal(result.exitCode, 1); assert.equal(result.errorCode, 'source_citation_rejected');
      assert.equal(result.resultJson.sourceCitationResults[0].reason, 'source_memory_unbound');
    });
    await t.test('bound project repository mismatch still refuses evidence', async () => {
      const value = input(); value.workspace.repoUrl = 'https://github.com/example/other';
      const gate = await prepareHeartbeatSourceMemory(value);
      const result = completion(); await gate.consumeResult(result);
      assert.equal(result.exitCode, 1); assert.equal(result.errorCode, 'source_citation_rejected');
    });
    await t.test('bound recovered review still requires verified saved evidence', async () => {
      const gate = await prepareHeartbeatSourceMemory(input({ recovering: true }));
      const result = { exitCode: 0, resultJson: {} }; await gate.consumeResult(result);
      assert.equal(result.exitCode, 1);
      assert.equal(result.resultJson.sourceCitationResults[0].reason, 'recovery_snapshot_unverified');
    });
    assert.equal(authorizations, 0);
    assert.deepEqual(await readdir(root), ['config.json'], 'No source, reader, snapshot or ledger was opened');
  } finally {
    hooks.deregister();
    if (previous === undefined) delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
    else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});
