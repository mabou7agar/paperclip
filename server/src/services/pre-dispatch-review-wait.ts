import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { readRunCancellation } from "./run-cancellation.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

type Run = typeof heartbeatRuns.$inferSelect;
type DispatchFields = "startedAt" | "runtimeModeResolvedAt" | "processPid" | "processGroupId" |
  "processStartedAt" | "nativeIssueId" | "nativeSessionId" | "sessionIdAfter" |
  "controllerBootId" | "controllerLeaseExpiresAt" | "executionStage" | "contextSnapshot";

/** The queued-run gate owns this receipt before execution authority is claimed.
 * A deliberate review or connection response wait has no provider actions to reconcile. The error code
 * alone is not proof; missing or conflicting dispatch evidence retains the hold. */
export function isPreDispatchReviewWait(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, DispatchFields>>,
): boolean {
  const finalResponseWait = run.errorCode === "issue_waiting_for_response" &&
    (run.resultJson?.preDispatchResponseWait as { version?: number; providerWorkStarted?: boolean } | undefined)?.version === 1 &&
    (run.resultJson?.preDispatchResponseWait as { providerWorkStarted?: boolean } | undefined)?.providerWorkStarted === false;
  return run.runtimeMode === "legacy" && run.status === "cancelled" &&
    (run.errorCode === "issue_continuation_waiting_on_review" ||
      (run.errorCode === "issue_waiting_for_response" &&
        run.contextSnapshot?.connectionIntentResolution === "existing_connection" &&
        run.contextSnapshot?.source === "connection_intent.resolved" &&
        run.contextSnapshot?.interactionKind === "connection_intent" &&
        run.contextSnapshot?.interactionStatus === "expired" &&
        run.contextSnapshot?.mutation === "interaction" &&
        typeof run.contextSnapshot?.interactionId === "string")) &&
    run.resultJson?.stopReason === run.errorCode &&
    run.resultJson?.timeoutSource === "stale_queued_run_gate" &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" &&
    (finalResponseWait || (run.startedAt === null && run.runtimeModeResolvedAt === null)) &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    (finalResponseWait || (run.controllerBootId === null && run.controllerLeaseExpiresAt === null && run.executionStage === null));
}

/** The row receipt is a candidate, not permission to discard conflicting
 * retained execution or cleanup evidence. Historical false holds must be
 * checked against the same evidence that gates explicit user admission. */
export async function isPreDispatchReviewWaitVerified(db: Db, run: Run): Promise<boolean> {
  if (!isPreDispatchReviewWait(run)) return false;
  return hasNoRetainedDispatchEvidence(db, run);
}

/** Cancelling a future quota wait does not stop a provider: that retry has
 * never become eligible for dispatch. Missing PIDs alone are insufficient. */
export function isCancelledQuotaWaitBeforeDispatch(run: Run): boolean {
  const cancellation = readRunCancellation(run.resultJson);
  const requestedAt = (run.resultJson?.startupCancellation as Record<string, unknown> | undefined)?.requestedAt;
  return run.runtimeMode === "legacy" && run.status === "cancelled" && run.errorCode === "cancelled" &&
    run.scheduledRetryReason === "ai_connection_pool_wait" && run.scheduledRetryAttempt > 0 &&
    typeof run.retryOfRunId === "string" && run.startedAt === null && run.runtimeModeResolvedAt === null &&
    run.executionStage === null && run.controllerBootId === null && run.controllerLeaseExpiresAt === null &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.nativeIssueId === null && run.nativeSessionId === null && run.sessionIdAfter === null &&
    run.finishedAt instanceof Date && run.scheduledRetryAt instanceof Date &&
    run.finishedAt.getTime() < run.scheduledRetryAt.getTime() &&
    cancellation?.expected === true && ["operator", "control_plane"].includes(cancellation.source) &&
    Date.parse(cancellation.recordedAt) <= run.finishedAt.getTime() &&
    typeof requestedAt === "string" && Date.parse(requestedAt) <= run.finishedAt.getTime() &&
    run.resultJson?.workspaceRestoreFailure !== "restore_unsafe_archive" && !hasRequiredWorkspaceRecovery(run.resultJson);
}

export async function isCancelledQuotaWaitBeforeDispatchVerified(db: Db, run: Run): Promise<boolean> {
  if (!isCancelledQuotaWaitBeforeDispatch(run)) return false;
  const [predecessor] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
    eq(heartbeatRuns.id, run.retryOfRunId!),
  )).limit(1);
  return Boolean(predecessor) && await hasNoRetainedDispatchEvidence(db, run);
}

/** A control-plane quota gate may renew the same authorized message once;
 * cancellation alone never proves provider work was absent. */
export async function isPhaseQuotaWaitBeforeDispatchVerified(db: Db, run: Run): Promise<boolean> {
  const cancellation = readRunCancellation(run.resultJson);
  const receipt = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || run.errorCode !== "phase_quota_cooldown" ||
      receipt?.kind !== "ai_connection_wait" || receipt.providerWorkStarted !== false ||
      cancellation?.source !== "control_plane" || cancellation.expected !== true ||
      !run.finishedAt || typeof run.resultJson?.retryAt !== "string" ||
      !Number.isFinite(Date.parse(run.resultJson.retryAt)) || Date.parse(run.resultJson.retryAt) <= run.finishedAt.getTime() ||
      run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null ||
      run.nativeIssueId !== null || run.nativeSessionId !== null || run.sessionIdAfter !== null ||
      run.resultJson.workspaceRestoreFailure === "restore_unsafe_archive" || hasRequiredWorkspaceRecovery(run.resultJson)) return false;
  return hasNoRetainedDispatchEvidence(db, run);
}

async function hasNoRetainedDispatchEvidence(db: Db, run: Run): Promise<boolean> {
  const [coordinator] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  if (coordinator) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => lease.provider === "local"
    ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    : !hasRemoteTerminationReceipt(lease))) return false;
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
        "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
        "provider.event", "provider.rpc_result", "tool.execution.started"])),
  )).limit(1);
  return !execution;
}
