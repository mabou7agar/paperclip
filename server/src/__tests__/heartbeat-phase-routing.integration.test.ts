import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentTaskSessions, companies, createDb, heartbeatRuns, heartbeatRunEvents, issues } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { phaseRoutingSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn<(ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>>(), select: vi.fn() }));
vi.mock("../adapters/index.ts", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mocks.execute })),
}));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ select: mocks.select }) }));
vi.mock("../services/ai-connection-runtime.js", async () => ({
  ...await vi.importActual<typeof import("../services/ai-connection-runtime.js")>("../services/ai-connection-runtime.js"),
  prepareManagedAiRuntime: vi.fn(async (_db, input) => ({
    config: input.config,
    attribution: { provider: input.binding.provider, method: input.binding.method, connectionId: input.binding.connectionId, grantId: input.binding.grantId },
    identity: `${input.binding.grantId}:user:fake`, sessionIdentity: `${input.binding.grantId}:user:fake`,
    accountName: "Fake isolated account", cleanup: async () => {},
  })),
}));
import { heartbeatService } from "../services/heartbeat.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { phaseRoutingSettingsRepository } from "../repositories/phase-routing-settings.js";

const support = await getEmbeddedPostgresTestSupport();
const claudeId = "10000000-0000-4000-8000-000000000001";
const codexId = "10000000-0000-4000-8000-000000000002";
const grantId = "20000000-0000-4000-8000-000000000001";
const claude = { id: "claude", adapterType: "claude_local", model: "claude-test", binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" } };
const codex = { id: "codex", adapterType: "codex_local", model: "codex-test", binding: { provider: "openai", method: "subscription", mode: "responsible_user" } };
const policy = phaseRoutingSchema.parse({ enabled: true, planning: [claude, codex], implementation: [codex] });

async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Expected routing outcome did not arrive");
}

