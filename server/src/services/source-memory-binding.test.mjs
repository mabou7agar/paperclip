import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareSourceMemory } from './source-memory.ts';

test('configured source memory filters company/project bindings before parsing URLs', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'source-memory-binding-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const configFile = path.join(base, 'config.json');
  await writeFile(configFile, JSON.stringify({ version: 1, state: base, reader: base, manifest: path.join(base, 'unused-manifest'),
    bindings: [{ companyId: 'bound-company', projectId: 'bound-project', repositoryId: 'github.com/example/synthetic', roots: [base] }] }));
  const input = { companyId: 'bound-company', projectId: 'bound-project', repoUrl: 'not a URL', cwd: base,
    issueId: 'synthetic-task', runId: 'synthetic-run', phase: 'implementation', provider: 'synthetic', model: 'fixture', remoteAuthority: true };
  await t.test('unbound project in the bound company ignores a malformed URL', async () => {
    assert.equal(await prepareSourceMemory({ ...input, projectId: 'unbound-project' }, 'phase', configFile), null);
  });
  await t.test('another company cannot inherit a project binding or parse its malformed URL', async () => {
    assert.equal(await prepareSourceMemory({ ...input, companyId: 'other-company' }, 'phase', configFile), null);
  });
  await t.test('unsupported repository URLs remain unbound', async () => {
    assert.equal(await prepareSourceMemory(input, 'phase', configFile), null);
  });
  await t.test('matching bound repository proceeds to its remote-authority guard', async () => {
    await assert.rejects(prepareSourceMemory({ ...input, repoUrl: 'https://github.com/example/synthetic.git' }, 'phase', configFile), /source_memory_remote_source_attestation_unavailable/);
    assert.equal(await prepareSourceMemory({ ...input, repoUrl: 'https://github.com/example/unbound' }, 'phase', configFile), null);
  });
});

// Real authorization service, with synthetic persistence only. A premature call
// fails for each unrelated scope; it is not replaced with an allow/deny mock.
test('heartbeat filters opt-in before real task authorization', async t => {
  const { prepareHeartbeatSourceMemory } = await import('./heartbeat/source-memory.ts');
  const { authorizeSourceCitation, syntheticAuthorizationStore } = await import('./test-fixtures/source-citation-authorization.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'heartbeat-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, state: root, reader: root, manifest: path.join(root, 'unused'),
    bindings: [{ companyId: 'company', projectId: 'project', repositoryId: 'github.com/example/permitted', roots: [root] }] }));
  const previous = process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
  const privacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = config;
  process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = 'off';
  try {
    const rows = {
      agents: [{ id: 'agent', companyId: 'company', permissions: null }],
      heartbeatRuns: [{ id: 'run', companyId: 'company', agentId: 'agent', issueId: 'task', responsibleUserId: null, status: 'running', contextSnapshot: {} }],
      issues: [{ id: 'task', companyId: 'company', projectId: 'project', executionWorkspaceId: 'workspace', projectWorkspaceId: 'source', workspaceSelection: null, workspacePendingSelection: null, workspaceBindingRevision: 0, executionPolicy: null }],
      projects: [{ id: 'project', companyId: 'company', executionWorkspacePolicy: null }],
      executionWorkspaces: [{ id: 'workspace', companyId: 'company', projectId: 'project', projectWorkspaceId: 'source', repoUrl: 'https://github.com/example/permitted' }],
      projectWorkspaces: [{ id: 'source', companyId: 'company', projectId: 'project', repoUrl: 'https://github.com/example/permitted' }],
    };
    const { db, reads } = syntheticAuthorizationStore(rows);
    const actor = { type: 'agent', source: 'agent_jwt', agentId: 'agent', runId: 'run', companyId: 'company', onBehalfOfUserId: null };
    const input = {
      identity: { companyId: 'company', projectId: 'project', issueId: 'task', runId: 'run', phase: 'implementation', provider: 'openai', model: 'synthetic' },
      workspace: { cwd: root, repoUrl: 'https://github.com/example/permitted' }, persistedWorkspaceId: 'workspace', recovering: false,
      authority: { epoch: 1, writerRunId: 'run' }, remote: null,
      assertOwned: async () => {}, readAuthority: async () => null,
      recordRevision: async () => { throw Error('no reader may run in this filter test'); },
      authorize: admission => authorizeSourceCitation(db, actor, { companyId: 'company', issueId: 'task', workspaceId: 'workspace', admission }),
    };
    for (const [name, change] of [
      ['unbound project in another company', { identity: { ...input.identity, companyId: 'other', projectId: 'other' }, workspace: { cwd: root, repoUrl: 'malformed URL' } }],
      ['nonrepository directory workspace', { workspace: { cwd: root, repoUrl: null } }],
      ['workspace has no persisted record', { persistedWorkspaceId: null }],
    ]) await t.test(name, async () => {
      const before = reads.length;
      const result = await prepareHeartbeatSourceMemory({ ...input, ...change });
      assert.equal(result.evidence, null);
      await result.beforeDispatch(); await result.observeCommit();
      const completion = { exitCode: 0, resultJson: {} };
      await result.consumeResult(completion);
      assert.equal(completion.exitCode, 0);
      assert.equal(reads.length, before, 'real authorization must not be entered');
    });
    await t.test('bound scope retains real authorization before the remote reader guard', async () => {
      await assert.rejects(prepareHeartbeatSourceMemory(input), /source_memory_remote_source_attestation_unavailable/);
      assert.ok(reads.includes('issues') && reads.includes('agents') && reads.includes('projectWorkspaces'));
      rows.agents.length = 0;
      await assert.rejects(prepareHeartbeatSourceMemory(input), error => !/remote_source_attestation_unavailable/.test(error.message));
    });
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG; else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = previous;
    if (privacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE; else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = privacy;
  }
});


