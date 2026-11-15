import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ResultService } from '../plugin/result-service.mjs';
import { submission } from '../plugin/contracts.mjs';

function fixture() {
  const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), jobId = randomUUID();
  const issue = { id: issueId, companyId, projectId, assigneeAgentId: agentId, status: 'in_progress' };
  const result = { jobId, companyId, projectId, agentId, issueId, profile: 'example', status: 'failed',
    receiptSha256: 'a'.repeat(64), fingerprint: 'b'.repeat(64), newEvidence: true,
    result: { status: 'failed', diagnostic: { stage: 'prerequisite', sourceSha256: 'c'.repeat(64), line: 33 } } };
  const documents = new Map(), nativeReceipts = new Map(), writes = [], calls = [];
  let providers = 0, failAcknowledgement = false, rejectWake = false;
  const ctx = { config: { get: async () => ({ profiles: ['example'] }) }, issues: {
    get: async () => issue,
    update: async (_id, patch) => Object.assign(issue, patch),
    assertCheckoutOwner: async () => ({ issueId }),
    documents: {
      get: async (_id, key) => documents.get(key) ?? null,
      upsert: async value => { writes.push(value); documents.set(value.key, value); return value; },
    },
    requestWakeup: async (_id, _company, options) => {
      calls.push(options);
      if (rejectWake) throw new Error('temporary native hold');
      if (!nativeReceipts.has(options.idempotencyKey)) {
        providers++; nativeReceipts.set(options.idempotencyKey, randomUUID());
      }
      return { queued: true, runId: nativeReceipts.get(options.idempotencyKey) };
    },
  } };
  const broker = { call: async (op, value) => {
    if (op === 'result') { assert.equal(value.jobId, jobId); return result; }
    if (op === 'acknowledge') { if (failAcknowledgement) throw new Error('lost ACK'); return { acknowledged: true }; }
    if (op === 'submit') return { jobId, replayed: false };
    if (op === 'pending_deliveries') return { jobs: [jobId] };
    throw new Error('unexpected operation');
  } };
  return { ctx, broker, result, issue, writes, calls, documents, get providers() { return providers; },
    set failAcknowledgement(value) { failAcknowledgement = value; }, set rejectWake(value) { rejectWake = value; },
    service: () => new ResultService(ctx, broker),
    run: { companyId, projectId, agentId, runId: randomUUID() } };
}

test('simultaneous terminal hints save evidence first and request one native continuation', async () => {
  const f = fixture(), service = f.service();
  await Promise.all([service.deliver(f.result.jobId), service.deliver(f.result.jobId)]);
  assert.equal(f.writes.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.providers, 1);
  assert.match(f.writes[0].body, /saved plan and compatible provider session/);
  assert.match(f.writes[0].body, /Do not replay passed tests/);
  assert.equal(f.calls[0].reason, 'runner_result_received');
});

test('lost callback ACK and worker restart recover the same document and durable native receipt', async () => {
  const f = fixture(); f.failAcknowledgement = true;
  await assert.rejects(f.service().deliver(f.result.jobId), /lost ACK/);
  f.failAcknowledgement = false;
  await f.service().deliver(f.result.jobId);
  assert.equal(f.writes.length, 1); assert.equal(f.providers, 1);
  assert.equal(f.calls[0].idempotencyKey, f.calls[1].idempotencyKey);
});

test('evidence survives a native admission hold and resumes only through that admission', async () => {
  const f = fixture(); f.rejectWake = true;
  await assert.rejects(f.service().deliver(f.result.jobId), /temporary native hold/);
  assert.equal(f.writes.length, 1); assert.equal(f.providers, 0);
  f.rejectWake = false;
  await f.service().deliver(f.result.jobId);
  assert.equal(f.writes.length, 1); assert.equal(f.providers, 1);
});

test('the same unresolved failure is recorded without another provider wake', async () => {
  const f = fixture(); f.result.newEvidence = false;
  await f.service().deliver(f.result.jobId);
  assert.equal(f.writes.length, 1); assert.equal(f.providers, 0); assert.equal(f.issue.status, 'blocked');
});

test('unknown execution gets one reconciliation turn, never an execution retry', async () => {
  const f = fixture(); f.result.status = 'unknown';
  await f.service().deliver(f.result.jobId);
  assert.equal(f.providers, 1);
  assert.match(f.writes[0].body, /Unknown execution requires reconciliation, never another launch/);
});

test('reconciled new evidence retains the old receipt and uses a distinct native delivery', async () => {
  const f = fixture(); f.result.status = 'unknown';
  await f.service().deliver(f.result.jobId);
  f.result.status = 'failed'; f.result.receiptSha256 = 'd'.repeat(64); f.result.fingerprint = 'e'.repeat(64);
  await f.service().deliver(f.result.jobId);
  assert.equal(f.documents.size, 2); assert.equal(f.providers, 2);
  assert.notEqual(f.calls[0].idempotencyKey, f.calls[1].idempotencyKey);
});

test('reassignment and closed tasks retain results without waking the previous worker', async () => {
  for (const patch of [{ status: 'done' }, { status: 'cancelled' }, { assigneeAgentId: randomUUID() }]) {
    const f = fixture(); Object.assign(f.issue, patch);
    await f.service().deliver(f.result.jobId);
    assert.equal(f.writes.length, 1); assert.equal(f.providers, 0);
  }
});

test('forged/cross-company result and changed immutable document fail before native wake', async () => {
  const f = fixture(); f.result.companyId = randomUUID();
  await assert.rejects(f.service().deliver(f.result.jobId), /scope_changed/);
  assert.equal(f.writes.length, 0); assert.equal(f.providers, 0);
  const g = fixture(); await g.service().deliver(g.result.jobId);
  g.result.result.diagnostic.line = 99;
  await assert.rejects(g.service().deliver(g.result.jobId), /document_conflict/);
  assert.equal(g.providers, 1);
});

test('submission binds company/project/assignee and current native checkout, never caller commands', async () => {
  const f = fixture(); const input = { taskId: f.issue.id, profile: 'example', kind: 'reviewed_controller',
    attachmentId: randomUUID(), packetSha256: 'a'.repeat(64), scopeIssueId: randomUUID(),
    scopeCommentId: randomUUID(), ackCommentId: randomUUID(), recipe: null };
  assert.equal((await f.service().submit(input, f.run)).jobId, f.result.jobId);
  assert.throws(() => submission({ ...input, command: 'unsafe' }), /invalid/);
  await assert.rejects(f.service().submit(input, { ...f.run, companyId: randomUUID() }), /ownership_changed/);
  await assert.rejects(f.service().submit(input, { ...f.run, agentId: randomUUID() }), /ownership_changed/);
});
