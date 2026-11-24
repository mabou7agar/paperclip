import { and, desc, eq, gte, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, agents, companyMonitoringPolicies, issueTreeHoldMembers, issueTreeHolds, issues, type Db } from "@paperclipai/db";
import type { MonitoringObservation, MonitoringPolicy } from "@paperclipai/shared";

export const MONITORING_OWNER_NUDGE_ACTION = "monitoring.owner_nudge";

export function monitoringRepository(db: Db) {
  return {
    async policy(companyId: string) {
      return (await db.select().from(companyMonitoringPolicies).where(eq(companyMonitoringPolicies.companyId, companyId)).limit(1))[0]?.policy;
    },
    async save(companyId: string, policy: MonitoringPolicy) {
      await db.insert(companyMonitoringPolicies).values({ companyId, policy }).onConflictDoUpdate({
        target: companyMonitoringPolicies.companyId, set: { policy, updatedAt: new Date() },
      });
    },
    async issue(companyId: string, issueId: string) {
      return (await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1))[0] ?? null;
    },
    async alert(id: string, observation: MonitoringObservation, responsibleUserId: string | null) {
      return (await db.insert(activityLog).values({
        id, companyId: observation.companyId, actorType: "system", actorId: "monitoring",
        action: "monitoring.alert", entityType: "issue", entityId: observation.issueId,
        responsibleUserId, details: { ...observation, alertId: id, reportOnly: true },
      }).onConflictDoNothing().returning({ id: activityLog.id })).length > 0;
    },
    alerts(companyId: string) {
      return db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "monitoring.alert")))
        .orderBy(desc(activityLog.createdAt)).limit(100);
    },
    async agent(companyId: string, agentId: string) {
      return (await db.select({ id: agents.id, companyId: agents.companyId, status: agents.status }).from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).limit(1))[0] ?? null;
    },
    /** Direct, non-skipped membership in any active tree hold (pause or cancel). */
    async inActiveTreeHold(companyId: string, issueId: string) {
      return (await db.select({ holdId: issueTreeHolds.id }).from(issueTreeHoldMembers)
        .innerJoin(issueTreeHolds, eq(issueTreeHoldMembers.holdId, issueTreeHolds.id))
        .where(and(eq(issueTreeHoldMembers.companyId, companyId), eq(issueTreeHoldMembers.issueId, issueId),
          eq(issueTreeHoldMembers.skipped, false), eq(issueTreeHolds.status, "active"))).limit(1)).length > 0;
    },
    /**
     * Claim the single owner-nudge slot for one alert. The deterministic id keeps
     * one nudge per alert; the per-issue advisory lock plus window check keeps at
     * most one nudge per issue per window, whatever the alert fingerprint.
     */
    async claimOwnerNudge(input: {
      id: string; companyId: string; issueId: string; agentId: string; reason: string; since: Date;
      responsibleUserId: string | null; details: Record<string, unknown>;
    }) {
      return db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`monitoring-owner-nudge:${input.issueId}`}))`);
        const [recentRecord] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, input.companyId), eq(activityLog.action, MONITORING_OWNER_NUDGE_ACTION),
          eq(activityLog.entityType, "issue"), eq(activityLog.entityId, input.issueId), gte(activityLog.createdAt, input.since))).limit(1);
        if (recentRecord) return false;
        const [recentWake] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.reason, input.reason),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`, gte(agentWakeupRequests.requestedAt, input.since))).limit(1);
        if (recentWake) return false;
        return (await tx.insert(activityLog).values({
          id: input.id, companyId: input.companyId, actorType: "system", actorId: "monitoring",
          action: MONITORING_OWNER_NUDGE_ACTION, entityType: "issue", entityId: input.issueId, agentId: input.agentId,
          responsibleUserId: input.responsibleUserId, details: input.details,
        }).onConflictDoNothing().returning({ id: activityLog.id })).length > 0;
      });
    },
    async ownerNudgeExists(id: string) {
      return (await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.id, id)).limit(1)).length > 0;
    },
    async recordOwnerNudge(id: string, details: Record<string, unknown>) {
      await db.update(activityLog).set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify(details)}::jsonb` })
        .where(eq(activityLog.id, id));
    },
    async wakeByIdempotencyKey(companyId: string, idempotencyKey: string) {
      return (await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
        .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)))
        .orderBy(desc(agentWakeupRequests.requestedAt)).limit(1))[0] ?? null;
    },
  };
}