test('unconfigured heartbeat strips volunteered citations and succeeds without authority or IO', async () => {
  const { prepareHeartbeatSourceMemory } = await import('./heartbeat/source-memory.ts');
  const saved = process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
  delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
  const forbidden = async () => { throw Error('disabled feature must perform no IO'); };
  try {
    const prepared = await prepareHeartbeatSourceMemory({
      identity: { companyId: 'company', projectId: 'project', issueId: 'task', runId: 'run', phase: 'review' },
      workspace: { cwd: '/unused', repoUrl: 'invalid' }, persistedWorkspaceId: 'workspace',
      recovering: false, authority: null, remote: null, authorize: forbidden, recordRevision: forbidden,
      assertOwned: forbidden, readAuthority: forbidden,
    });
    await prepared.beforeDispatch(); await prepared.observeCommit();
    const completion = { exitCode: 0, resultJson: { answer: 'finished', sourceCitations: [{ mode: 'current' }],
      sourceCurrentEvidenceSatisfied: true, sourceCitationResults: ['untrusted'] } };
    await prepared.consumeResult(completion);
    assert.equal(completion.exitCode, 0); assert.equal(completion.errorCode, undefined);
    assert.deepEqual(completion.resultJson, { answer: 'finished' });
  } finally {
    if (saved === undefined) delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG; else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = saved;
  }
});

test('unrelated companies ignore invalid configured paths and bindings', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-config-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({ version: 9, state: null, bindings: [
    { companyId: 'bound', projectId: 'project', roots: null }, null,
  ] }));
  const input = { companyId: 'other', projectId: 'project', repoUrl: 'https://github.com/example/repo' };
  assert.equal(await prepareSourceMemory(input, 'phase', file), null);
  await assert.rejects(prepareSourceMemory({ ...input, companyId: 'bound' }, 'phase', file), /configuration_invalid/);
});


test('non-object configuration envelopes have a named fail-closed error', async t => {
  const { sourceMemoryBindingEnabled, sourceMemoryProjectBindingEnabled } = await import('./source-memory.ts');
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-config-envelope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  const input = { companyId: 'company', projectId: 'project', repoUrl: 'https://github.com/example/repo', cwd: '/unused' };
  for (const value of [null, [], 'text', 0, false]) {
    await writeFile(file, JSON.stringify(value));
    for (const operation of [() => prepareSourceMemory(input, 'phase', file),
      () => sourceMemoryBindingEnabled(input, file), () => sourceMemoryProjectBindingEnabled(input, file)]) {
      await assert.rejects(operation(), { message: 'source_memory_configuration_invalid' });
    }
  }
});