(support.supported ? describe : describe.skip)("phase routing through the durable heartbeat queue", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-phase-routing-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, 90_000);
  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    mocks.execute.mockReset();
    mocks.select.mockReset();
  });
  afterAll(async () => { await database?.cleanup(); });

  async function seed(workMode: "standard" | "planning" = "standard") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Phase routing", issuePrefix: `P${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active", adapterType: "claude_local",
      adapterConfig: { model: "claude-test", command: "must-not-leak" }, permissions: {},
      runtimeConfig: { phaseRouting: policy, heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Routed task", status: "todo", workMode, assigneeAgentId: agentId, responsibleUserId: "user" });
    mocks.select.mockImplementation(async ({ binding }) => ({
      connection: { id: binding.provider === "anthropic" ? claudeId : binding.provider === "openai" ? codexId : "10000000-0000-4000-8000-000000000003" }, grant: { id: grantId, kind: "user" },
      attribution: { provider: binding.provider, method: binding.method },
    }));
    return { companyId, agentId, issueId };
  }
  function wake(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned", payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
  }
  const success = (sessionId = randomUUID()): AdapterExecutionResult => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Finished fake run", provider: "test", model: "test", sessionId, sessionParams: { sessionId } });

  it("claims Codex for implementation while preserving the agent's configured identity", async () => {
    const { agentId, issueId } = await seed();
    mocks.execute.mockImplementation(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return success();
    });
    const run = await wake(agentId, issueId);
    await eventually(async () => mocks.execute.mock.calls.length === 1);
    await heartbeat.drainActiveRunExecutions();
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(saved.status).toBe("succeeded");
    expect(saved.runnerProfileJson?.adapterDispatch).toMatchObject({ adapterType: "codex_local", agentAdapterType: "claude_local", phaseRoute: { phase: "implementation" } });
    const ctx = mocks.execute.mock.calls[0][0];
    expect(ctx.agent.adapterType).toBe("codex_local");
    expect(ctx.config.model).toBe("codex-test");
    expect(ctx.config.command).toBeUndefined();
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0].adapterType).toBe("claude_local");
  }, 30_000);

  it("falls back once after Claude quota and records a shared connection cooldown", async () => {
    const { companyId, agentId, issueId } = await seed("planning");
    mocks.execute.mockImplementation(async ctx => {
      if (ctx.agent.adapterType === "claude_local") return { ...success(), exitCode: 1, errorMessage: "Provider quota exhausted", errorFamily: "provider_quota", retryNotBefore: new Date(Date.now() + 3_600_000).toISOString() };
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return success();
    });
    await wake(agentId, issueId);
    await eventually(async () => (await db.select().from(heartbeatRuns)).some(run => run.status === "scheduled_retry"));
    await heartbeat.drainActiveRunExecutions();
    const promoted = await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 2_000));
    await heartbeat.resumeQueuedRuns();
    try { await eventually(async () => mocks.execute.mock.calls.length === 2); }
    catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}: ${JSON.stringify({ promoted, runs: await db.select({ status: heartbeatRuns.status, error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode, reason: heartbeatRuns.scheduledRetryReason, at: heartbeatRuns.scheduledRetryAt }).from(heartbeatRuns), issue: await db.select({ status: issues.status }).from(issues), agent: await db.select({ status: agents.status }).from(agents) })}`);
    }
    await heartbeat.drainActiveRunExecutions();
    expect(mocks.execute.mock.calls.map(([ctx]) => ctx.agent.adapterType)).toEqual(["claude_local", "codex_local"]);
    expect(mocks.execute.mock.calls[1][0].runtime.sessionParams).toBeNull();
    const receipts = await db.select().from(heartbeatRuns);
    expect(receipts.filter(run => run.scheduledRetryReason === "phase_quota_fallback")).toHaveLength(1);
    expect(await providerQuotaRepository(db).latestEvidence(companyId, claudeId, new Date())).toMatchObject({ status: "failed" });
    // A second task uses the cooldown across task sessions, without calling Claude.
    const secondIssueId = randomUUID();
    await db.insert(issues).values({ id: secondIssueId, companyId, title: "Second plan", status: "todo", workMode: "planning", assigneeAgentId: agentId, responsibleUserId: "user" });
    heartbeat = heartbeatService(db); // A restart must not forget the account cooldown.
    await wake(agentId, secondIssueId);
    await eventually(async () => mocks.execute.mock.calls.length === 3);
    await heartbeat.drainActiveRunExecutions();
    expect(mocks.execute.mock.calls[2][0].agent.adapterType).toBe("codex_local");
  }, 30_000);

  it("uses saved company defaults when the agent has no override", async () => {
    const { companyId, agentId, issueId } = await seed();
    await phaseRoutingSettingsRepository(db).save(companyId, policy);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, agentId));
    mocks.execute.mockImplementation(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId)); return success();
    });
    await wake(agentId, issueId);
    await eventually(async () => mocks.execute.mock.calls.length === 1);
    await heartbeat.drainActiveRunExecutions();
    expect(mocks.execute.mock.calls[0][0].agent.adapterType).toBe("codex_local");
  }, 30_000);

  it("parks exhausted phases without starting a provider", async () => {
    const { companyId, agentId, issueId } = await seed("planning");
    const retryAt = new Date(Date.now() + 3_600_000).toISOString();
    for (const connectionId of [claudeId, codexId]) await db.insert(heartbeatRuns).values({
      companyId, agentId, scopeKind: "issue", issueId, invocationSource: "assignment", status: "failed",
      finishedAt: new Date(), errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota", retryNotBefore: retryAt },
      contextSnapshot: { issueId, aiConnection: { connectionId } },
    });
    // An in-flight request finishing successfully must not erase a quota
    // cooldown established by another worker on the same account.
    await db.insert(heartbeatRuns).values({ companyId, agentId, scopeKind: "issue", issueId,
      invocationSource: "assignment", status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { issueId, aiConnection: { connectionId: claudeId } },
    });
    const run = await wake(agentId, issueId);
    await eventually(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]?.status === "cancelled");
    await heartbeat.drainActiveRunExecutions();
    expect(mocks.execute).not.toHaveBeenCalled();
    const runs = await db.select().from(heartbeatRuns);
    expect(runs.find(saved => saved.id === run!.id)?.resultJson).toMatchObject({ executionRecovery: { providerWorkStarted: false }, cancellation: { expected: true } });
    const events = await db.select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run!.id));
    expect(runs.filter(saved => saved.status === "scheduled_retry"), JSON.stringify(events)).toHaveLength(1);
  }, 30_000);

  it("walks three ordered levels after two quota errors", async () => {
    const { agentId, issueId } = await seed("planning");
    const glm = { id: "glm", adapterType: "opencode_local", model: "openrouter/z-ai/glm-test", binding: { provider: "openrouter", method: "api_key", mode: "responsible_user" } };
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true }, phaseRouting: phaseRoutingSchema.parse({ ...policy, planning: [claude, codex, glm] }) } }).where(eq(agents.id, agentId));
    mocks.execute.mockImplementation(async ctx => {
      if (ctx.agent.adapterType !== "opencode_local") return { ...success(), exitCode: 1, errorMessage: "Quota", errorFamily: "provider_quota", retryNotBefore: new Date(Date.now() + 3_600_000).toISOString() };
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId)); return success();
    });
    await wake(agentId, issueId);
    for (let level = 1; level <= 2; level++) {
      await eventually(async () => (await db.select().from(heartbeatRuns)).some(run => run.status === "scheduled_retry" && run.scheduledRetryAttempt === level));
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 2_000));
      await heartbeat.resumeQueuedRuns();
      await eventually(async () => mocks.execute.mock.calls.length === level + 1);
      await heartbeat.drainActiveRunExecutions();
    }
    expect(mocks.execute.mock.calls.map(([ctx]) => ctx.agent.adapterType)).toEqual(["claude_local", "codex_local", "opencode_local"]);
    expect((await db.select().from(heartbeatRuns)).filter(run => run.scheduledRetryReason === "phase_quota_fallback")).toHaveLength(2);
  }, 45_000);

  it("reuses the selected provider session across wakes", async () => {
    const { agentId, issueId } = await seed();
    const sessionId = randomUUID();
    mocks.execute.mockResolvedValue(success(sessionId));
    await wake(agentId, issueId);
    await eventually(async () => mocks.execute.mock.calls.length === 1);
    await heartbeat.drainActiveRunExecutions();
    const sessions = await db.select().from(agentTaskSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].adapterType).toBe("codex_local");
    expect(sessions[0].taskKey).toContain(":phase:");
    await heartbeat.wakeup(agentId, { source: "on_demand", reason: "issue_comment_mentioned", payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_comment_mentioned" } });
    await eventually(async () => mocks.execute.mock.calls.length === 2);
    await heartbeat.drainActiveRunExecutions();
    expect(mocks.execute.mock.calls[1][0].runtime.sessionParams?.sessionId).toBe(sessionId);
  }, 30_000);
});
