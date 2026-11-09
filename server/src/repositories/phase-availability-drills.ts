import { and, eq, isNull, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { PhaseAvailabilityDrill } from "@paperclipai/shared";

const action = "phase_routing.controlled_availability_fault";
const sameDrill = (details: Record<string, unknown> | null, drill: PhaseAvailabilityDrill) =>
  details?.phase === drill.phase && details?.profileId === drill.profileId && details?.expiresAt === drill.expiresAt;

/** The activity primary key is the durable one-use claim, including across restarts. */
export function phaseAvailabilityDrillRepository(db: Db) {
  return {
    async isUnusedId(id: string) {
      return !(await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.id, id)).limit(1)).length;
    },
    async isUnstartedTask(companyId: string, issueId: string) {
      const [row] = await db.select({ id: issues.id }).from(issues).where(and(
        eq(issues.companyId, companyId), eq(issues.id, issueId),
        eq(issues.status, "backlog"), isNull(issues.assigneeAgentId), isNull(issues.assigneeUserId),
        sql`not exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.companyId} = ${companyId}
          and (${heartbeatRuns.issueId} = ${issueId}::uuid or ${heartbeatRuns.nativeIssueId} = ${issueId}::uuid
            or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}))`,
      )).limit(1).for("update");
      return Boolean(row);
    },
    async apply(companyId: string, issueId: string, drill: PhaseAvailabilityDrill) {
      return db.transaction(async tx => {
        // This diagnostic selects a profile; it never authorizes execution.
        // Admission/dispatch own task mutation fences. Do not acquire a task
        // write lock from a separate connection during selection or resume.
        const [issue] = await tx.select({ id: issues.id, status: issues.status }).from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
        if (!issue || ["done", "cancelled"].includes(issue.status)) return "inactive" as const;
        let [receipt] = await tx.select().from(activityLog).where(eq(activityLog.id, drill.id));
        if (!receipt) {
          const [clock] = await tx.execute<{ eligible: boolean }>(sql`select ${drill.expiresAt}::timestamptz > clock_timestamp() as eligible`);
          if (!clock?.eligible) return "expired" as const;
          await tx.insert(activityLog).values({ id: drill.id, companyId, actorType: "system",
            actorId: "phase-routing", action, entityType: "issue", entityId: issueId,
            details: { ...drill, synthetic: true, providerWorkStarted: false, sharedQuotaChanged: false },
          }).onConflictDoNothing({ target: activityLog.id });
          [receipt] = await tx.select().from(activityLog).where(eq(activityLog.id, drill.id));
        }
        if (!receipt || receipt.companyId !== companyId || receipt.entityType !== "issue"
          || receipt.entityId !== issueId || receipt.action !== action || !sameDrill(receipt.details, drill)) {
          return "conflict" as const;
        }
        // Expiry bounds first activation, not an already accepted session's
        // return path. The task's terminal state retires this affinity pin.
        return "applied" as const;
      });
    },
  };
}
