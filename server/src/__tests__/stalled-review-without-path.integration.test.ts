import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.ts", async () => ({ ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }) }));
import { monitoringService, MONITORING_OWNER_NUDGE_REASON, settleMonitoringOwnerNudges } from "../services/monitoring.js";
import { heartbeatService } from "../services/heartbeat.js";

// An agent moved its own task to in_review with no review stage and nothing
// else maintains it. Stranded recovery used to skip it silently, so
// alert-only monitoring never saw it and never nudged anyone.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("in-review task without a review path", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("stalled-review-"); db = createDb(database.connectionString); }, 90000);
  afterEach(async () => {
    await settleMonitoringOwnerNudges();
    await heartbeatService(db).drainActiveRunExecutions();
    await db.execute(sql`truncate companies cascade`);
    execute.mockReset();
  });
  afterAll(async () => { await database?.cleanup(); });

  async function seed(options: { mode?: string; executionPolicy?: Record<string, unknown>; executionState?: Record<string, unknown> } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "owner" });
    await db.insert(authUsers).values({ id: "owner", name: "Review fixture owner", email: "review-owner@example.invalid",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Digest writer", status: "idle", adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Daily digest left in review", status: "in_review",
      assigneeAgentId: agentId, responsibleUserId: "owner", statusVersion: 2,
      ...(options.executionPolicy ? { executionPolicy: options.executionPolicy } : {}),
      ...(options.executionState ? { executionState: options.executionState } : {}) });
    await monitoringService(db).savePolicy(companyId, { mode: options.mode ?? "alert_only" }, "owner");
    return { companyId, agentId, issueId };
  }
  const reviewAlerts = (companyId: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
    eq(activityLog.action, "monitoring.alert"), sql`${activityLog.details}->>'fingerprint' like '["review_without_path"%'`));
  const nudgeWakes = (companyId: string) => db.select().from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, MONITORING_OWNER_NUDGE_REASON)));
  async function reconcile(companyId: string) {
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId });
    await settleMonitoringOwnerNudges();
    await heartbeatService(db).drainActiveRunExecutions();
  }
  function succeed() {
    execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      summary: "Closed the digest", provider: "test", model: "test-model" }));
  }

  it("reports a stalled review with no review stage, and the assignee is nudged once", async () => {
    const f = await seed(); succeed();
    await reconcile(f.companyId);
    await reconcile(f.companyId);
    await reconcile(f.companyId);
    const alerts = await reviewAlerts(f.companyId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details).toMatchObject({ kind: "no_execution_path", fingerprint: JSON.stringify(["review_without_path", 2]) });
    const wakes = await nudgeWakes(f.companyId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: f.agentId });
    expect(wakes[0].runId).toBeTruthy();
    // The nudged run ended with the task still in review and no path (the
    // fixture adapter changes nothing), so the product's existing one-shot
    // review-path-lost recovery gives the assignee one explicit follow-up.
    // Nothing else runs, however often recovery passes again.
    const followUps = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.reason, "issue_review_path_lost")));
    expect(followUps).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(2);
  }, 60000);

  it("re-entering review is a new alert, but the per-task window still allows one nudge a day", async () => {
    const f = await seed(); succeed();
    await reconcile(f.companyId);
    await db.update(issues).set({ status: "in_review", statusVersion: 5 }).where(eq(issues.id, f.issueId));
    await reconcile(f.companyId);
    expect((await reviewAlerts(f.companyId)).length).toBeGreaterThanOrEqual(1);
    expect(await nudgeWakes(f.companyId)).toHaveLength(1);
  }, 60000);

  it("changes nothing outside alert-only mode", async () => {
    const f = await seed({ mode: "automatic" }); succeed();
    await reconcile(f.companyId);
    expect(await reviewAlerts(f.companyId)).toHaveLength(0);
    expect(await nudgeWakes(f.companyId)).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  }, 60000);

  it("leaves a human review stage alone", async () => {
    const stageId = randomUUID();
    const f = await seed({
      executionPolicy: { mode: "normal", commentRequired: true,
        stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "user", userId: "owner", agentId: null }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "user", userId: "owner", agentId: null }, returnAssignee: null, completedStageIds: [],
        lastDecisionId: null, lastDecisionOutcome: null, monitor: null, reviewRequest: null },
    });
    succeed();
    await reconcile(f.companyId);
    expect(await reviewAlerts(f.companyId)).toHaveLength(0);
    expect(await nudgeWakes(f.companyId)).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  }, 60000);
});
