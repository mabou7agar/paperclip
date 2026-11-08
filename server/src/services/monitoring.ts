import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { monitoringPolicySchema, PROVIDER_QUOTA_MONITOR_SERVICE_NAME, type MonitoringObservation } from "@paperclipai/shared";
import { monitoringRepository } from "../repositories/monitoring.js";
import { logActivity, publishActivity } from "./activity-log.js";
import { isBoundedTaskContinuationMonitor } from "./issue-monitors.js";

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
  const h = createHash("sha256").update(JSON.stringify([observation.companyId, observation.issueId, observation.kind, observation.fingerprint])).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function monitoringService(db: Db) {
  const repository = monitoringRepository(db);
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
