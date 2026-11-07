import { unprocessable } from "../errors.js";
import type { Db } from "@paperclipai/db";
import {
  usageHealthPolicySchema,
  type UsageHealthFlag,
  type UsageHealthGroup,
  type UsageHealthObservation,
  type UsageHealthReport,
} from "@paperclipai/shared";
import {
  usageHealthRepository,
  type UsageHealthCursor,
} from "../repositories/usage-health.js";
import { withAccountingReadSnapshot } from "./accounting-transaction.js";
import {
  addUsageHealthObservation,
  assessUsageHealth,
  emptyUsageHealthTotals,
} from "./usage-health-evaluation.js";
import { logActivity } from "./activity-log.js";
import type { ActivityPublication } from "../types/activity-publication.js";

export function usageHealthService(db: Db) {
  const repository = usageHealthRepository(db);
  return {
    async policy(companyId: string) {
      return usageHealthPolicySchema.parse(
        (await repository.getPolicy(companyId)) ?? {},
      );
    },
    async savePolicy(companyId: string, raw: unknown, userId: string) {
      const policy = usageHealthPolicySchema.parse(raw);
      const ids = Object.keys(policy.agentOverrides);
      if (
        ids.length &&
        (await repository.countCompanyAgents(companyId, ids)) !== ids.length
      )
        throw unprocessable("Agent overrides must belong to this company");
      await repository.savePolicy(companyId, policy);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "usage.health_policy_updated",
        entityType: "company",
        entityId: companyId,
        details: { reportOnly: true, policy },
      });
      return policy;
    },
    report(
      companyId: string,
      from: Date,
      to: Date,
      canManage: boolean,
    ): Promise<UsageHealthReport> {
      return withAccountingReadSnapshot(db, companyId, async (tx) => {
        const repo = usageHealthRepository(tx);
        const policy = usageHealthPolicySchema.parse(
          (await repo.getPolicy(companyId)) ?? {},
        );
        const totals = emptyUsageHealthTotals(),
          groups = {
            byAgent: new Map<string, UsageHealthGroup>(),
            byModel: new Map<string, UsageHealthGroup>(),
            byTask: new Map<string, UsageHealthGroup>(),
          };
        const taskStarts = new Map<string, number[]>(),
          flags: UsageHealthFlag[] = [];
        let cursor: UsageHealthCursor | undefined,
          flagCount = 0;
        while (true) {
          const batch = await repo.observations(
            companyId,
            new Date(Math.max(0, from.getTime() - 3_600_000)),
            to,
            cursor,
          );
          for (const row of batch) {
            const starts = taskStarts.get(row.issueId ?? row.id) ?? [];
            const at = Date.parse(row.occurredAt);
            while (starts.length && starts[0] < at - 3_600_000) starts.shift();
            if (
              row.kind === "agent" &&
              (row.inputTokens ?? 0) +
                (row.cachedInputTokens ?? 0) +
                (row.outputTokens ?? 0) >
                0
            )
              starts.push(at);
            taskStarts.set(row.issueId ?? row.id, starts);
            if (at < from.getTime()) continue;
            addUsageHealthObservation(totals, row);
            const group = (
              target: Map<string, UsageHealthGroup>,
              id: string,
              label: string,
            ) => {
              if (!target.has(id))
                target.set(id, { id, label, ...emptyUsageHealthTotals() });
              addUsageHealthObservation(target.get(id)!, row);
            };
            group(
              groups.byAgent,
              row.agentId ?? row.kind,
              row.agentName ?? row.kind,
            );
            group(
              groups.byModel,
              `${row.provider}:${row.model}`,
              `${row.provider} · ${row.model}`,
            );
            group(
              groups.byTask,
              row.issueId ?? "unassigned",
              row.identifier ?? "Unassigned",
            );
            const found = assessUsageHealth(
              companyId,
              row,
              policy,
              starts.length,
            );
            flagCount += found.length;
            flags.push(...found);
            if (flags.length > 100) flags.splice(0, flags.length - 100);
          }
          if (batch.length < 500) break;
          const last = batch[batch.length - 1];
          cursor = { occurredAt: last.cursorAt, id: last.id, kind: last.kind };
        }
        const sorted = (map: Map<string, UsageHealthGroup>) =>
          [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
        return {
          from: from.toISOString(),
          to: to.toISOString(),
          policy,
          totals,
          canManage,
          status: flagCount
            ? "review"
            : totals.missingRuns
              ? "incomplete"
              : "within_thresholds",
          byAgent: sorted(groups.byAgent),
          byModel: sorted(groups.byModel),
          byTask: sorted(groups.byTask),
          flags: flags.reverse(),
          flagCount,
          alerts: await repo.recentAlerts(companyId, from, to),
        };
      });
    },
    /** Called inside accounting's transaction: failure retries accounting, never agent work. */
    async captureObservation(
      companyId: string,
      runId: string,
      kind = "agent",
    ): Promise<ActivityPublication[]> {
      const policy = usageHealthPolicySchema.parse(
        (await repository.getPolicy(companyId)) ?? {},
      );
      if (!policy.enabled) return [];
      const rows = await repository.observations(
        companyId,
        new Date(0),
        new Date(),
        undefined,
        runId,
      );
      const row = rows.find((item) => item.id === runId && item.kind === kind);
      if (!row) return [];
      const count =
        kind === "agent" && row.issueId
          ? await repository.taskRunCount(
              companyId,
              row.issueId,
              row.occurredAt,
            )
          : 0;
      const publications: ActivityPublication[] = [];
      for (const flag of assessUsageHealth(companyId, row, policy, count)) {
        if (await repository.addAlert(companyId, flag))
          publications.push({
            companyId,
            pluginEvent: null,
            payload: {
              action: "usage.health_alert",
              entityType: kind === "agent" ? "heartbeat_run" : "cost_event",
              entityId: runId,
              agentId: row.agentId,
              runId,
              issueId: row.issueId,
              details: { ...flag },
            },
          });
      }
      return publications;
    },
  };
}
