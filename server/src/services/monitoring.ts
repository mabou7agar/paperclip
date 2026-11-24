import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { monitoringPolicySchema, PROVIDER_QUOTA_MONITOR_SERVICE_NAME, type MonitoringObservation } from "@paperclipai/shared";
import { MONITORING_OWNER_NUDGE_ACTION, monitoringRepository } from "../repositories/monitoring.js";
import { logger } from "../middleware/logger.js";
import { logActivity, publishActivity } from "./activity-log.js";
import { isBoundedTaskContinuationMonitor } from "./issue-monitors.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";

/**
 * Alert-only mode records a stuck task and stops automatic recovery. For the two
 * "nobody will act next" kinds, the task's own assignee is woken once so it can
 * continue, settle, or record what it waits for. This reason is deliberately not
 * matched by isMonitoringWake, so holdWake never cancels it.
 */
export const MONITORING_OWNER_NUDGE_REASON = "issue_monitoring_owner_nudge";
export const MONITORING_OWNER_NUDGE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MONITORING_OWNER_NUDGE_INSTRUCTION =
  "This task has no next step recorded. Continue it, settle it, or record what it is waiting for.";
const OWNER_NUDGE_KINDS: ReadonlySet<MonitoringObservation["kind"]> = new Set(["no_execution_path", "missing_disposition"]);
const OWNER_NUDGE_SKIPPED_ISSUE_STATUSES = ["done", "cancelled", "backlog"];
const OWNER_NUDGE_ISSUE_STATUSES = ["todo", "in_progress", "in_review", "blocked"];
const NON_INVOKABLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];

type OwnerNudgeWakeup = (agentId: string, opts: WakeupOptions) => Promise<{ id: string } | null>;
export type MonitoringServiceDeps = { wakeup?: OwnerNudgeWakeup };

// Nudges run detached from observe(): callers include the queue's claim path,
// which holds the agent start lock that a wakeup would wait for.
const pendingOwnerNudges = new Set<Promise<void>>();
export async function settleMonitoringOwnerNudges() {
  while (pendingOwnerNudges.size > 0) await Promise.allSettled([...pendingOwnerNudges]);
}

