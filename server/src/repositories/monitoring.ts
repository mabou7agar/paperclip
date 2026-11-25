import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  activityLog, agentWakeupRequests, agents, companyMonitoringPolicies, heartbeatRuns, issueThreadInteractions, issueTreeHoldMembers,
  issueTreeHolds, issues, type Db,
} from "@paperclipai/db";
import type { MonitoringObservation, MonitoringPolicy } from "@paperclipai/shared";

export const MONITORING_OWNER_NUDGE_ACTION = "monitoring.owner_nudge";

/**
 * Alert kinds about work left outside any task (follow-ups, owner decisions,
 * reviews without a reviewer). Their nudges are counted per kind, apart from
 * the "no next step" nudges, so neither uses up the other's window.
 */
export const MONITORING_FOLLOW_UP_NUDGE_KINDS: readonly MonitoringObservation["kind"][] = ["untracked_follow_ups",
  "owner_decision_without_card"];

/**
 * How a claim is bounded per issue inside the window:
 * - single: no other owner nudge on the issue (the original rule); with
 *   `alertKind`, no other nudge of that follow-up kind;
 * - repeat: the earlier nudges' times still allow one more (backoff and cap).
 */
export type OwnerNudgeClaimMode = { kind: "single"; alertKind?: MonitoringObservation["kind"] }
  | { kind: "repeat"; allow: (previous: Date[]) => boolean };

/** Nudge records counted against a window: one follow-up kind, or every non-follow-up kind. */
function countedNudgeKinds(alertKind?: MonitoringObservation["kind"]) {
  const kinds = sql.join(MONITORING_FOLLOW_UP_NUDGE_KINDS.map(kind => sql`${kind}`), sql`, `);
  return alertKind ? sql`${activityLog.details} ->> 'kind' = ${alertKind}`
    : sql`coalesce(${activityLog.details} ->> 'kind', '') not in (${kinds})`;
}

function countedWakeKinds(alertKind?: MonitoringObservation["kind"]) {
  const kinds = sql.join(MONITORING_FOLLOW_UP_NUDGE_KINDS.map(kind => sql`${kind}`), sql`, `);
  return alertKind ? sql`${agentWakeupRequests.payload} ->> 'monitoringAlertKind' = ${alertKind}`
    : sql`coalesce(${agentWakeupRequests.payload} ->> 'monitoringAlertKind', '') not in (${kinds})`;
}

/** When a nudge record last woke its agent: a reclaimed claim woke at its takeover, not its creation. */
const nudgedAt = sql<Date>`greatest(${activityLog.createdAt}, (${activityLog.details} ->> 'reclaimedAt')::timestamptz)`.mapWith(activityLog.createdAt);

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
      responsibleUserId: string | null; details: Record<string, unknown>; mode?: OwnerNudgeClaimMode;
    }) {
      return db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`monitoring-owner-nudge:${input.issueId}`}))`);
        const mode = input.mode ?? { kind: "single" };
        if (mode.kind === "repeat") {
          const previous = await tx.select({ createdAt: nudgedAt }).from(activityLog).where(and(
            eq(activityLog.companyId, input.companyId), eq(activityLog.action, MONITORING_OWNER_NUDGE_ACTION),
            eq(activityLog.entityType, "issue"), eq(activityLog.entityId, input.issueId), gte(activityLog.createdAt, input.since),
            countedNudgeKinds()));
          if (!mode.allow(previous.map(row => row.createdAt))) return false;
          return (await tx.insert(activityLog).values({
            id: input.id, companyId: input.companyId, actorType: "system", actorId: "monitoring",
            action: MONITORING_OWNER_NUDGE_ACTION, entityType: "issue", entityId: input.issueId, agentId: input.agentId,
            responsibleUserId: input.responsibleUserId, details: input.details,
          }).onConflictDoNothing().returning({ id: activityLog.id })).length > 0;
        }
        const [recentRecord] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, input.companyId), eq(activityLog.action, MONITORING_OWNER_NUDGE_ACTION),
          eq(activityLog.entityType, "issue"), eq(activityLog.entityId, input.issueId), gte(activityLog.createdAt, input.since),
          countedNudgeKinds(mode.alertKind))).limit(1);
        if (recentRecord) return false;
        const [recentWake] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.reason, input.reason),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`, gte(agentWakeupRequests.requestedAt, input.since),
          countedWakeKinds(mode.alertKind))).limit(1);
        if (recentWake) return false;
        return (await tx.insert(activityLog).values({
          id: input.id, companyId: input.companyId, actorType: "system", actorId: "monitoring",
          action: MONITORING_OWNER_NUDGE_ACTION, entityType: "issue", entityId: input.issueId, agentId: input.agentId,
          responsibleUserId: input.responsibleUserId, details: input.details,
        }).onConflictDoNothing().returning({ id: activityLog.id })).length > 0;
      });
    },
    /** The alert's nudge record, if one was ever claimed. */
    async ownerNudgeRecord(id: string) {
      return (await db.select({ details: activityLog.details, createdAt: activityLog.createdAt }).from(activityLog)
        .where(eq(activityLog.id, id)).limit(1))[0] ?? null;
    },
    /** Whether the issue had an owner nudge (of one follow-up kind, or of the other kinds) claimed since the window start. */
    async recentOwnerNudge(companyId: string, issueId: string, since: Date, alertKind?: MonitoringObservation["kind"]) {
      return (await db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.action, MONITORING_OWNER_NUDGE_ACTION),
        eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId), gte(activityLog.createdAt, since),
        countedNudgeKinds(alertKind))).limit(1)).length > 0;
    },
    /** When the issue's owner nudges claimed since the window start woke their agent. */
    async ownerNudgeTimes(companyId: string, issueId: string, since: Date) {
      return (await db.select({ createdAt: nudgedAt }).from(activityLog).where(and(
        eq(activityLog.companyId, companyId), eq(activityLog.action, MONITORING_OWNER_NUDGE_ACTION),
        eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId), gte(activityLog.createdAt, since),
        countedNudgeKinds())))
        .map(row => row.createdAt);
    },
    /** A pending owner question card on the task: the owner, not the agent, acts next. */
    async pendingOwnerCard(companyId: string, issueId: string) {
      return (await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.kind, "ask_user_questions"), eq(issueThreadInteractions.status, "pending"))).limit(1)).length > 0;
    },
    /** A queued, running or retry-scheduled run of this agent on this task. */
    async activeIssueRun(companyId: string, agentId: string, issueId: string) {
      return (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        or(eq(heartbeatRuns.issueId, issueId), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`))).limit(1)).length > 0;
    },
    /**
     * Take over a claim whose process stopped before it recorded any outcome.
     * Only once: the reclaimed mark is set atomically and never cleared.
     */
    async reclaimOwnerNudge(id: string, claimedBefore: Date) {
      return (await db.update(activityLog)
        .set({ details: sql`coalesce(${activityLog.details}, '{}'::jsonb) || ${JSON.stringify({ reclaimedAt: new Date().toISOString() })}::jsonb` })
        .where(and(eq(activityLog.id, id), lt(activityLog.createdAt, claimedBefore),
          sql`not (coalesce(${activityLog.details}, '{}'::jsonb) ?| array['ownerNudged','wakeError','reclaimedAt'])`))
        .returning({ id: activityLog.id })).length > 0;
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
