import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestHarness } from '../../../../packages/plugins/sdk/dist/testing.js';
import { pluginManifestV1Schema } from '../../../../packages/shared/dist/index.js';
import { createRunnerPlugin } from '../dist/plugin/worker.mjs';
import manifest from '../plugin/manifest.mjs';

test('built worker registers real SDK tools/jobs and persists a measured webhook result before native wake', async () => {
  assert.equal(pluginManifestV1Schema.safeParse(manifest).success, true);
  const harness = createTestHarness({ manifest });
  harness.setConfig({ profiles: ['example'] });
  const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), taskId = randomUUID(), runId = randomUUID(), jobId = randomUUID();
  harness.seed({ issues: [{ id: taskId, companyId, projectId, assigneeAgentId: agentId, checkoutRunId: runId,
    status: 'in_progress', title: 'Original task', description: 'Original accepted plan and candidate' }] });
  const outcome = { jobId, companyId, projectId, issueId: taskId, agentId, profile: 'example', status: 'failed',
    receiptSha256: 'a'.repeat(64), fingerprint: 'b'.repeat(64), newEvidence: true,
    result: { status: 'failed', code: 'fixture_contract_failed', cleanupComplete: true } };
  const requests = [];
  const broker = { call: async (operation, value) => {
    requests.push({ operation, value });
    if (operation === 'submit') return { jobId, state: 'queued' };
    if (operation === 'result') return outcome;
    if (operation === 'pending_deliveries') return { jobs: [jobId] };
    if (operation === 'acknowledge') return { acknowledged: true };
    throw new Error('Unexpected broker operation');
  } };
  const plugin = createRunnerPlugin(broker);
  await plugin.definition.setup(harness.ctx);
  const result = await harness.executeTool('submit-runner-job', { taskId, profile: 'example', kind: 'control_checks',
    attachmentId: randomUUID(), packetSha256: 'c'.repeat(64), scopeIssueId: null, scopeCommentId: null, ackCommentId: null,
    recipe: 'changed-input-new.py' }, { companyId, projectId, agentId, runId });
  assert.equal(result.data.jobId, jobId);
  assert.equal(JSON.parse(result.content).jobId, jobId);
  await plugin.definition.onWebhook({ endpointKey: 'terminal', rawBody: JSON.stringify({ jobId }) });
  assert.equal(requests.at(-1).operation, 'acknowledge');
  const document = await harness.ctx.issues.documents.get(taskId, `runner-${jobId}-${'a'.repeat(12)}`, companyId);
  assert.match(document.body, /fixture_contract_failed/);
  assert.equal((await harness.ctx.issues.get(taskId, companyId)).description, 'Original accepted plan and candidate');
  assert.equal((await plugin.definition.onHealth()).status, 'ok');
});