function deterministicUuid(parts: unknown[]) {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function isMonitoringWake(input: { source?: string | null; reason?: string | null; context?: Record<string, unknown> }) {
  if (input.source === "on_demand") return false;
  if (input.reason === "issue_assigned" && ["issue.unassigned_blocker_recovery", "issue.assigned_todo_liveness_dispatch"].includes(String(input.context?.source ?? ""))) return true;
  if (input.reason === "issue_blockers_resolved") {
    return input.context?.source === "issue_graph_liveness.backstop" || input.context?.backstop === "issue_graph_liveness_reconciliation";
  }
  return ["issue_disposition_repair", "issue_continuation_needed", "issue_assignment_recovery", "issue_graph_liveness_backstop",
    "issue_monitor_due", "task_watchdog_stopped_subtree"].includes(input.reason ?? "");
}

export function monitoringAlertId(observation: MonitoringObservation) {
  // Run ids, timestamps, repair attempts and dependent blocked-cycle stamps are
  // deliberately excluded: an observation is not a new execution event.
  return deterministicUuid([observation.companyId, observation.issueId, observation.kind, observation.fingerprint]);
}

export function monitoringOwnerNudgeId(alertId: string) {
  return deterministicUuid(["monitoring.owner_nudge", alertId]);
}

export function monitoringService(db: Db, deps: MonitoringServiceDeps = {}) {
  const repository = monitoringRepository(db);
  const wakeup: OwnerNudgeWakeup = deps.wakeup ?? (async (agentId, opts) => {
    // Lazy: heartbeat/queue.ts imports this module.
    const { heartbeatService } = await import("./heartbeat.js");
    return heartbeatService(db).wakeup(agentId, opts);
  });
  async function nudgeOwner(observation: MonitoringObservation, alertId: string, issue: NonNullable<Awaited<ReturnType<typeof repository.issue>>>) {
    const agentId = issue.assigneeAgentId;
    if (!agentId || OWNER_NUDGE_SKIPPED_ISSUE_STATUSES.includes(issue.status)) return;
    const agent = await repository.agent(observation.companyId, agentId);
    if (!agent || NON_INVOKABLE_AGENT_STATUSES.includes(agent.status)) return;
    if (await repository.inActiveTreeHold(observation.companyId, issue.id)) return;
    const { issueTreeControlService } = await import("./issue-tree-control.js");
    if (await issueTreeControlService(db).getActivePauseHoldGate(observation.companyId, issue.id)) return;
    const nudgeId = monitoringOwnerNudgeId(alertId);
    const idempotencyKey = `monitoring-owner-nudge:${alertId}`;
    const claimed = await repository.claimOwnerNudge({
      id: nudgeId, companyId: observation.companyId, issueId: issue.id, agentId, reason: MONITORING_OWNER_NUDGE_REASON,
      since: new Date(Date.now() - MONITORING_OWNER_NUDGE_WINDOW_MS), responsibleUserId: issue.responsibleUserId ?? issue.createdByUserId,
      details: { alertId, kind: observation.kind, fingerprint: observation.fingerprint, agentId, issueStatus: issue.status,
        identifier: issue.identifier, reason: MONITORING_OWNER_NUDGE_REASON, idempotencyKey },
    });
    if (!claimed) return;
    let outcome: Record<string, unknown>;
    try {
      const run = await wakeup(agentId, {
        source: "automation", triggerDetail: "system", reason: MONITORING_OWNER_NUDGE_REASON,
        requestedByActorType: "system", requestedByActorId: "monitoring", idempotencyKey,
        // Never merge into a queued recovery run that holdWake will cancel.
        allowRunCoalescing: false,
        issueStateGuard: { assigneeAgentId: agentId, statuses: OWNER_NUDGE_ISSUE_STATUSES },
        payload: { issueId: issue.id, taskId: issue.id, monitoringAlertId: alertId, monitoringAlertKind: observation.kind },
        contextSnapshot: {
          issueId: issue.id, taskId: issue.id, wakeReason: MONITORING_OWNER_NUDGE_REASON, source: "monitoring.owner_nudge",
          monitoringAlertId: alertId, monitoringAlertKind: observation.kind,
          // Rendered to the agent as the wake's reason and instruction.
          livenessContinuationReason: `monitoring_${observation.kind}`,
          livenessContinuationInstruction: MONITORING_OWNER_NUDGE_INSTRUCTION,
        },
      });
      const wake = await repository.wakeByIdempotencyKey(observation.companyId, idempotencyKey);
      outcome = { ownerNudged: Boolean(wake && wake.status !== "skipped"), wakeupRequestId: wake?.id ?? null,
        wakeStatus: wake?.status ?? null, runId: run?.id ?? wake?.runId ?? null };
    } catch (error) {
      outcome = { ownerNudged: false, wakeError: error instanceof Error ? error.message : String(error) };
      logger.warn({ err: error, companyId: observation.companyId, issueId: issue.id, alertId }, "monitoring owner nudge failed");
    }
    await repository.recordOwnerNudge(nudgeId, outcome);
    publishActivity({ companyId: observation.companyId, pluginEvent: null, payload: {
      action: MONITORING_OWNER_NUDGE_ACTION, entityType: "issue", entityId: issue.id, issueId: issue.id,
      details: { alertId, kind: observation.kind, agentId, identifier: issue.identifier, ...outcome },
    } });
  }
  const policy = async (companyId: string) => monitoringPolicySchema.parse((await repository.policy(companyId)) ?? {});
  async function observe(observation: MonitoringObservation) {
    if ((await policy(observation.companyId)).mode !== "alert_only") return false;
    const issue = await repository.issue(observation.companyId, observation.issueId);
    if (!issue || (["done", "cancelled"].includes(issue.status) && observation.kind !== "stopped_subtree")) return true;
    const id = monitoringAlertId(observation);
    if (await repository.alert(id, observation, issue.responsibleUserId ?? issue.createdByUserId)) {
      publishActivity({ companyId: observation.companyId, pluginEvent: null, payload: {
        action: "monitoring.alert", entityType: "issue", entityId: observation.issueId, issueId: observation.issueId,
        details: { ...observation, alertId: id, identifier: issue.identifier, reportOnly: true },
      } });
      // A detached nudge must not reuse a caller's transaction handle, which
      // may still be open (or already closed) when the nudge runs.
      if (OWNER_NUDGE_KINDS.has(observation.kind) && !("rollback" in db)) {
        const pending: Promise<void> = nudgeOwner(observation, id, issue)
          .catch(error => logger.warn({ err: error, companyId: observation.companyId, issueId: observation.issueId, alertId: id },
            "monitoring owner nudge failed"))
          .finally(() => { pendingOwnerNudges.delete(pending); });
        pendingOwnerNudges.add(pending);
      }
    }
    return true;
  }
  return {
    policy,
    alerts: repository.alerts,
    async savePolicy(companyId: string, input: unknown, userId: string) {
      const value = monitoringPolicySchema.parse(input);
      await repository.save(companyId, value);
      await logActivity(db, { companyId, actorType: "user", actorId: userId, action: "monitoring.policy_updated", entityType: "company", entityId: companyId, details: value });
      return value;
    },
    observe,
    async holdWake(input: { companyId: string; issueId: string | null; source?: string | null; reason?: string | null; context?: Record<string, unknown> }) {
      if (!input.issueId || !isMonitoringWake(input)) return false;
      // Never replace the independent once-only quota-renewal contract.
      const issue = await repository.issue(input.companyId, input.issueId);
      if (!issue) return false;
      const monitor = (issue.executionPolicy as { monitor?: Record<string, unknown> } | null)?.monitor;
      if (input.reason === "issue_monitor_due" && monitor?.serviceName === PROVIDER_QUOTA_MONITOR_SERVICE_NAME) return false;
      if (input.reason === "issue_monitor_due" && input.context?.source === "issue.monitor" &&
          input.context?.monitorKind === "task_continuation") {
        // Admission reads the live policy; queued dispatch reads the consumed
        // monitor receipt. Never trust a purpose flag supplied by a wake alone.
        const stored = monitor ?? (issue.executionState as { monitor?: Record<string, unknown> } | null)?.monitor;
        if (isBoundedTaskContinuationMonitor(stored) &&
            (issue.monitorNextCheckAt
              ? input.context.nextCheckAt === issue.monitorNextCheckAt.toISOString()
              : stored?.status === "triggered") &&
            stored?.serviceName === input.context.serviceName &&
            stored?.timeoutAt === input.context.timeoutAt &&
            stored?.maxAttempts === input.context.maxAttempts &&
            input.context.monitorAttemptCount === (issue.monitorNextCheckAt ? issue.monitorAttemptCount + 1 : issue.monitorAttemptCount)) return false;
      }
      return observe({ companyId: input.companyId, issueId: issue.id, kind: "no_execution_path",
        fingerprint: JSON.stringify([input.reason, issue.status, issue.assigneeAgentId]) });
    },
  };
}
