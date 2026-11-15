import { uuid, delivery } from './contracts.mjs';
import { digest, stableInput, jobId, requestKey, ADMISSION_NAMESPACE } from './native-contracts.mjs';
import { loadTrust, verifyEnvelope } from './native-envelope.mjs';
import { notifyNativeBroker } from './native-wake.mjs';

/** Intent uses host-owned state; signed responses use native actions. No IPC secret. */
export class NativeQueueClient {
  constructor(ctx, trustLoader = loadTrust, notify = notifyNativeBroker) {
    this.ctx = ctx; this.trustLoader = trustLoader; this.notify = notify; this.serial = Promise.resolve();
  }
  async startup() { await this.notify(); }
  async locked(work) {
    const next = this.serial.then(work); this.serial = next.catch(() => {}); return next;
  }
  async verified(envelope, companyId) {
    const trust = await this.trustLoader();
    return verifyEnvelope(envelope, { companyId, actor: { type: 'user', userId: trust.brokerUserId, companyId } }, trust);
  }
  async call(operation, input) {
    if (operation === 'submit') return this.locked(async () => {
      const id = jobId(input), key = requestKey(input.taskId, id);
      const retained = await this.ctx.state.get(requestKey(input.taskId,id,'runner-results'));
      if (retained) {
        const value = await this.verified(retained,input.companyId);
        if (value.kind !== 'result' || value.jobId !== id || value.agentId !== input.agentId ||
            value.projectId !== input.projectId || value.requestDigest !== digest(stableInput(input))) throw new Error('runner_request_conflict');
        const measured=delivery(value.data);
        return {jobId:id,state:measured.result.cleanupComplete===true?'terminal':'reconciliation_required',result:measured,replayed:true,
          next:'Measured result already retained. Use it in this turn. Do not wait for another wake, repeat tests or reset the job.'};
      }
      const admission = await this.ctx.state.get(requestKey(input.taskId, id, ADMISSION_NAMESPACE));
      if (admission) {
        const value = await this.verified(admission, input.companyId);
        if (value.kind !== 'admission' || value.requestDigest !== digest(stableInput(input))) throw new Error('runner_request_conflict');
        return { ...value.data, replayed: true };
      }
      const previous = await this.ctx.state.get(key);
      if (previous && digest(stableInput(previous)) !== digest(stableInput(input))) throw new Error('runner_request_conflict');
      const pendingKey = { scopeKind: 'company', scopeId: input.companyId, namespace: 'runner-queue', stateKey: 'pending' };
      const pending = await this.ctx.state.get(pendingKey) ?? [];
      if (!Array.isArray(pending) || !pending.every(uuid) || pending.length > 128 ||
          (!pending.includes(id) && pending.length === 128)) throw new Error('runner_request_capacity_wait');
      if (Buffer.byteLength(JSON.stringify(input)) > 16 * 1024) throw new Error('runner_request_too_large');
      try {
        await this.ctx.state.set({ scopeKind: 'agent', scopeId: input.agentId, namespace: 'runner-index', stateKey: id },
          { taskId: input.taskId, companyId: input.companyId, agentId: input.agentId });
        await this.ctx.state.set(pendingKey, [...new Set([...pending, id])]);
        if (!previous) await this.ctx.state.set(key, input);
      } finally {
        // An ambiguous state-write response may already have committed. Hint
        // even on error; a worker or plugin restart must not be a lost cursor.
        await this.notify();
      }
      return { jobId: id, state: 'pending_admission', replayed: !!previous,
        next: 'Intent saved, not execution authority. End this turn and wait for the native result. Do not poll, repeat tests, create a timer or wake yourself.' };
    });
    if (operation === 'status') {
      const index = await this.ctx.state.get({ scopeKind: 'agent', scopeId: input.agentId, namespace: 'runner-index', stateKey: input.jobId });
      if (!index || index.companyId !== input.companyId || index.agentId !== input.agentId || !uuid(index.taskId)) throw new Error('runner_job_not_found');
      const outcome = await this.ctx.state.get(requestKey(index.taskId, input.jobId, 'runner-results'));
      if (outcome) {
        const result = await this.verified(outcome, input.companyId);
        if (result.jobId !== input.jobId || result.agentId !== input.agentId || result.issueId !== index.taskId || result.kind !== 'result') throw new Error('runner_result_scope_invalid');
        const measured=delivery(result.data);
        return { jobId:input.jobId, state:measured.result.cleanupComplete === true ? 'terminal' : 'reconciliation_required', result:measured };
      }
      const saved = await this.ctx.state.get(requestKey(index.taskId, input.jobId, ADMISSION_NAMESPACE));
      if (!saved) return { jobId: input.jobId, state: 'pending_admission' };
      const value = await this.verified(saved, input.companyId);
      if (value.jobId !== input.jobId || value.agentId !== input.agentId || value.issueId !== index.taskId || value.kind !== 'admission') throw new Error('runner_admission_scope_invalid');
      return value.data;
    }
    // The broker independently verifies the native wake/document. This return
    // is only a local adapter result and never an authoritative remote ACK.
    if (operation === 'acknowledge') return { recorded: true };
    if (operation === 'pending_deliveries') return { jobs: [] };
    throw new Error('runner_native_operation_invalid');
  }
  async receive(envelope, context, service) {
    // Native actions add their host-authorized companyId to params. It is
    // scope, not part of the signed envelope, and may never contradict actor.
    if (Object.hasOwn(envelope, 'companyId')) {
      if (envelope.companyId !== context?.companyId) throw new Error('runner_action_company_conflict');
      const { companyId: _companyId, ...signed } = envelope; envelope = signed;
    }
    const trust = await this.trustLoader(), value = verifyEnvelope(envelope, context, trust);
    const key = requestKey(value.issueId, value.jobId);
    const request = await this.ctx.state.get(key);
    const previous = await this.ctx.state.get(requestKey(value.issueId, value.jobId, ADMISSION_NAMESPACE));
    const saved = previous ? await this.verified(previous, value.companyId) : null;
    if (request ? digest(stableInput(request)) !== value.requestDigest || request.companyId !== value.companyId ||
        request.projectId !== value.projectId || request.agentId !== value.agentId || jobId(request) !== value.jobId
      : !saved || saved.kind !== 'admission' || saved.requestDigest !== value.requestDigest ||
        saved.agentId !== value.agentId || saved.projectId !== value.projectId) throw new Error('runner_response_request_conflict');
    if (value.kind === 'admission') {
      if (!value.data || value.data.jobId !== value.jobId || !['queued', 'launching', 'quarantined', 'delivering', 'terminal', 'not_admitted'].includes(value.data.state)) throw new Error('runner_admission_invalid');
      await this.ctx.state.set(requestKey(value.issueId, value.jobId, ADMISSION_NAMESPACE), envelope);
      await this.ctx.state.delete(key);
      await this.locked(async () => {
        const pendingKey = { scopeKind: 'company', scopeId: value.companyId, namespace: 'runner-queue', stateKey: 'pending' };
        const pending = await this.ctx.state.get(pendingKey) ?? [];
        if (!Array.isArray(pending) || !pending.every(uuid)) throw new Error('runner_queue_invalid');
        await this.ctx.state.set(pendingKey, pending.filter(id => id !== value.jobId));
      });
      // A late refusal must not leave a silently waiting worker. Replays use
      // the same server-owned receipt and cannot create another provider turn.
      if (value.data.state === 'not_admitted') {
        const issue = await this.ctx.issues.get(value.issueId, value.companyId);
        if (!issue || issue.companyId !== value.companyId || issue.projectId !== value.projectId) throw new Error('runner_admission_scope_changed');
        const body = `Runner admission refused before execution. No attempt or test was started.\n\n${JSON.stringify(value.data)}\n\nPreserve the saved plan and session. Resolve only this configuration or authority failure; do not repeat tests, reset counters, poll or wake yourself.`;
        const documentKey = `runner-admission-${value.jobId}`;
        const existing = await this.ctx.issues.documents.get(value.issueId, documentKey, value.companyId);
        if (existing && existing.body !== body) throw new Error('runner_admission_document_conflict');
        if (!existing) await this.ctx.issues.documents.upsert({ companyId:value.companyId, issueId:value.issueId,
          key:documentKey, title:'Runner admission', format:'markdown', body });
        if (['done','cancelled'].includes(issue.status) || issue.assigneeAgentId !== value.agentId) return { recorded:true };
        return this.ctx.issues.requestWakeup(value.issueId, value.companyId, {
          durable: true, reason: 'runner_admission_refused', expectedAssigneeAgentId: value.agentId,
          contextSource: 'ubuntu.runner.admission', idempotencyKey: `runner-admission:${value.jobId}`,
        });
      }
      return { recorded: true };
    }
    const result = delivery(value.data);
    if (result.jobId !== value.jobId || result.companyId !== value.companyId || result.issueId !== value.issueId ||
        result.agentId !== value.agentId || result.projectId !== value.projectId) throw new Error('runner_delivery_scope_invalid');
    const current = await this.locked(async () => {
      const resultKey=requestKey(value.issueId,value.jobId,'runner-results');
      const savedEnvelope=await this.ctx.state.get(resultKey);
      if (savedEnvelope) {
        const latest=await this.verified(savedEnvelope,value.companyId);
        if (latest.jobId !== value.jobId || latest.kind !== 'result' || latest.requestDigest !== value.requestDigest) throw new Error('runner_saved_result_conflict');
        if (latest.sequence > value.sequence) return false;
        if (latest.sequence === value.sequence && canonicalEnvelope(latest) !== canonicalEnvelope(value)) throw new Error('runner_result_sequence_conflict');
      }
      await this.ctx.state.set(resultKey,envelope);return true;
    });
    return current ? service.deliverResult(result) : {recorded:true,stale:true};
  }
}

const canonicalEnvelope = value => JSON.stringify(value);
