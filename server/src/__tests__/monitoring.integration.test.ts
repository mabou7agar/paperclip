import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import express from "express";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companyMemberships, companies, createDb, heartbeatRuns, issueRelations, issues, agentWakeupRequests } from "@paperclipai/db";
import { monitoringPolicySchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => ({ ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }) }));
import { isBoundedTaskContinuationMonitor, setTaskMonitorSchema } from "../services/issue-monitors.js";
import { monitoringService, monitoringAlertId, isMonitoringWake } from "../services/monitoring.js";
import { recoveryService } from "../services/recovery/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { monitoringRoutes } from "../routes/monitoring.js";

describe("monitoring execution boundary", () => {
  it("preserves defaults and rejects accidental modes or unknown settings", () => {
    expect(monitoringPolicySchema.parse({})).toEqual({ mode: "automatic" });
    expect(() => monitoringPolicySchema.parse({ mode: "off" })).toThrow();
    expect(() => monitoringPolicySchema.parse({ mode: "alert_only", wakeAgents: true })).toThrow();
  });
  it("separates observations from real user, review, quota and dependency events", () => {
    for (const reason of ["issue_disposition_repair", "issue_continuation_needed", "issue_monitor_due", "task_watchdog_stopped_subtree"])
      expect(isMonitoringWake({ source: "automation", reason })).toBe(true);
    expect(isMonitoringWake({ source: "automation", reason: "issue_blockers_resolved", context: { source: "issue_graph_liveness.backstop" } })).toBe(true);
    for (const reason of ["issue_commented", "issue_assigned", "provider_quota", "execution_review_participant_recovery", "issue_blockers_resolved"])
      expect(isMonitoringWake({ source: "automation", reason, context: { source: "workspace.finalize" } })).toBe(false);
    expect(isMonitoringWake({ source: "on_demand", reason: "issue_monitor_due" })).toBe(false);
  });
  it("requires explicit purpose, job identity and finite bounds for continuations", () => {
    const monitor = { kind: "task_continuation", serviceName: "Owned job", externalRef: "job-stage",
      nextCheckAt: "2027-01-01T12:00:00.000Z", timeoutAt: "2027-01-01T13:00:00.000Z", maxAttempts: 1, notes: "Read terminal result only" };
    expect(isBoundedTaskContinuationMonitor(monitor)).toBe(true);
    expect(setTaskMonitorSchema.parse({ idempotencyKey: "job-stage", monitor }).monitor?.kind).toBe("task_continuation");
    for (const key of ["serviceName", "externalRef", "timeoutAt", "maxAttempts"]) {
      const invalid = { ...monitor, [key]: null };
      expect(isBoundedTaskContinuationMonitor(invalid)).toBe(false);
      expect(() => setTaskMonitorSchema.parse({ idempotencyKey: "job-stage", monitor: invalid })).toThrow();
    }
    expect(isBoundedTaskContinuationMonitor({ ...monitor, kind: "external_service" })).toBe(false);
  });
  it("keys incidents by company and actual state", () => {
    const input = { companyId: "one", issueId: "task", kind: "dependency_ready" as const, fingerprint: "unchanged" };
    expect(monitoringAlertId(input)).toBe(monitoringAlertId({ ...input }));
    expect(monitoringAlertId(input)).not.toBe(monitoringAlertId({ ...input, companyId: "two" }));
    expect(monitoringAlertId(input)).not.toBe(monitoringAlertId({ ...input, fingerprint: "changed" }));
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("event-driven monitoring with real PostgreSQL and queue", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("monitoring-"); db = createDb(database.connectionString); }, 90000);
  afterEach(async () => { await heartbeatService(db).drainActiveRunExecutions(); await db.execute(sql`truncate companies cascade`); execute.mockReset(); });
  afterAll(async () => { await database?.cleanup(); });
  async function seed(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Monitoring", issuePrefix: `M${companyId.slice(0, 6)}`, defaultResponsibleUserId: "owner" });
    await db.insert(authUsers).values({ id: "owner", name: "Monitoring fixture owner", email: "monitoring-owner@example.invalid",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retain existing plan", status, assigneeAgentId: agentId, responsibleUserId: "owner" });
    await monitoringService(db).savePolicy(companyId, { mode: "alert_only" }, "owner");
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, invocationSource: "on_demand", runtimeMode: "legacy", status: "succeeded",
      startedAt: new Date(Date.now() - 120000), finishedAt: new Date(Date.now() - 60000), contextSnapshot: { issueId } });
    return { companyId, agentId, issueId, runId };
  }
  it("does not reset a repair episode or repeat alerts when new no-progress runs appear", async () => {
    const f = await seed(), enqueue = vi.fn(), recovery = recoveryService(db, { enqueueWakeup: enqueue });
    for (let i = 0; i < 4; i++) {
      const id = i ? randomUUID() : f.runId;
      if (i) await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        invocationSource: "automation", runtimeMode: "legacy", status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: f.issueId } });
      await Promise.all([recovery.reconcileLegacyContinuation(id), recoveryService(db, { enqueueWakeup: enqueue }).reconcileLegacyContinuation(id)]);
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
  });
  it("does not re-wake resolved blockers after the worker reblocks on the same problem", async () => {
    const f = await seed("blocked"), blocker = randomUUID(), enqueue = vi.fn();
    await db.insert(issues).values({ id: blocker, companyId: f.companyId, title: "Accepted review", status: "done" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker, relatedIssueId: f.issueId, type: "blocks" });
    for (let i = 0; i < 4; i++) {
      await db.update(issues).set({ blockedTransitionAt: new Date(Date.now() + i * 1000) }).where(eq(issues.id, f.issueId));
      await recoveryService(db, { enqueueWakeup: enqueue }).reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    }
    expect(enqueue).not.toHaveBeenCalled();
    expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });
  it("reports an orphan blocker without assigning it or waking its creator", async () => {
    const f = await seed("todo"), dependent = randomUUID(), enqueue = vi.fn();
    await db.update(issues).set({ assigneeAgentId: null, createdByAgentId: f.agentId }).where(eq(issues.id, f.issueId));
    await db.insert(issues).values({ id: dependent, companyId: f.companyId, title: "Waiting task", status: "blocked" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.issueId, relatedIssueId: dependent, type: "blocks" });
    for (let i = 0; i < 4; i++) await recoveryService(db, { enqueueWakeup: enqueue }).reconcileStrandedAssignedIssues();
    expect(enqueue).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].assigneeAgentId).toBeNull();
    expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(1);
  });
  it("delivers a real finalization event once and preserves the source task", async () => {
    const f = await seed("blocked"), blocker = randomUUID(), heartbeat = heartbeatService(db);
    await db.insert(issues).values({ id: blocker, companyId: f.companyId, title: "Accepted review", status: "done" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker, relatedIssueId: f.issueId, type: "blocks" });
    execute.mockImplementation(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Consumed review and existing planning context", provider: "test", model: "test-model" };
    });
    const recovery = recoveryService(db, { enqueueWakeup: heartbeat.wakeup });
    await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId, blockerIssueId: blocker, source: "workspace.finalize" });
    await heartbeat.drainActiveRunExecutions();
    for (let i = 0; i < 3; i++) await recovery.reconcileResolvedDependencyWakeBackstop({ companyId: f.companyId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
  }, 30000);
  it("guards queued and fresh monitoring turns while allowing explicit owner control", async () => {
    const f = await seed(), heartbeat = heartbeatService(db);
    for (let i = 0; i < 4; i++) expect(await heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_disposition_repair",
      payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_disposition_repair" } })).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(1);
    const queued = randomUUID();
    await db.insert(heartbeatRuns).values({ id: queued, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, status: "queued", invocationSource: "automation",
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_disposition_repair" } });
    await heartbeat.resumeQueuedRunsForAgent(f.companyId, f.agentId);
    await heartbeat.drainActiveRunExecutions();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued)))[0]).toMatchObject({ status: "cancelled", errorCode: "monitoring_alert_only" });
    expect(execute).not.toHaveBeenCalled();
    execute.mockImplementation(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, provider: "test", model: "test-model" };
    });
    await heartbeat.wakeup(f.agentId, { source: "on_demand", reason: "issue_disposition_repair", payload: { issueId: f.issueId } });
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
  }, 30000);
  it("deduplicates concurrent observations across service instances and respects company scope", async () => {
    const f = await seed(), input = { companyId: f.companyId, issueId: f.issueId, kind: "monitor_due" as const, fingerprint: "one" };
    await Promise.all(Array.from({ length: 12 }, () => monitoringService(db).observe(input)));
    expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(1);
    await monitoringService(db).observe({ ...input, fingerprint: "two" });
    expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(2);
    const foreign = await seed();
    await monitoringService(db).observe({ ...input, companyId: foreign.companyId });
    expect(await monitoringService(db).alerts(foreign.companyId)).toHaveLength(0);
  });
  it("keeps due monitor sweeps alert-only without incrementing attempts or starting providers", async () => {
    const f = await seed(), due = new Date(Date.now() - 60000), heartbeat = heartbeatService(db);
    await db.update(issues).set({ monitorNextCheckAt: due, monitorNotes: "Verify an unchanged outage",
      executionPolicy: { monitor: { nextCheckAt: due.toISOString(), notes: "Verify an unchanged outage", maxAttempts: 3 } } }).where(eq(issues.id, f.issueId));
    for (let i = 0; i < 3; i++) await heartbeat.tickTimers(new Date(Date.now() + i * 3600000));
    expect(execute).not.toHaveBeenCalled();
    expect(await monitoringService(db).alerts(f.companyId)).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ monitorAttemptCount: 0, monitorWakeRequestedAt: null });
  }, 30000);
  it("round-trips the policy through actual curl and rejects unauthorized writes", async () => {
    const f = await seed(), app = express(); let role = "owner", actorType = "board", companyIds = [f.companyId];
    app.use(express.json()); app.use((req, _res, next) => { req.actor = { type: actorType, source: "session", userId: "owner", companyIds,
      memberships: [{ companyId: f.companyId, membershipRole: role, status: "active" }] } as never; next(); });
    app.use("/api", monitoringRoutes(db));
    app.use((e: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(e.name === "ZodError" ? 400 : e.status ?? 500).json({ error: e.message }));
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/api/v1/companies/${f.companyId}/monitoring`;
    async function curl(method = "GET", body?: unknown) {
      const args = ["-sS", "--max-time", "10", "-w", "\n%{http_code}", "-X", method, url];
      if (body) args.push("-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
      const { stdout } = await promisify(execFile)("curl", args); const lines = stdout.trim().split("\n"); return { status: Number(lines.pop()), body: JSON.parse(lines.join("\n")) };
    }
    try {
      expect((await curl()).body.policy).toEqual({ mode: "alert_only" });
      expect((await curl("PUT", { mode: "automatic" })).status).toBe(200);
      expect((await curl()).body.policy.mode).toBe("automatic");
      expect((await curl("PUT", { mode: "bad" })).status).toBe(400);
      role = "viewer"; expect((await curl("PUT", { mode: "alert_only" })).status).toBe(403);
      role = "member"; expect((await curl("PUT", { mode: "alert_only" })).status).toBe(403);
      actorType = "agent"; expect((await curl()).status).toBe(403);
      actorType = "board"; companyIds = []; expect((await curl()).status).toBe(403);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
