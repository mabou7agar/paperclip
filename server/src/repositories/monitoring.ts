import { and, desc, eq } from "drizzle-orm";
import { activityLog, companyMonitoringPolicies, issues, type Db } from "@paperclipai/db";
import type { MonitoringObservation, MonitoringPolicy } from "@paperclipai/shared";

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
  };
}
