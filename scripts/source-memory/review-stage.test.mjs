// Executes the real handoff module with synthetic persistence and parsed policy
// states. No DB, checkout, reader, capture, or provider runs are allowed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
const unexpected = () => { throw Error('must not recapture reviewer-time HEAD'); };
const exportsByModule = {
  'node:crypto': { createHash },
  '@paperclipai/db': { executionWorkspaces: {}, heartbeatRuns: {}, issues: {} },
  'drizzle-orm': { and: () => null, eq: () => null },
  './source-memory.js': { sourceMemoryRepositoryId: () => 'github.com/example/repo', sourceMemoryBindingEnabled: async () => true, sourceMemoryProjectBindingEnabled: async () => true },
  './issue-execution-policy.js': { parseIssueExecutionState: value => value, normalizeIssueExecutionPolicy: value => value, applyIssueExecutionPolicyTransition: unexpected },
  './workspace-source-inspection.js': { captureWorkspaceReviewCandidate: unexpected, sourceReviewCaptureHold: reason => { throw Error(reason); } },
};
const module = new SourceTextModule(stripTypeScriptTypes(await readFile(new URL('../../server/src/services/source-review-handoff.ts', import.meta.url), 'utf8')));
await module.link(specifier => {
  const values = exportsByModule[specifier]; assert.ok(values, specifier);
  return new SyntheticModule(Object.keys(values), function () { for (const [key,value] of Object.entries(values)) this.setExport(key,value); });
});
await module.evaluate();
const { prepareSourceReviewHandoff } = module.namespace;
test('two review stages preserve original writer SHA and receipt without recapture', async t => {
  const saved = process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
  process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = '/unused/synthetic';
  t.after(() => { if (saved === undefined) delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG; else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = saved; });
  const receipt = { schema: 1, companyId: 'company', issueId: 'task', workspaceId: 'workspace', projectId: 'project',
    bindingRevision: 1, repositoryId: 'github.com/example/repo', writerRunId: 'original-writer', candidateSha: 'a'.repeat(40),
    stageId: 'first', participantAgentId: 'reviewer1', eventKey: 'original-event' };
  const first = { status: 'pending', currentStageType: 'review', currentStageId: 'first', currentStageIndex: 0,
    currentParticipant: { type: 'agent', agentId: 'reviewer1' }, completedStageIds: [], sourceReviewCapture: receipt,
    reviewRequest: { instructions: 'Review', candidateSha: receipt.candidateSha } };
  const second = { ...first, currentStageId: 'second', currentStageIndex: 1, currentParticipant: { type: 'agent', agentId: 'reviewer2' },
    completedStageIds: ['first'], lastDecisionOutcome: 'approved' };
  const task = { id: 'task', companyId: 'company', projectId: 'project', executionWorkspaceId: 'workspace', workspaceBindingRevision: 1,
    executionState: first, executionPolicy: { stages: ['first','second'].map((id,i) => ({ id, type: 'review', participants: [{agentId:'reviewer'+(i+1)}] })) } };
  const db = { select: () => ({ from: () => ({ where: async () => [{ repoUrl: 'https://github.com/example/repo' }] }) }) };
  const input = { task, patch: { status: 'in_review', executionState: second }, agentId: 'reviewer1', runId: 'review-run', requestedCandidate: null };
  const result = await prepareSourceReviewHandoff(db,input);
  assert.equal(result.event,null);
  assert.deepEqual(result.patch.executionState.sourceReviewCapture, { ...receipt, stageId: 'second', participantAgentId: 'reviewer2' });
  assert.equal(result.patch.executionState.reviewRequest.candidateSha, receipt.candidateSha);
  assert.equal(first.sourceReviewCapture, receipt);
  await assert.rejects(prepareSourceReviewHandoff(db,{...input,requestedCandidate:'b'.repeat(40)}), /explicit_candidate_mismatch/);
  for (const change of [{ workspaceBindingRevision: 2 }, { executionState: {...first, sourceReviewCapture:null} }]) {
    await assert.rejects(prepareSourceReviewHandoff(db,{...input,task:{...task,...change}}), /frozen_review_receipt_mismatch/);
  }
  await assert.rejects(prepareSourceReviewHandoff(db,{...input,patch:{...input.patch,executionState:{...second,lastDecisionOutcome:'changes_requested'}}}), /frozen_review_receipt_mismatch/);
});
