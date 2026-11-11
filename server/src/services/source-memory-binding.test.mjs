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
  await t.test('bound projects retain URL validation', async () => {
    await assert.rejects(prepareSourceMemory(input, 'phase', configFile), { code: 'ERR_INVALID_URL' });
  });
  await t.test('matching bound repository proceeds to its remote-authority guard', async () => {
    await assert.rejects(prepareSourceMemory({ ...input, repoUrl: 'https://github.com/example/synthetic.git' }, 'phase', configFile), /source_memory_remote_source_attestation_unavailable/);
    assert.equal(await prepareSourceMemory({ ...input, repoUrl: 'https://github.com/example/unbound' }, 'phase', configFile), null);
  });
});
