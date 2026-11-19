import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, pluginState, runnerRecoveryPolicies,
  runnerRecoveryResults, type Db } from "@paperclipai/db";
import { canActorReadIssuePrivacy } from "../authorization.js";
import { runnerRecoveryPolicySchema, verifyRunnerEnvelope, type RunnerTrust } from "./runner-policy-contract.js";
import { currentFence, inSubtree, runnerRecoveryEnabled, runnerRecoveryHash } from "./runner-policy-recovery.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Joins the native queue's final claim transaction, never substitutes for native admission. */
export async function claimRunnerPolicyRecovery(tx: Tx, run: typeof heartbeatRuns.$inferSelect,
  trustLoader: () => Promise<RunnerTrust>) {
  if (run.contextSnapshot?.wakeReason !== "runner_policy_recovery") return true;
  const resultId = run.contextSnapshot.runnerRecoveryResultId;
  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, String(run.contextSnapshot.issueId)), eq(issues.companyId, run.companyId))).for("update");
  const [row] = await tx.select().from(runnerRecoveryResults).where(and(eq(runnerRecoveryResults.id, String(resultId)),
    eq(runnerRecoveryResults.companyId, run.companyId))).for("update");
  let reason: string | null = null;
  const [policy] = row?.policyId ? await tx.select().from(runnerRecoveryPolicies).where(and(eq(runnerRecoveryPolicies.id, row.policyId),
    eq(runnerRecoveryPolicies.companyId, run.companyId))).for("share") : [];
  if (!row || row.state !== "routing" || row.wakeupRequestId !== run.wakeupRequestId || !issue || row.issueId !== issue.id ||
    row.targetAgentId !== run.agentId || issue.assigneeAgentId !== run.agentId) reason = "ownership_changed";
  else if (!await runnerRecoveryEnabled(tx, run.companyId) || !policy?.activatedAt || policy.revokedAt ||
    policy.revision !== row.policyRevision) reason = "policy_changed";
  else {
    const payload = runnerRecoveryPolicySchema.safeParse(policy.payload);
    if (!payload.success || payload.data.expiresAt && new Date(payload.data.expiresAt) <= new Date()) reason = "policy_changed";
    else if (!await inSubtree(tx, run.companyId, issue.id, policy.rootIssueId) ||
      !await canActorReadIssuePrivacy(tx, { type: "agent", agentId: run.agentId, companyId: run.companyId }, issue)) reason = "scope_changed";
    else if (run.contextSnapshot?.projectId !== issue.projectId) reason = "scope_changed";
    else if (issue.status === "in_review" || issue.executionState?.status === "pending" || issue.executionState?.reviewEscalated) reason = "review_pending";
    else if (runnerRecoveryHash(await currentFence(tx, issue, policy.revision)) !== runnerRecoveryHash(row.fence)) reason = "fence_changed";
    if (!reason) {
      let trust: RunnerTrust;
      try { trust = await trustLoader(); } catch { reason = "verification_unavailable"; }
      if (!reason) {
        const envelope = verifyRunnerEnvelope(JSON.parse(row.envelopeBytes), trust!);
        const [latestRow] = await tx.select().from(pluginState).where(and(eq(pluginState.pluginId, row.pluginId),
          eq(pluginState.scopeKind, "issue"), eq(pluginState.scopeId, issue.id), eq(pluginState.namespace, "runner-results"), eq(pluginState.stateKey, row.jobId)));
        const latest = latestRow ? verifyRunnerEnvelope(latestRow.valueJson, trust!) : null;
        // Recheck signed execution scope against both the locked task and queued workspace.
        if (envelope.projectId !== issue.projectId || envelope.projectId !== run.contextSnapshot?.projectId ||
          envelope.agentId !== run.agentId) reason = "scope_changed";
        else if (!latest || latest.sequence !== envelope.sequence || runnerRecoveryHash(latest) !== runnerRecoveryHash(envelope)) reason = "newer_sequence";
      }
    }
  }
  if (reason) {
    const now = new Date();
    if (row?.state === "routing") {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.runnerPolicyRecovery, run.companyId);
      await tx.update(runnerRecoveryResults).set({ state: reason === "newer_sequence" ? "superseded" : "deferred", reason,
        stateVersion: sql`${runnerRecoveryResults.stateVersion} + 1`, updatedAt: now }).where(eq(runnerRecoveryResults.id, row.id));
      // Only release this unclaimed intent's reservation; never touch an unrelated action.
      if (row.recoveryActionId) await tx.update(issueRecoveryActions).set({ status: "cancelled", outcome: "not_admitted", resolvedAt: now, updatedAt: now })
        .where(and(eq(issueRecoveryActions.id, row.recoveryActionId), eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.cause, "runner_result_policy_recovery"), eq(issueRecoveryActions.status, "active")));
    }
    await tx.update(heartbeatRuns).set({ status: "cancelled", errorCode: "runner_recovery_deferred", error: reason, finishedAt: now, updatedAt: now })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")));
    if (run.wakeupRequestId) await tx.update(agentWakeupRequests).set({ status: "skipped", error: reason, finishedAt: now, updatedAt: now })
      .where(and(eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.companyId, run.companyId)));
    await tx.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
    return false;
  }
  await tx.update(runnerRecoveryResults).set({ state: "routed", reason: "claimed", stateVersion: sql`${runnerRecoveryResults.stateVersion} + 1`, updatedAt: new Date() })
    .where(and(eq(runnerRecoveryResults.id, row!.id), eq(runnerRecoveryResults.state, "routing")));
  return true;
}
