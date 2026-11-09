import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, companyMemberships, agentConfigRevisions, agentTaskSessions, agentWakeupRequests, companies, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, issueRelations, issues } from "@paperclipai/db";
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
    config: { ...input.config, managedAiConnection: {
      provider: input.binding.provider, method: input.binding.method, mode: input.binding.mode,
      connectionId: input.binding.connectionId, grantId: input.binding.grantId,
      identity: `${input.binding.grantId}:user:fake`, sessionIdentity: `${input.binding.grantId}:user:fake`,
    } },
    attribution: { provider: input.binding.provider, method: input.binding.method, connectionId: input.binding.connectionId, grantId: input.binding.grantId },
    identity: `${input.binding.grantId}:user:fake`, sessionIdentity: `${input.binding.grantId}:user:fake`,
    accountName: "Fake isolated account", cleanup: async () => {},
  })),
}));
import { heartbeatService } from "../services/heartbeat.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { phaseRoutingSettingsRepository } from "../repositories/phase-routing-settings.js";
import { documentService } from "../services/documents.js";

const support = await getEmbeddedPostgresTestSupport();
const claudeId = "10000000-0000-4000-8000-000000000001";
const codexId = "10000000-0000-4000-8000-000000000002";
const grantId = "20000000-0000-4000-8000-000000000001";
const claude = { id: "claude", adapterType: "claude_local", model: "claude-test", binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" } };
const codex = { id: "codex", adapterType: "codex_local", model: "codex-test", binding: { provider: "openai", method: "subscription", mode: "responsible_user" } };
const policy = phaseRoutingSchema.parse({ enabled: true, planning: [claude, codex], implementation: [codex] });

let routingDiagnostic: () => Promise<unknown> = async () => null;

async function eventually(check: () => Promise<boolean>, attempts = 1200) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Expected routing outcome did not arrive: ${JSON.stringify(await routingDiagnostic())}`);
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
  beforeEach(() => { heartbeat.stopTaskDrain(); });
  afterEach(async () => {
    heartbeat.startTaskDrain();
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    mocks.execute.mockReset();
    mocks.select.mockReset();
  }, 90_000);
  afterAll(async () => { heartbeat.stopTaskDrain(); await database?.cleanup(); });

  async function seed(workMode: "standard" | "planning" = "standard") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(authUsers).values({ id: "user", name: "Fixture owner", email: "phase-owner@example.invalid",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Phase routing", issuePrefix: `P${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active", adapterType: "claude_local",
      adapterConfig: { model: "claude-test", command: "must-not-leak" }, permissions: {},
      runtimeConfig: { phaseRouting: policy, heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Routed task", status: "todo", workMode, assigneeAgentId: agentId, responsibleUserId: "user" });
    routingDiagnostic = async () => ({
      runs: await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
      tasks: await db.select({ id: issues.id, status: issues.status, executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      }).from(issues).where(eq(issues.companyId, companyId)),
    });
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

  it.each([false, true])("uses controlled task availability and preserves fallback session (retained activation: %s)", async retained => {
    const { companyId, agentId, issueId } = await seed("planning");
    const drill = { id: randomUUID(), phase: "planning" as const, profileId: "claude", expiresAt: new Date(Date.now() + (retained ? -1_000 : 600_000)).toISOString() };
    await phaseRoutingSettingsRepository(db).save(companyId, phaseRoutingSchema.parse({ ...policy,
      taskOverrides: { [issueId]: { availabilityDrill: drill } } }));
    if (retained) await db.insert(activityLog).values({ id: drill.id, companyId, actorType: "system", actorId: "phase-routing",
      action: "phase_routing.controlled_availability_fault", entityType: "issue", entityId: issueId,
      details: { ...drill, synthetic: true, providerWorkStarted: false, sharedQuotaChanged: false },
      createdAt: new Date(Date.parse(drill.expiresAt) - 1_000) });
    const sessionId = randomUUID(), blockerId = randomUUID();
    let turns = 0;
    mocks.execute.mockImplementation(async ctx => {
      expect(ctx.config.model).toBe("codex-test");
      if (++turns === 1) {
        // A completed planning turn must publish its real wait disposition;
        // leaving an actionable task untouched correctly invokes repair.
        await db.insert(issues).values({ id: blockerId, companyId, title: "Delegated implementation", status: "todo", responsibleUserId: "user" });
        await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      } else {
        expect(ctx.runtime.sessionParams).toMatchObject({ sessionId });
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      }
      return success(sessionId);
    });
    for (let turn = 0; turn < 2; turn++) {
      if (turn) await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
      await wake(agentId, issueId);
      await eventually(async () => mocks.execute.mock.calls.length === turn + 1);
      await heartbeat.drainActiveRunExecutions();
    }
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(runs.filter(run => run.status === "succeeded")).toHaveLength(2);
    expect(runs.every(run => (run.status === "succeeded" || (run.status === "cancelled" && run.errorCode === "issue_terminal_status"))
      && !run.retryOfRunId && !run.scheduledRetryAt)).toBe(true);
    expect(runs.some(run => run.contextSnapshot?.wakeReason === "issue_disposition_repair")).toBe(false);
    expect(runs.find(run => run.sessionIdBefore === sessionId)?.sessionIdAfter).toBe(sessionId);
    const claims = await db.select().from(activityLog).where(eq(activityLog.id, drill.id));
    expect(claims).toHaveLength(1);
    expect(await providerQuotaRepository(db).latestEvidence(companyId, claudeId, new Date(), grantId)).toBeNull();
    expect(await providerQuotaRepository(db).latestEvidence(companyId, codexId, new Date(), grantId)).toBeNull();
    expect((await phaseRoutingSettingsRepository(db).get(companyId))?.planning[0].id).toBe("claude");
  }, 60_000);

  it("fails closed for expired controlled task availability without invoking Claude or retrying", async () => {
    const { companyId, agentId, issueId } = await seed("planning");
    const drill = { id: randomUUID(), phase: "planning" as const, profileId: "claude", expiresAt: new Date(Date.now() - 1_000).toISOString() };
    await phaseRoutingSettingsRepository(db).save(companyId, phaseRoutingSchema.parse({ ...policy,
      taskOverrides: { [issueId]: { availabilityDrill: drill } } }));
    await wake(agentId, issueId);
    await eventually(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)))
      .some(run => !["queued", "running"].includes(run.status)));
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", scheduledRetryAt: null, retryOfRunId: null });
    expect(runs[0].error).toContain("activation deadline expired");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(await db.select().from(activityLog).where(eq(activityLog.id, drill.id))).toHaveLength(0);
  }, 60_000);

  it("routes a standard CTO to worker to Tech Lead review and back without repeating work", async () => {
    const { companyId, agentId: ctoId, issueId: parentId } = await seed();
    const workerId = randomUUID(), reviewerId = randomUUID(), workerTask = randomUUID(), reviewTask = randomUUID();
    const marker = `delegated-context-${randomUUID()}`;
    const companyPolicy = phaseRoutingSchema.parse({ ...policy, review: [claude], roleResponsibilities: { cto: "planning" } });
    await phaseRoutingSettingsRepository(db).save(companyId, companyPolicy);
    await db.update(agents).set({ role: "cto", runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, ctoId));
    for (const [id, name, responsibility] of [[workerId, "Worker", "implementation"], [reviewerId, "Tech Lead", "review"]]) {
      await db.insert(agents).values({ id, companyId, name, role: "engineer", status: "active", adapterType: "claude_local",
        adapterConfig: { model: "claude-test" }, permissions: {}, reportsTo: ctoId,
        runtimeConfig: { executionResponsibility: responsibility, heartbeat: { wakeOnDemand: true } } });
    }
    const visited: string[] = [];
    mocks.execute.mockImplementation(async ctx => {
      const taskId = ctx.context.issueId as string;
      visited.push(ctx.agent.id);
      if (ctx.agent.id === ctoId && visited.length === 1) {
        expect(ctx.config.model).toBe("claude-test");
        await documentService(db).upsertIssueDocument({ issueId: parentId, key: "plan", format: "markdown", body: marker, createdByAgentId: ctoId });
        await db.insert(issues).values({ id: workerTask, companyId, parentId, title: "Implement delegated plan", description: marker,
          status: "todo", workMode: "standard", assigneeAgentId: workerId, responsibleUserId: "user", createdByAgentId: ctoId });
        await documentService(db).upsertIssueDocument({ issueId: workerTask, key: "plan", format: "markdown", body: marker, createdByAgentId: ctoId });
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, parentId));
      } else if (ctx.agent.id === workerId) {
        expect(ctx.config.model).toBe("codex-test");
        expect(ctx.context.paperclipTaskMarkdown).toContain(marker);
        expect(ctx.context.paperclipTaskMarkdown).toContain('Actual provider: "openai"');
        await db.insert(issues).values({ id: reviewTask, companyId, parentId: workerTask, title: "Review frozen handoff", description: `${marker} HANDOFF frozen-artifact; author provider openai`,
          status: "todo", workMode: "standard", assigneeAgentId: reviewerId, responsibleUserId: "user", createdByAgentId: workerId });
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, workerTask));
      } else if (ctx.agent.id === reviewerId) {
        expect(ctx.config.model).toBe("claude-test");
        expect(ctx.context.paperclipTaskMarkdown).toContain(marker);
        expect(ctx.context.paperclipTaskMarkdown).toContain('Actual provider: "anthropic"');
        await db.insert(issueComments).values({ companyId, issueId: reviewTask, authorAgentId: reviewerId, body: `accept: ${marker}; independently checked frozen-artifact` });
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, reviewTask));
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, workerTask));
      } else {
        expect(ctx.agent.id).toBe(ctoId);
        expect(ctx.config.model).toBe("claude-test");
        expect(ctx.context.paperclipTaskMarkdown).toContain(marker);
        expect((await db.select().from(issueComments).where(eq(issueComments.issueId, reviewTask)))[0].body).toContain("accept:");
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, parentId));
      }
      return success();
    });
    // Exercise ordinary assignment/return dispatch and durable task/document handoffs.
    // Provider outputs are deterministic here; the live acceptance exercises agent-authored handoffs.
    for (const [agentId, issueId] of [[ctoId, parentId], [workerId, workerTask], [reviewerId, reviewTask], [ctoId, parentId]]) {
      if (visited.length === 3) await db.update(issues).set({ status: "todo" }).where(eq(issues.id, parentId));
      const before = visited.length;
      await wake(agentId, issueId);
      try { await eventually(async () => visited.length === before + 1); }
      catch {
        const runs = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
        }).from(heartbeatRuns);
        throw new Error(`Routing handoff did not arrive: ${JSON.stringify({ visited, expected: agentId, runs })}`);
      }
      await heartbeat.drainActiveRunExecutions();
    }
    for (let sweep = 0; sweep < 3; sweep++) {
      await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 60_000));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
    }
    expect(visited).toEqual([ctoId, workerId, reviewerId, ctoId]);
    const runs = await db.select().from(heartbeatRuns).orderBy(heartbeatRuns.createdAt);
    expect(runs.filter(run => run.status === "succeeded").map(run => (run.runnerProfileJson?.adapterDispatch as { phaseRoute?: { phase: string } })?.phaseRoute?.phase))
      .toEqual(["planning", "implementation", "review", "planning"]);
    // Completion can enqueue a delivery wake; the terminal-task gate cancels it before provider dispatch.
    expect(runs.every(run => run.status === "succeeded" || (run.status === "cancelled" && run.errorCode === "issue_terminal_status"))).toBe(true);
    expect(runs.filter(run => run.status === "succeeded")).toHaveLength(4);
    expect((await db.select().from(issues)).every(issue => issue.status === "done")).toBe(true);
  }, 90_000);

  it("reuses the phase session after a planning-only edit when the base connection is Claude", async () => {
    const {companyId,agentId,issueId}=await seed();
    const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
    const raw={...agent.runtimeConfig,aiConnection:claude.binding};
    await db.update(agents).set({runtimeConfig:raw}).where(eq(agents.id,agentId));
    const snapshot={name:agent.name,adapterConfig:agent.adapterConfig,runtimeConfig:raw};
    await db.insert(agentConfigRevisions).values({companyId,agentId,changedKeys:["runtimeConfig"],beforeConfig:{},afterConfig:snapshot,createdAt:new Date(Date.now()-1000)});
    const reviewId=randomUUID(),sid=randomUUID(),marker=`preserved-planning-${randomUUID()}`;
    await db.update(issues).set({description:marker}).where(eq(issues.id,issueId));
    const observed:Array<{params:unknown;markdown:unknown;model:unknown}>=[];
    mocks.execute.mockImplementation(async ctx=>{
      observed.push({params:ctx.runtime.sessionParams,markdown:ctx.context.paperclipTaskMarkdown,model:ctx.config.model});
      if(observed.length===1){
        await db.insert(issues).values({id:reviewId,companyId,title:"Existing review",status:"todo",responsibleUserId:"user"});
        await db.insert(issueRelations).values({companyId,issueId:reviewId,relatedIssueId:issueId,type:"blocks"});
        await db.update(issues).set({status:"blocked"}).where(eq(issues.id,issueId));
      }else await db.update(issues).set({status:"done"}).where(eq(issues.id,issueId));
      return success(sid);
    });
    await wake(agentId,issueId);await eventually(async()=>mocks.execute.mock.calls.length===1);await heartbeat.drainActiveRunExecutions();
    const nextRaw={...raw,phaseRouting:phaseRoutingSchema.parse({...policy,planning:[...policy.planning,{...claude,id:"claude-api",binding:{...claude.binding,method:"api_key"}}]})};
    await db.insert(agentConfigRevisions).values({companyId,agentId,changedKeys:["runtimeConfig"],beforeConfig:snapshot,afterConfig:{...snapshot,runtimeConfig:nextRaw},createdAt:new Date()});
    await db.update(agents).set({runtimeConfig:nextRaw}).where(eq(agents.id,agentId));
    await db.update(issues).set({status:"done"}).where(eq(issues.id,reviewId));
    await heartbeat.wakeup(agentId,{source:"automation",reason:"issue_blockers_resolved",payload:{issueId},contextSnapshot:{issueId,wakeReason:"issue_blockers_resolved"}});await eventually(async()=>mocks.execute.mock.calls.length===2);await heartbeat.drainActiveRunExecutions();
    for(let sweep=0;sweep<3;sweep++){await heartbeat.promoteDueScheduledRetries(new Date(Date.now()+60_000));await heartbeat.resumeQueuedRuns();await heartbeat.drainActiveRunExecutions();}
    const runs=await db.select().from(heartbeatRuns);
    expect(observed.length,JSON.stringify(runs.map(r=>({status:r.status,code:r.errorCode,reason:r.contextSnapshot?.wakeReason})))).toBe(2);
    expect(observed[1].params,JSON.stringify(runs.map(r=>({status:r.status,freshness:r.usageJson?.configFreshness})))).toMatchObject({sessionId:sid});expect(observed[1].markdown).toContain(marker);expect(observed.map(o=>o.model)).toEqual(["codex-test","codex-test"]);
    expect(runs.filter(r=>r.status==="succeeded")).toHaveLength(2);expect(runs.some(r=>r.status==="scheduled_retry")).toBe(false);
  },60000);

  it("uses a scoped review fallback at claim while other reviews remain parked", async () => {
    const { companyId, agentId, issueId } = await seed();
    const otherTask = randomUUID();
    await db.insert(issues).values({ id: otherTask, companyId, title: "Other review", status: "todo", workMode: "standard", assigneeAgentId: agentId, responsibleUserId: "user" });
    await phaseRoutingSettingsRepository(db).save(companyId, phaseRoutingSchema.parse({ ...policy, review: [claude], taskOverrides: { [issueId]: { review: [claude, codex] } } }));
    await db.update(agents).set({ runtimeConfig: { executionResponsibility: "review", heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    await db.insert(heartbeatRuns).values({ companyId, agentId, scopeKind: "issue", issueId, invocationSource: "assignment", status: "failed", finishedAt: new Date(), errorCode: "acpx_turn_failed", resultJson: { terminalSessionFailure: {category:"limit",title:"API Error: Request rejected (429) · api key quota exhausted"}, retryNotBefore: new Date(Date.now() + 3_600_000).toISOString() }, contextSnapshot: { issueId, aiConnection: { connectionId: claudeId, provider:"anthropic" } } });
    mocks.execute.mockImplementation(async ctx => {
      expect(ctx.agent.adapterType).toBe("codex_local");
      expect(ctx.context.issueId).toBe(issueId);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return success();
    });
    await wake(agentId, issueId);
    await eventually(async () => mocks.execute.mock.calls.length === 1);
    await heartbeat.drainActiveRunExecutions();
    const other = await wake(agentId, otherTask);
    await eventually(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, other!.id)))[0]?.status === "cancelled");
    await heartbeat.drainActiveRunExecutions();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const runs = await db.select().from(heartbeatRuns);
    expect(runs.find(run => run.status === "succeeded")?.runnerProfileJson).toMatchObject({ adapterDispatch: { phaseRoute: { phase: "review", profile: { id: "codex" } } } });
    expect(runs.filter(run => run.status === "scheduled_retry")).toHaveLength(1);
  }, 90_000);

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
  }, 90_000);

  it("holds undated exhausted connections across repeated scheduler sweeps without executing providers", async () => {
    const { companyId, agentId, issueId } = await seed("planning");
    await db.update(agents).set({ runtimeConfig: {
      phaseRouting: { ...policy, unknownResetCooldownSeconds: 0 }, heartbeat: { wakeOnDemand: true },
    } }).where(eq(agents.id, agentId));
    for (const connectionId of [claudeId, codexId]) await db.insert(heartbeatRuns).values({
      companyId, agentId, scopeKind: "issue", issueId, invocationSource: "assignment", status: "failed",
      finishedAt: new Date(), errorCode: "provider_quota",
      resultJson: { errorFamily: "provider_quota", providerQuotaResetSource: "backoff",
        retryNotBefore: new Date(Date.now() + 3_600_000).toISOString() },
      contextSnapshot: { issueId, aiConnection: { connectionId } },
    });
    await wake(agentId, issueId);
    await eventually(async () => (await db.select().from(heartbeatRuns)).some(run => run.errorCode === "configuration_incomplete"));
    for (let pass = 0; pass < 3; pass++) {
      await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 86_400_000));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    }
    expect(mocks.execute).not.toHaveBeenCalled();
    const runs = await db.select().from(heartbeatRuns);
    expect(runs.filter(run => run.status === "scheduled_retry")).toHaveLength(0);
    const gate = runs.find(run => run.errorCode === "configuration_incomplete")!;
    expect(gate.resultJson).toMatchObject({ configurationIncomplete: { reason: "ai_connection_quota_reset_unknown" } });
  });

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
  }, 60_000);

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
  }, 90_000);

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
  }, 90_000);

  async function parkUntilRenewal(options: { secondaryResetDelayMs?: number } = {}) {
    const fixture = await seed("planning");
    const { companyId, agentId, issueId } = fixture;
    const marker = `renewal-context-${randomUUID()}`;
    // Leave enough time for real workspace admission and accounting to park
    // before renewal, even on a loaded host. Provider I/O remains simulated.
    const renewal = new Date(Date.now() + 30_000);
    const planBody = `# Saved plan\n\nPreserve ${marker}. Continue step two without repeating step one.`;
    await db.update(issues).set({ description: `Resume the same objective: ${marker}` }).where(eq(issues.id, issueId));
    const plan = await documentService(db).upsertIssueDocument({ issueId, key: "plan", format: "markdown", body: planBody, createdByAgentId: agentId });
    await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId, body: `Step one complete: ${marker}` });
    for (const [connectionId, reset] of [[claudeId, renewal], [codexId, new Date(renewal.getTime() + (options.secondaryResetDelayMs ?? 3_600_000))]] as const) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, scopeKind: "issue", issueId,
        status: "failed", finishedAt: new Date(), errorCode: "provider_quota",
        resultJson: { errorFamily: "provider_quota", retryNotBefore: reset.toISOString() },
        contextSnapshot: { issueId, aiConnection: { connectionId } },
      });
    }
    const parked = await heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned", payload: { issueId },
      contextSnapshot: { issueId, wakeReason: "issue_assigned", renewalCheckpoint: { marker, completedSteps: ["one"] } } });
    await eventually(async () => (await db.select().from(heartbeatRuns)).some(run => run.status === "scheduled_retry"));
    await heartbeat.drainActiveRunExecutions();
    const [scheduled] = (await db.select().from(heartbeatRuns)).filter(run => run.status === "scheduled_retry");
    expect(scheduled.retryOfRunId).toBe(parked!.id);
    expect(scheduled.scheduledRetryReason).toBe("ai_connection_pool_wait");
    expect(scheduled.scheduledRetryAt?.getTime()).toBe(renewal.getTime());
    expect(mocks.execute).not.toHaveBeenCalled();
    return { ...fixture, marker, planBody, planRevisionId: plan.document.latestRevisionId, renewal, scheduled };
  }

  it("resumes the same task once at renewal across restart and competing scheduler sweeps, preserving its saved context", async () => {
    const fixture = await parkUntilRenewal();
    const { issueId, agentId, marker, renewal, scheduled } = fixture;
    // Keep the process and PostgreSQL lease clocks aligned. Only the provider's
    // fixture reset is shortened; no global fake clock or lease mock is used.
    heartbeat = heartbeatService(db);
    const competingScheduler = heartbeatService(db);
    expect((await heartbeat.promoteDueScheduledRetries(new Date(renewal.getTime() - 1))).promoted).toBe(0);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.drainActiveRunExecutions();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scheduled.id)))[0].status).toBe("scheduled_retry");
    mocks.execute.mockImplementation(async ctx => {
      expect(ctx.agent.id).toBe(agentId);
      expect(ctx.agent.adapterType).toBe("claude_local");
      expect(ctx.context.issueId).toBe(issueId);
      expect(ctx.context.renewalCheckpoint).toEqual({ marker, completedSteps: ["one"] });
      expect(ctx.context.paperclipTaskMarkdown).toContain(fixture.planBody);
      expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).some(comment => comment.body === `Step one complete: ${marker}`)).toBe(true);
      expect(ctx.runtime.taskKey).toContain(issueId);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return success();
    });
    await eventually(async () => Date.now() >= renewal.getTime(), 1200);
    const promotions = await Promise.all([heartbeat.promoteDueScheduledRetries(), competingScheduler.promoteDueScheduledRetries()]);
    expect(promotions.reduce((sum, result) => sum + result.promoted, 0)).toBe(1);
    await Promise.all([heartbeat.resumeQueuedRuns(), competingScheduler.resumeQueuedRuns()]);
    await eventually(async () => mocks.execute.mock.calls.length === 1);
    await Promise.all([heartbeat.drainActiveRunExecutions(), competingScheduler.drainActiveRunExecutions()]);
    for (const elapsed of [30_000, 60_000, 3_600_000, 86_400_000]) {
      expect((await heartbeat.promoteDueScheduledRetries(new Date(renewal.getTime() + elapsed))).promoted).toBe(0);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
    }
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const runs = await db.select().from(heartbeatRuns);
    expect(runs.filter(run => run.retryOfRunId === scheduled.retryOfRunId)).toHaveLength(1);
    expect(runs.find(run => run.id === scheduled.id)).toMatchObject({ status: "succeeded", issueId, agentId, scheduledRetryAttempt: 1 });
    expect(runs.some(run => ["scheduled_retry", "queued", "running"].includes(run.status))).toBe(false);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("done");
    expect((await documentService(db).getIssueDocumentByKey(issueId, "plan"))?.latestRevisionId).toBe(fixture.planRevisionId);
    expect((await db.select().from(agentWakeupRequests)).filter(wake => ["queued", "claimed"].includes(wake.status))).toHaveLength(0);
  }, 90_000);

  it.each(["done", "cancelled"] as const)("does not resume a renewal wait after the task becomes %s", async status => {
    const { issueId, renewal } = await parkUntilRenewal();
    await db.update(issues).set({ status }).where(eq(issues.id, issueId));
    heartbeat = heartbeatService(db);
    for (let sweep = 0; sweep < 3; sweep++) {
      await heartbeat.promoteDueScheduledRetries(renewal);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
    }
    expect(mocks.execute).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns)).some(run => ["scheduled_retry", "queued", "running"].includes(run.status))).toBe(false);
  }, 90_000);

  it("automatically resumes once when real wall-clock time reaches renewal", async () => {
    const { issueId, marker, renewal } = await parkUntilRenewal();
    const starts: number[] = [];
    mocks.execute.mockImplementation(async ctx => {
      starts.push(Date.now());
      expect(ctx.context.issueId).toBe(issueId);
      expect(ctx.context.paperclipTaskMarkdown).toContain(marker);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return success();
    });
    heartbeat = heartbeatService(db);
    let sweeping: Promise<void> | null = null;
    let sweepError: unknown;
    let completedSweeps = 0;
    const timer = setInterval(() => {
      if (sweeping || sweepError) return;
      sweeping = (async () => {
        await heartbeat.promoteDueScheduledRetries();
        await heartbeat.resumeQueuedRuns();
        completedSweeps++;
      })().catch(error => { sweepError = error; }).finally(() => { sweeping = null; });
    }, 100);
    try {
      await eventually(async () => starts.length === 1 || !!sweepError, 1200);
      await heartbeat.drainActiveRunExecutions();
      const sweepsAtCompletion = completedSweeps;
      await eventually(async () => completedSweeps >= sweepsAtCompletion + 3 || !!sweepError);
      expect(sweepError).toBeUndefined();
      expect(starts).toHaveLength(1);
      expect(starts[0]).toBeGreaterThanOrEqual(renewal.getTime());
      expect(mocks.execute).toHaveBeenCalledTimes(1);
      expect((await db.select().from(heartbeatRuns)).some(run => ["scheduled_retry", "queued", "running"].includes(run.status))).toBe(false);
    } finally {
      clearInterval(timer);
      await sweeping;
    }
  }, 90_000);

  it("stops automatic renewal recovery when the provider still reports quota after its reset", async () => {
    const { renewal } = await parkUntilRenewal();
    await eventually(async () => Date.now() >= renewal.getTime(), 1200);
    mocks.execute.mockResolvedValue({ ...success(), exitCode: 1, errorMessage: "Quota remains exhausted after reset", errorFamily: "provider_quota",
      retryNotBefore: new Date(renewal.getTime() + 7_200_000).toISOString() });
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
    await eventually(async () => mocks.execute.mock.calls.length === 1);
    await heartbeat.drainActiveRunExecutions();
    // The bounded fallback may inspect remaining levels, but neither a provider
    // nor a second renewal wait may loop indefinitely if the reset was stale.
    for (const elapsed of [2_000, 4_000, 8_000, 86_400_000]) {
      await heartbeat.promoteDueScheduledRetries(new Date(renewal.getTime() + elapsed));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
    }
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    const runs = await db.select().from(heartbeatRuns);
    expect(runs.filter(run => run.scheduledRetryReason === "ai_connection_pool_wait"), JSON.stringify(runs.map(run => ({ id: run.id, status: run.status, reason: run.scheduledRetryReason, attempt: run.scheduledRetryAttempt, wakeReason: run.contextSnapshot?.wakeReason, retryOf: run.retryOfRunId })))).toHaveLength(1);
    expect(runs.some(run => ["scheduled_retry", "queued", "running"].includes(run.status))).toBe(false);
  }, 90_000);

  it("schedules renewal when fresh quota failures exhaust the fallback chain, then resumes only once", async () => {
    const { agentId, issueId } = await seed("planning");
    const marker = `fresh-chain-${randomUUID()}`;
    const renewal = new Date(Date.now() + 30_000);
    await documentService(db).upsertIssueDocument({ issueId, key: "plan", format: "markdown", body: `Continue ${marker}`, createdByAgentId: agentId });
    mocks.execute.mockImplementation(async ctx => {
      if (Date.now() < renewal.getTime()) return { ...success(), exitCode: 1, errorMessage: "Quota exhausted", errorFamily: "provider_quota",
        retryNotBefore: (ctx.agent.adapterType === "claude_local" ? renewal : new Date(renewal.getTime() + 3_600_000)).toISOString() };
      expect(ctx.context.issueId).toBe(issueId);
      expect(ctx.context.paperclipTaskMarkdown).toContain(marker);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return success();
    });
    await wake(agentId, issueId);
    await eventually(async () => (await db.select().from(heartbeatRuns)).some(run => run.status === "scheduled_retry"));
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 2_000));
    await heartbeat.resumeQueuedRuns();
    await eventually(async () => mocks.execute.mock.calls.length === 2);
    await heartbeat.drainActiveRunExecutions();
    const waits = (await db.select().from(heartbeatRuns)).filter(run => run.status === "scheduled_retry");
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ issueId, agentId, scheduledRetryReason: "ai_connection_pool_wait" });
    expect(waits[0].scheduledRetryAt?.getTime()).toBe(renewal.getTime());
    await eventually(async () => Date.now() >= renewal.getTime(), 1200);
    heartbeat = heartbeatService(db);
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
    await eventually(async () => mocks.execute.mock.calls.length === 3);
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.promoteDueScheduledRetries(new Date(renewal.getTime() + 86_400_000));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.drainActiveRunExecutions();
    expect(mocks.execute.mock.calls.map(([ctx]) => ctx.agent.adapterType)).toEqual(["claude_local", "codex_local", "claude_local"]);
    expect((await db.select().from(heartbeatRuns)).some(run => ["scheduled_retry", "queued", "running"].includes(run.status))).toBe(false);
  }, 45_000);

  it("does not replenish the renewal allowance after switching fallback providers", async () => {
    const { renewal } = await parkUntilRenewal({ secondaryResetDelayMs: 0 });
    await eventually(async () => Date.now() >= renewal.getTime(), 1200);
    mocks.execute.mockResolvedValue({ ...success(), exitCode: 1, errorMessage: "Quota remains exhausted", errorFamily: "provider_quota",
      retryNotBefore: new Date(renewal.getTime() + 7_200_000).toISOString() });
    await heartbeat.promoteDueScheduledRetries();
    await heartbeat.resumeQueuedRuns();
    await eventually(async () => mocks.execute.mock.calls.length === 1);
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 2_000));
    await heartbeat.resumeQueuedRuns();
    await eventually(async () => mocks.execute.mock.calls.length === 2);
    await heartbeat.drainActiveRunExecutions();
    for (let sweep = 0; sweep < 3; sweep++) {
      await heartbeat.promoteDueScheduledRetries(new Date(renewal.getTime() + 86_400_000));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.reconcileStrandedAssignedIssues();
      await heartbeat.drainActiveRunExecutions();
    }
    expect(mocks.execute.mock.calls.map(([ctx]) => ctx.agent.adapterType)).toEqual(["claude_local", "codex_local"]);
    const runs = await db.select().from(heartbeatRuns);
    expect(runs.filter(run => run.scheduledRetryReason === "ai_connection_pool_wait")).toHaveLength(1);
    expect(runs.some(run => ["scheduled_retry", "queued", "running"].includes(run.status))).toBe(false);
  }, 90_000);

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
  }, 90_000);
});
