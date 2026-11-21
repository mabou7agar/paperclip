import { profiles } from './configuration.mjs';
import { submission, delivery, uuid } from './contracts.mjs';

/** Persist evidence before requesting one native continuation. Never owns
 * sessions, assignments, reviews, tests, retry counters or approval policy. */
export class ResultService {
  constructor(ctx, broker) { this.ctx = ctx; this.broker = broker; this.pending = new Map(); }

  async submit(input, run) {
    const value = submission(input);
    if (![run.companyId, run.agentId, run.runId, run.projectId].every(uuid)) throw new Error('runner_run_context_required');
    if (!profiles(await this.ctx.config.get(run.companyId)).has(value.profile)) throw new Error('runner_profile_not_enabled');
    const issue = await this.ctx.issues.get(value.taskId, run.companyId);
    if (!issue || issue.companyId !== run.companyId || issue.projectId !== run.projectId ||
        issue.assigneeAgentId !== run.agentId || !['todo', 'in_progress', 'in_review'].includes(issue.status)) {
      throw new Error('runner_task_ownership_changed');
    }
    await this.ctx.issues.assertCheckoutOwner({ issueId: issue.id, companyId: run.companyId,
      actorAgentId: run.agentId, actorRunId: run.runId });
    return this.broker.call('submit', { ...value, companyId: run.companyId, projectId: run.projectId,
      agentId: run.agentId, sourceRunId: run.runId });
  }

  async status(jobId, run) {
    if (!uuid(jobId) || !uuid(run.companyId) || !uuid(run.agentId)) throw new Error('runner_status_invalid');
    return this.broker.call('status', { jobId, companyId: run.companyId, agentId: run.agentId });
  }

  async deliver(jobId) {
    if (!uuid(jobId)) throw new Error('runner_job_id_invalid');
    if (this.pending.has(jobId)) return this.pending.get(jobId);
    const work = this.deliverOnce(jobId).finally(() => this.pending.delete(jobId));
    this.pending.set(jobId, work); return work;
  }

  async deliverOnce(jobId) {
    // The webhook is only a hint. The root-owned broker supplies the actual
    // immutable outcome; no inbound body can invent evidence or select a task.
    return this.deliverResult(delivery(await this.broker.call('result', { jobId })));
  }

  async deliverResult(value, envelope) {
    const result = delivery(value), key = `${result.jobId}:${result.receiptSha256}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const work = this.writeResult(result, envelope).finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }

  async writeResult(result, envelope) {
    const jobId = result.jobId;
    if (!profiles(await this.ctx.config.get(result.companyId)).has(result.profile)) throw new Error('runner_profile_not_enabled');
    const issue = await this.ctx.issues.get(result.issueId, result.companyId);
    if (!issue || issue.companyId !== result.companyId || issue.projectId !== result.projectId) throw new Error('runner_result_scope_changed');
    const key = `runner-${jobId}-${result.receiptSha256.slice(0, 12)}`;
    const body = `# Runner result\n\nThis is measured execution evidence, not new execution or approval authority.\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\n` +
      'Resume this task\'s saved plan and compatible provider session. Reuse completed, still-valid evidence. ' +
      'On a new failure, diagnose and correct only the affected work, obtain independent review of the final change, ' +
      'then submit a distinct reviewed job containing only failed or unrun cases. Do not replay passed tests, reset a spent attempt, ' +
      'wake yourself, change limits, bypass a hold or treat diagnostic collection as feature completion. ' +
      'After required review and acceptance, return through the existing lead/CTO handoff. ' +
      'An unchanged failure is recorded without another wake. Unknown execution requires reconciliation, never another launch.\n';
    const existing = await this.ctx.issues.documents.get(issue.id, key, result.companyId);
    if (existing && existing.body !== body) throw new Error('runner_result_document_conflict');
    if (!existing) await this.ctx.issues.documents.upsert({ companyId: result.companyId, issueId: issue.id,
      key, title: 'Runner result', format: 'markdown', body });
    if (envelope && result.status === 'failed' && typeof this.ctx.issues.routeRunnerResult === 'function') {
      const recovery = await this.ctx.issues.routeRunnerResult(result.companyId, { envelope, jobId, receiptSha256: result.receiptSha256 });
      if (recovery.enabled) {
        // Preserve the existing native wait for a measured unchanged failure.
        // Closed tasks and a new responsible agent retain their current state.
        if (recovery.state === 'no_new_evidence') await this.markWaiting(issue, result);
        return this.broker.call('acknowledge', { jobId, receiptSha256: result.receiptSha256,
          disposition: recovery.state === 'routed' ? 'native_continuation' : 'recorded_only' });
      }
    }
    if (['done', 'cancelled'].includes(issue.status) || issue.assigneeAgentId !== result.agentId) {
      return this.broker.call('acknowledge', { jobId, receiptSha256: result.receiptSha256, disposition: 'recorded_only' });
    }
    if (!result.newEvidence && result.status !== 'passed') {
      // A repeated failure is a visible native wait, not an in-progress task
      // silently awaiting a callback that we deliberately suppress. The common
      // SDK update service preserves execution/review/session ownership.
      await this.markWaiting(issue, result);
      return this.broker.call('acknowledge', { jobId, receiptSha256: result.receiptSha256, disposition: 'recorded_only' });
    }
    const wake = await this.ctx.issues.requestWakeup(issue.id, result.companyId, {
      durable: true, reason: 'runner_result_received', expectedAssigneeAgentId: result.agentId, contextSource: 'ubuntu.runner.result',
      idempotencyKey: `runner-result:${jobId}:${result.receiptSha256}`,
    });
    return this.broker.call('acknowledge', { jobId, receiptSha256: result.receiptSha256,
      disposition: 'native_continuation', runId: wake.runId });
  }

  async markWaiting(issue, result) {
    if (result.status === 'unknown') return;
    const current = await this.ctx.issues.get(issue.id, result.companyId);
    if (!current || current.companyId !== result.companyId || current.projectId !== result.projectId ||
        current.assigneeAgentId !== result.agentId || !['todo', 'in_progress'].includes(current.status) ||
        current.executionState?.status === 'pending' || current.executionState?.reviewEscalated === true) return;
    await this.ctx.issues.update(issue.id, { status: 'blocked' }, result.companyId);
  }

  async drain() {
    const { jobs } = await this.broker.call('pending_deliveries', {});
    if (!Array.isArray(jobs) || jobs.length > 100 || !jobs.every(uuid)) throw new Error('runner_outbox_invalid');
    // One disabled company or held task must not starve other deliveries.
    // Rejected deliveries remain durably pending at the broker.
    const outcomes = await Promise.allSettled(jobs.map(id => this.deliver(id)));
    if (outcomes.some(value => value.status === 'rejected')) throw new Error('runner_delivery_pending');
  }
}
