import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns,
  issues, issueThreadInteractions, issueTreeHoldMembers, issueTreeHolds,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => ({ ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }) }));
import {
  isMonitoringWake, monitoringAlertId, monitoringOwnerNudgeId, monitoringService, MONITORING_OWNER_NUDGE_REASON, ownerNudgeRepeatDue,
  settleMonitoringOwnerNudges,
} from "../services/monitoring.js";
import { heartbeatService } from "../services/heartbeat.js";

describe("monitoring owner nudge reason", () => {
  it("is not a monitoring wake, so holdWake never matches it", () => {
    expect(isMonitoringWake({ source: "automation", reason: MONITORING_OWNER_NUDGE_REASON })).toBe(false);
    expect(isMonitoringWake({ source: "automation", reason: MONITORING_OWNER_NUDGE_REASON,
      context: { source: "monitoring.owner_nudge" } })).toBe(false);
  });
});

describe("repeat owner nudge schedule", () => {
  const minute = 60 * 1000, now = Date.parse("2026-11-24T20:39:00Z");
  const ago = (...minutes: number[]) => minutes.map(m => new Date(now - m * minute));
  it("waits 15 min, 1 h, 4 h, then 12 h after each nudge", () => {
    expect(ownerNudgeRepeatDue([], now)).toBe(true);
    expect(ownerNudgeRepeatDue(ago(14), now)).toBe(false);
    expect(ownerNudgeRepeatDue(ago(15), now)).toBe(true);
    expect(ownerNudgeRepeatDue(ago(59, 120), now)).toBe(false);
    expect(ownerNudgeRepeatDue(ago(60, 120), now)).toBe(true);
    expect(ownerNudgeRepeatDue(ago(239, 300, 400), now)).toBe(false);
    expect(ownerNudgeRepeatDue(ago(240, 300, 400), now)).toBe(true);
    expect(ownerNudgeRepeatDue(ago(719, 800, 900, 1000), now)).toBe(false);
    expect(ownerNudgeRepeatDue(ago(720, 800, 900, 1000), now)).toBe(true);
  });
  it("stops at six nudges per task inside the window, whatever their age", () => {
    expect(ownerNudgeRepeatDue(ago(1000, 1100, 1200, 1300, 1400), now)).toBe(true);
    expect(ownerNudgeRepeatDue(ago(1000, 1100, 1200, 1300, 1400, 1430), now)).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("alert-only owner nudge with real PostgreSQL and queue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("monitoring-nudge-"); db = createDb(database.connectionString); }, 90000);
  afterEach(async () => {
    await settleMonitoringOwnerNudges();
    await heartbeatService(db).drainActiveRunExecutions();
    await db.execute(sql`truncate companies cascade`);
    execute.mockReset();
  });
  afterAll(async () => { await database?.cleanup(); });

  async function seed(options: { status?: string; agentStatus?: string; mode?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Monitoring", issuePrefix: `N${companyId.slice(0, 6)}`, defaultResponsibleUserId: "owner" });
    await db.insert(authUsers).values({ id: "owner", name: "Monitoring fixture owner", email: "monitoring-owner@example.invalid",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: options.agentStatus ?? "idle", adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task left without a next step", status: options.status ?? "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "owner" });
    await monitoringService(db).savePolicy(companyId, { mode: options.mode ?? "alert_only" }, "owner");
    return { companyId, agentId, issueId };
  }
  const nudgeWakes = (companyId: string) => db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, MONITORING_OWNER_NUDGE_REASON)));
  const nudgeRecords = (companyId: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "monitoring.owner_nudge")));
  async function settle() { await settleMonitoringOwnerNudges(); await heartbeatService(db).drainActiveRunExecutions(); }
  function succeed() {
    execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      summary: "Recorded the next step", provider: "test", model: "test-model" }));
  }

  it("wakes an invokable assignee once for a new alert, and the run is claimed and executed", async () => {
    const f = await seed(); succeed();
    const observation = { companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path" as const, fingerprint: "stuck-1" };
    expect(await monitoringService(db).observe(observation)).toBe(true);
    await settle();

    const wakes = await nudgeWakes(f.companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: f.agentId, source: "automation", requestedByActorId: "monitoring",
      idempotencyKey: `monitoring-owner-nudge:${monitoringAlertId(observation)}` });
    expect(wakes[0].status).not.toBe("skipped");
    expect(wakes[0].runId).toBeTruthy();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wakes[0].runId!));
    expect(run).toMatchObject({ status: "succeeded", wakeupRequestId: wakes[0].id, issueId: f.issueId });
    expect(run.errorCode).not.toBe("monitoring_alert_only");
    expect(run.contextSnapshot).toMatchObject({ issueId: f.issueId, taskId: f.issueId, wakeReason: MONITORING_OWNER_NUDGE_REASON,
      monitoringAlertId: monitoringAlertId(observation), monitoringAlertKind: "no_execution_path" });
    expect(execute).toHaveBeenCalledTimes(1);
    // holdWake does not hold it at enqueue or claim.
    expect(await monitoringService(db).holdWake({ companyId: f.companyId, issueId: f.issueId, source: "automation",
      reason: MONITORING_OWNER_NUDGE_REASON, context: run.contextSnapshot as Record<string, unknown> })).toBe(false);

    const records = await nudgeRecords(f.companyId);
    expect(records).toHaveLength(1);
    expect(records[0].details).toMatchObject({ alertId: monitoringAlertId(observation), kind: "no_execution_path",
      ownerNudged: true, wakeupRequestId: wakes[0].id, runId: run.id });
  }, 30000);

  it("nudges once when an alert recorded before nudging existed is observed again", async () => {
    const f = await seed(); succeed();
    const observation = { companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path" as const, fingerprint: "stuck-before" };
    // The alert row a task already stuck before this release carries.
    await db.insert(activityLog).values({ id: monitoringAlertId(observation), companyId: f.companyId, actorType: "system",
      actorId: "monitoring", action: "monitoring.alert", entityType: "issue", entityId: f.issueId, responsibleUserId: "owner",
      details: { ...observation, alertId: monitoringAlertId(observation), reportOnly: true } });
    expect(await monitoringService(db).observe(observation)).toBe(true);
    await settle();
    await monitoringService(db).observe(observation);
    await settle();
    const wakes = await nudgeWakes(f.companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].runId).toBeTruthy();
    expect(await nudgeRecords(f.companyId)).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  }, 30000);

  it("does not nudge an agent parked on an unknown provider quota reset, or a chat conversation", async () => {
    const quota = await seed(); succeed();
    await monitoringService(db).observe({ companyId: quota.companyId, issueId: quota.issueId, kind: "no_execution_path",
      fingerprint: JSON.stringify(["provider_quota_reset_unknown", quota.agentId, randomUUID()]) });
    const chat = await seed();
    // An active (not waiting) conversation: the heartbeat's own gates would let this one through.
    await db.update(issues).set({ conversationAgentId: chat.agentId, conversationUserId: "owner", conversationState: "active" })
      .where(eq(issues.id, chat.issueId));
    await monitoringService(db).observe({ companyId: chat.companyId, issueId: chat.issueId, kind: "no_execution_path", fingerprint: "chat" });
    await settle();
    expect(await nudgeWakes(quota.companyId)).toHaveLength(0);
    expect(await nudgeRecords(quota.companyId)).toHaveLength(0);
    expect(await nudgeWakes(chat.companyId)).toHaveLength(0);
    expect(await nudgeRecords(chat.companyId)).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  }, 30000);

  it("takes over a claim whose process stopped before waking, once, and only after the grace period", async () => {
    const f = await seed(); succeed();
    const fresh = { companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path" as const, fingerprint: "lost-fresh" };
    const stale = { ...fresh, fingerprint: "lost-stale" };
    const claimRow = (observation: typeof fresh, ageMs: number) => db.insert(activityLog).values({
      id: monitoringOwnerNudgeId(monitoringAlertId(observation)), companyId: f.companyId, actorType: "system", actorId: "monitoring",
      action: "monitoring.owner_nudge", entityType: "issue", entityId: f.issueId, agentId: f.agentId, responsibleUserId: "owner",
      details: { alertId: monitoringAlertId(observation) }, createdAt: new Date(Date.now() - ageMs) });
    // A claim two minutes old with no outcome may still be in flight: leave it.
    await claimRow(fresh, 2 * 60 * 1000);
    await monitoringService(db).observe(fresh);
    await settle();
    expect(await nudgeWakes(f.companyId)).toHaveLength(0);
    // A claim twenty minutes old with no outcome and no wake was lost.
    await db.delete(activityLog).where(eq(activityLog.id, monitoringOwnerNudgeId(monitoringAlertId(fresh))));
    await claimRow(stale, 20 * 60 * 1000);
    await monitoringService(db).observe(stale);
    await settle();
    await monitoringService(db).observe(stale);
    await settle();
    const wakes = await nudgeWakes(f.companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].runId).toBeTruthy();
    const [record] = await db.select().from(activityLog).where(eq(activityLog.id, monitoringOwnerNudgeId(monitoringAlertId(stale))));
    expect(record.details).toMatchObject({ ownerNudged: true, wakeupRequestId: wakes[0].id, reclaimedAt: expect.any(String) });
    expect(execute).toHaveBeenCalledTimes(1);
  }, 30000);

  it("does not nudge twice for the same alert or for a new fingerprint within 24 hours", async () => {
    const f = await seed(); succeed();
    const observation = { companyId: f.companyId, issueId: f.issueId, kind: "missing_disposition" as const, fingerprint: "one" };
    await Promise.all(Array.from({ length: 6 }, () => monitoringService(db).observe(observation)));
    await settle();
    await monitoringService(db).observe(observation);
    await settle();
    expect(await nudgeWakes(f.companyId)).toHaveLength(1);
    await monitoringService(db).observe({ ...observation, fingerprint: "two" });
    await monitoringService(db).observe({ ...observation, kind: "no_execution_path", fingerprint: "three" });
    await settle();
    // Three observed alerts plus the one recovery raised after the nudged run
    // ended without a disposition (a new fingerprint), none of which re-nudge.
    expect((await monitoringService(db).alerts(f.companyId)).length).toBeGreaterThanOrEqual(3);
    expect(await nudgeWakes(f.companyId)).toHaveLength(1);
    expect(await nudgeRecords(f.companyId)).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  }, 30000);

  it("nudges again only after the 24 hour window has passed", async () => {
    const f = await seed(); succeed();
    await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path", fingerprint: "a" });
    await settle();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.update(activityLog).set({ createdAt: old }).where(eq(activityLog.action, "monitoring.owner_nudge"));
    await db.update(agentWakeupRequests).set({ requestedAt: old }).where(eq(agentWakeupRequests.reason, MONITORING_OWNER_NUDGE_REASON));
    await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path", fingerprint: "b" });
    await settle();
    expect(await nudgeWakes(f.companyId)).toHaveLength(2);
  }, 30000);

  it("nudges a persisting no_execution_path again after an earlier alert used the single nudge, on the backoff schedule", async () => {
    const f = await seed(); succeed();
    await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "missing_disposition", fingerprint: "earlier" });
    await settle();
    expect(await nudgeWakes(f.companyId)).toHaveLength(1);
    // The CTO incident: the only nudge went to missing_disposition 20 minutes earlier.
    const earlier = new Date(Date.now() - 20 * 60 * 1000);
    await db.update(activityLog).set({ createdAt: earlier }).where(eq(activityLog.action, "monitoring.owner_nudge"));
    await db.update(agentWakeupRequests).set({ requestedAt: earlier }).where(eq(agentWakeupRequests.reason, MONITORING_OWNER_NUDGE_REASON));
    // Another missing_disposition alert keeps the single 24 hour rule.
    await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "missing_disposition", fingerprint: "later" });
    await settle();
    expect(await nudgeWakes(f.companyId)).toHaveLength(1);
    const observation = { companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path" as const, fingerprint: "build-machine" };
    await Promise.all(Array.from({ length: 4 }, () => monitoringService(db).observe(observation)));
    await settle();
    expect(await nudgeWakes(f.companyId)).toHaveLength(2);
    expect(await monitoringService(db).ownerNudgeSettled(observation)).toBe(true);
    // The same alert, still present: not again inside the 1 hour backoff.
    await monitoringService(db).observe(observation);
    await settle();
    expect(await nudgeWakes(f.companyId)).toHaveLength(2);
    // Past the backoff, the same alert nudges a third time.
    const older = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.update(activityLog).set({ createdAt: older }).where(eq(activityLog.action, "monitoring.owner_nudge"));
    expect(await monitoringService(db).ownerNudgeSettled(observation)).toBe(false);
    await monitoringService(db).observe(observation);
    await settle();
    const wakes = await nudgeWakes(f.companyId);
    expect(wakes).toHaveLength(3);
    expect(new Set(wakes.map(wake => wake.idempotencyKey)).size).toBe(3);
    expect(execute).toHaveBeenCalledTimes(3);
  }, 30000);

  it("does not repeat a nudge while an owner question card is pending on the task", async () => {
    const f = await seed(); succeed();
    await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "missing_disposition", fingerprint: "earlier" });
    await settle();
    const earlier = new Date(Date.now() - 30 * 60 * 1000);
    await db.update(activityLog).set({ createdAt: earlier }).where(eq(activityLog.action, "monitoring.owner_nudge"));
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "ask_user_questions",
      status: "pending", payload: { version: 1, questions: [] } as never });
    await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path", fingerprint: "waiting" });
    await settle();
    expect(await nudgeWakes(f.companyId)).toHaveLength(1);
  }, 30000);

  it("converts a held recovery wake into one owner nudge that is delivered", async () => {
    const f = await seed(); succeed();
    const heartbeat = heartbeatService(db);
    for (let i = 0; i < 3; i++) expect(await heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_disposition_repair",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_disposition_repair" } })).toBeNull();
    await settle();
    // The nudged run ended without a disposition, so recovery raised a new
    // missing_disposition alert; the 24 hour bound stops a second nudge.
    expect((await monitoringService(db).alerts(f.companyId)).map(a => (a.details as { kind: string }).kind).sort())
      .toEqual(["missing_disposition", "no_execution_path"]);
    expect(await nudgeWakes(f.companyId)).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded" });
    expect((runs[0].contextSnapshot as Record<string, unknown>).wakeReason).toBe(MONITORING_OWNER_NUDGE_REASON);
    expect(execute).toHaveBeenCalledTimes(1);
  }, 30000);

  it("does not nudge a paused, terminated or pending-approval assignee", async () => {
    for (const agentStatus of ["paused", "terminated", "pending_approval"]) {
      const f = await seed({ agentStatus });
      expect(await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path", fingerprint: "x" })).toBe(true);
      await settle();
      expect(await nudgeWakes(f.companyId)).toHaveLength(0);
      expect(await nudgeRecords(f.companyId)).toHaveLength(0);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not nudge unassigned or user-assigned tasks, or backlog tasks", async () => {
    const unassigned = await seed();
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, unassigned.issueId));
    const userAssigned = await seed();
    await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "owner" }).where(eq(issues.id, userAssigned.issueId));
    const backlog = await seed({ status: "backlog" });
    for (const f of [unassigned, userAssigned, backlog]) {
      expect(await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "missing_disposition", fingerprint: "x" })).toBe(true);
      await settle();
      expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(1);
      expect(await nudgeWakes(f.companyId)).toHaveLength(0);
      expect(await nudgeRecords(f.companyId)).toHaveLength(0);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not nudge a task inside an active tree hold", async () => {
    // Direct member of an active cancel hold.
    const member = await seed();
    const memberRoot = randomUUID();
    await db.insert(issues).values({ id: memberRoot, companyId: member.companyId, title: "Held root", status: "in_progress" });
    const [cancelHold] = await db.insert(issueTreeHolds).values({ companyId: member.companyId, rootIssueId: memberRoot, mode: "cancel" }).returning();
    await db.insert(issueTreeHoldMembers).values({ companyId: member.companyId, holdId: cancelHold.id, issueId: member.issueId,
      issueTitle: "Task left without a next step", issueStatus: "in_progress" });
    // Descendant of an active pause hold root, with no member row.
    const descendant = await seed();
    const pauseRoot = randomUUID();
    await db.insert(issues).values({ id: pauseRoot, companyId: descendant.companyId, title: "Paused root", status: "in_progress" });
    await db.update(issues).set({ parentId: pauseRoot }).where(eq(issues.id, descendant.issueId));
    await db.insert(issueTreeHolds).values({ companyId: descendant.companyId, rootIssueId: pauseRoot, mode: "pause" });
    for (const f of [member, descendant]) {
      await monitoringService(db).observe({ companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path", fingerprint: "x" });
      await settle();
      expect(await nudgeWakes(f.companyId)).toHaveLength(0);
      expect(await nudgeRecords(f.companyId)).toHaveLength(0);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("does nothing outside alert-only mode and for other alert kinds", async () => {
    const automatic = await seed({ mode: "automatic" });
    expect(await monitoringService(db).observe({ companyId: automatic.companyId, issueId: automatic.issueId, kind: "no_execution_path", fingerprint: "x" })).toBe(false);
    await settle();
    expect(await monitoringService(db).alerts(automatic.companyId)).toHaveLength(0);
    expect(await nudgeWakes(automatic.companyId)).toHaveLength(0);
    expect(await nudgeRecords(automatic.companyId)).toHaveLength(0);

    const other = await seed();
    for (const kind of ["dependency_ready", "monitor_due", "stopped_subtree"] as const)
      expect(await monitoringService(db).observe({ companyId: other.companyId, issueId: other.issueId, kind, fingerprint: "x" })).toBe(true);
    await settle();
    expect(await monitoringService(db).alerts(other.companyId)).toHaveLength(3);
    expect(await nudgeWakes(other.companyId)).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("records the alert but does not nudge from a caller's transaction handle", async () => {
    const f = await seed();
    const wakeup = vi.fn(async () => null);
    await expect(db.transaction(tx => monitoringService(tx as unknown as typeof db, { wakeup })
      .observe({ companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path", fingerprint: "tx" }))).resolves.toBe(true);
    await settleMonitoringOwnerNudges();
    expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(1);
    expect(wakeup).not.toHaveBeenCalled();
    expect(await nudgeRecords(f.companyId)).toHaveLength(0);
  });

  it("never throws from observe or changes its result when the nudge fails", async () => {
    const f = await seed();
    const wakeup = vi.fn(async () => { throw new Error("queue unavailable"); });
    const observation = { companyId: f.companyId, issueId: f.issueId, kind: "no_execution_path" as const, fingerprint: "x" };
    await expect(monitoringService(db, { wakeup }).observe(observation)).resolves.toBe(true);
    await expect(settleMonitoringOwnerNudges()).resolves.toBeUndefined();
    expect(wakeup).toHaveBeenCalledTimes(1);
    const [record] = await nudgeRecords(f.companyId);
    expect(record.details).toMatchObject({ ownerNudged: false, wakeError: "queue unavailable" });
    // The failed attempt still consumes the window: no retry loop.
    await monitoringService(db, { wakeup }).observe({ ...observation, fingerprint: "y" });
    await settleMonitoringOwnerNudges();
    expect(wakeup).toHaveBeenCalledTimes(1);
  });
});
