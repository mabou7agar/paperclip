import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, runnerRecoveryResults, type Db } from "@paperclipai/db";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { budgetService } from "../budgets.js";
import { issueService } from "../issues.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { heartbeatService } from "../heartbeat.js";
import { pluginWakeupReceipt } from "../plugin-wakeup-receipts.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { runnerPolicyRecovery, type ResultRow } from "./runner-policy-recovery.js";
import { loadRunnerPolicyTrust } from "./runner-policy-trust.js";
import { logger } from "../../middleware/logger.js";

/** Native plugin host lifetime; all dispatch still passes through heartbeat.wakeup. */
export function runnerPolicyRuntime(db: Db, pluginId: string) {
  const issues = issueService(db), budgets = budgetService(db), tree = issueTreeControlService(db);
  const router = runnerPolicyRecovery(db, {
    trust: loadRunnerPolicyTrust,
    async guard(companyId, issueId, agentId) {
      const issue = await issues.getById(issueId);
      if (!issue || issue.companyId !== companyId || issue.assigneeAgentId !== agentId) return false;
      const relations = await issues.getRelationSummaries(issueId);
      return !relations.blockedBy.some(b => b.status !== "done") &&
        !await budgets.getInvocationBlock(companyId, agentId, { issueId, projectId: issue.projectId }) &&
        !await tree.getActivePauseHoldGate(companyId, issueId);
    },
    wake: row => dispatchRunnerRecoveryWake(db, row),
  });
  let stopped = false, pending = Promise.resolve();
  async function reconcile(companyId?: string) {
    const rows = await db.select({ companyId: runnerRecoveryResults.companyId, issueId: runnerRecoveryResults.issueId })
      .from(runnerRecoveryResults).where(and(eq(runnerRecoveryResults.pluginId, pluginId),
        inArray(runnerRecoveryResults.state, ["deferred", "routing"]), companyId ? eq(runnerRecoveryResults.companyId, companyId) : undefined));
    for (const row of rows) if (!stopped) await router.reevaluateDeferred(row.companyId, row.issueId, "admission_released");
  }
  const stop = subscribeDatabaseWork(db, DELIVERY_QUEUES.runnerPolicyRecovery, (event, hints) => {
    if (event !== "settled" || stopped) return;
    for (const hint of hints ?? []) {
      pending = pending.then(() => reconcile(hint)).catch(error => logger.warn({ error }, "runner recovery retained for a native release event"));
    }
  });
  pending = pending.then(() => reconcile()).catch(error => logger.warn({ error }, "runner recovery startup retained"));
  return { ...router, dispose() { stopped = true; stop(); } };
}

/** One native wake boundary, shared by runtime routing and queue integration tests. */
export async function dispatchRunnerRecoveryWake(db: Db, row: ResultRow) {
  if (!row.targetAgentId || !row.wakeupRequestId || !row.wakeIdempotencyKey) throw new Error("runner_recovery_intent_incomplete");
  const receipt = pluginWakeupReceipt({ companyId: row.companyId, pluginId: row.pluginId, issueId: row.issueId,
    agentId: row.targetAgentId, idempotencyKey: row.wakeIdempotencyKey, reason: "runner_policy_recovery", contextSource: "ubuntu.runner.policy_recovery" });
  // A skipped, never-admitted intent may retry with a new persisted receipt ID;
  // its deterministic key still permits only one non-skipped delivery.
  receipt.id = row.wakeupRequestId; receipt.requestedAt = row.createdAt;
  await heartbeatService(db).wakeup(row.targetAgentId, { source: "assignment", triggerDetail: "system", reason: receipt.reason,
    requestedByActorType: "system", requestedByActorId: row.pluginId, idempotencyKey: receipt.idempotencyKey,
    allowRunCoalescing: false, durablePluginRequest: receipt, issueStateGuard: { assigneeAgentId: row.targetAgentId, statuses: ["todo", "in_progress", "blocked"],
      statusVersion: Number(row.fence?.statusVersion) },
    payload: { issueId: row.issueId, pluginId: row.pluginId, pluginWakeupDigest: receipt.digest, contextSource: receipt.contextSource },
    contextSnapshot: { issueId: row.issueId, taskId: row.issueId, pluginId: row.pluginId, wakeReason: receipt.reason,
      runnerRecoveryResultId: row.id, source: receipt.contextSource } });
  const [saved] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, receipt.id), eq(agentWakeupRequests.companyId, row.companyId)));
  if (!saved) throw new Error("runner_recovery_wake_unconfirmed");
  const [priorRun] = saved.runId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, saved.runId), eq(heartbeatRuns.companyId, row.companyId))) : [];
  const ownStartedRun = priorRun?.wakeupRequestId === saved.id && Boolean(priorRun.startedAt);
  if (!["queued", "claimed"].includes(saved.status) && !ownStartedRun) await db.transaction(async tx => {
    if (saved.status !== "skipped") await tx.update(agentWakeupRequests).set({ status: "skipped", updatedAt: new Date() })
      .where(and(eq(agentWakeupRequests.id, saved.id), eq(agentWakeupRequests.status, saved.status)));
    const [deferred] = await tx.update(runnerRecoveryResults).set({ state: "deferred", reason: "guard_held", stateVersion: row.stateVersion + 1,
      updatedAt: new Date() }).where(and(eq(runnerRecoveryResults.id, row.id), eq(runnerRecoveryResults.state, "routing"),
      eq(runnerRecoveryResults.stateVersion, row.stateVersion))).returning();
    if (deferred?.recoveryActionId) await tx.update(issueRecoveryActions).set({ status: "cancelled", outcome: "not_admitted", resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(issueRecoveryActions.id, deferred.recoveryActionId), eq(issueRecoveryActions.companyId, row.companyId),
        eq(issueRecoveryActions.cause, "runner_result_policy_recovery"), eq(issueRecoveryActions.status, "active")));
  });
  return { wakeupRequestId: saved.id };
}
