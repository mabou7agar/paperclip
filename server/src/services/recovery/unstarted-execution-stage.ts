import { issueTreeControlService } from "../issue-tree-control.js";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";

/** Restore an obligation an older pause discarded before any invocation.
 * Never changes the cancelled receipt, retries a provider, or decides a stage.
 * The ordinary saved-receipt worker still owns admission and execution. */
export async function saveUnstartedExecutionStageReceipt(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
}): Promise<string | null> {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
      eq(issues.status, "in_review"), isNull(issues.executionRunId), isNull(issues.hiddenAt),
    )).for("update");
    const state = parseIssueExecutionState(issue?.executionState);
    if (!issue || state?.status !== "pending" || !state.currentStageId
      || !["review", "approval"].includes(state.currentStageType ?? "")
      || state.currentParticipant?.type !== "agent" || state.currentParticipant.agentId !== input.agentId) return null;

    // Do not spend the one-shot reconstruction while a pre-existing task-tree
    // pause would cancel its delivery. Reuse admission's ancestor-aware gate.
    if (await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(input.companyId, input.issueId)) return null;

    // A resume signal is not permission to bypass current lifecycle or company
    // authority. Execution's remaining gates are rechecked by canonical admission.
    const allowed = await tx.execute<{ allowed: boolean }>(sql`select exists (
      select 1 from agents a join companies c on c.id = a.company_id
      where a.id = ${input.agentId}::uuid and a.company_id = ${input.companyId}::uuid
        and c.status = 'active' and a.lifecycle_state = 'ready'
        and a.status not in ('paused', 'terminated', 'pending_approval')
        and a.lifecycle_holds = '[]'::jsonb
    ) as allowed`);
    if (!allowed[0]?.allowed) return null;
    const [participant] = await tx.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
    if (!(await evaluateAgentInvokabilityFromDb(tx as unknown as Db, participant)).invokable) return null;
    // Look at the newest receipt for this stage, regardless of status/reason.
    // A later explicit Stop or failed delivery must never expose an older pause.
    const [source] = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      sql`${agentWakeupRequests.payload}#>>'{executionStage,stageId}' = ${state.currentStageId}`,
    )).orderBy(desc(agentWakeupRequests.createdAt), desc(agentWakeupRequests.id)).limit(1);
    const expectedReason = state.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const context = source?.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
    if (!source || source.status !== "cancelled" || source.runId || !source.finishedAt
      || source.error !== "Agent lifecycle stop requested" || source.source !== "assignment"
      || context?.wakeReason !== expectedReason || source.finishedAt < source.createdAt) return null;
    // This text is also used by termination/cleanup. The content-free native
    // lifecycle journal must explicitly place this cancellation inside a pause.
    const cancelledAt = sql`(select finished_at from agent_wakeup_requests
      where company_id = ${input.companyId}::uuid and id = ${source.id}::uuid)`;
    const [pause] = await tx.select().from(resourceLifecycleEvents).where(and(
      eq(resourceLifecycleEvents.companyId, input.companyId), eq(resourceLifecycleEvents.resourceType, "agent"),
      eq(resourceLifecycleEvents.resourceId, input.agentId), lte(resourceLifecycleEvents.createdAt, cancelledAt),
    )).orderBy(desc(resourceLifecycleEvents.createdAt), desc(resourceLifecycleEvents.id)).limit(1);
    if (pause?.action !== "pause" || pause.createdAt < source.createdAt) return null;
    // Fail closed if a termination anywhere in this company could have caused
    // descendant cleanup during the original obligation. Missing pause proof
    // is not permission to reinterpret a destructive lifecycle Stop.
    const [termination] = await tx.select({ id: resourceLifecycleEvents.id }).from(resourceLifecycleEvents).where(and(
      eq(resourceLifecycleEvents.companyId, input.companyId), eq(resourceLifecycleEvents.resourceType, "agent"),
      eq(resourceLifecycleEvents.action, "terminate"), gte(resourceLifecycleEvents.createdAt, source.createdAt),
      lte(resourceLifecycleEvents.createdAt, cancelledAt),
    )).limit(1);
    if (termination) return null;
    const key = `execution-stage-resume:${input.issueId}:${state.currentStageId}:${input.agentId}`;
    const [existing] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      sql`(${agentWakeupRequests.idempotencyKey} = ${key} or (
        ${agentWakeupRequests.agentId} = ${input.agentId}::uuid
        and ${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}
        and ${agentWakeupRequests.payload}#>>'{executionStage,stageId}' = ${state.currentStageId}
        and ${agentWakeupRequests.status} in ('queued','deferred_issue_execution','claimed','coalesced','completed')
      ))`,
    )).limit(1);
    if (existing) return null;
    const [invoked] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
      eq(heartbeatRuns.agentId, input.agentId), gte(heartbeatRuns.createdAt, source.createdAt),
    )).limit(1);
    if (invoked) return null;
    const reason = state.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const executionStage = {
      wakeRole: state.currentStageType === "approval" ? "approver" : "reviewer",
      stageId: state.currentStageId, stageType: state.currentStageType,
      currentParticipant: state.currentParticipant, returnAssignee: state.returnAssignee,
      reviewRequest: state.reviewRequest ?? null, lastDecisionOutcome: state.lastDecisionOutcome,
      allowedActions: ["approve", "request_changes"],
    };
    // The issue lock serializes reconstruction across replicas. Retain the
    // deterministic key even on cancellation: this repair never repeats itself.
    await notifyDeferredExecutionWork(tx, { companyId: input.companyId });
    const [saved] = await tx.insert(agentWakeupRequests).values({
      companyId: input.companyId, agentId: input.agentId, source: "assignment", triggerDetail: "system",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", idempotencyKey: key,
      requestedByActorType: source.requestedByActorType, requestedByActorId: source.requestedByActorId,
      payload: { issueId: input.issueId, mutation: "update", executionStage,
        recoveredUnstartedReceiptId: source.id,
        _paperclipWakeContext: { issueId: input.issueId, taskId: input.issueId, wakeReason: reason,
          source: "issue.execution_stage", executionStage } },
    }).returning({ id: agentWakeupRequests.id });
    return saved.id;
  });
}
