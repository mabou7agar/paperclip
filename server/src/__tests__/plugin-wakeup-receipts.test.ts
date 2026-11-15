import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentTaskSessions, agents, authUsers, companyMemberships, companies, createDb, heartbeatRuns, heartbeatRunEvents, agentWakeupRequests, issues, plugins } from "@paperclipai/db";
import { getRecoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres-fixture.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { pluginWakeupReceipt, preparePluginWakeupReceipt } from "../services/plugin-wakeup-receipts.js";
import type { WakeupOptions } from "../services/heartbeat/run-preparation.js";

const runtime = vi.hoisted(() => ({ wakeup: vi.fn() }));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: () => runtime }));
const support = await getRecoveryPostgresSupport();
const databaseSuite = support.supported ? describe : describe.skip;

databaseSuite("durable plugin result wakeups", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const fixture = await startRecoveryPostgres("plugin-result-wake-");
    db = createDb(fixture.connectionString); cleanup = fixture.cleanup;
  }, 60_000);
  afterAll(async () => { await cleanup?.(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Result fixture", defaultResponsibleUserId: "result-owner", issuePrefix: "R" + companyId.slice(0, 6).toUpperCase() });
    await db.insert(authUsers).values({ id: "result-owner", name: "Result owner", email: "result-owner@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "result-owner",
      status: "active", membershipRole: "member" });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "Worker", status: "idle", adapterType: "process" }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Original plan", description: "Preserve the accepted candidate and evidence.", assigneeAgentId: agentId, status: "todo" });
    await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "process", taskKey: issueId,
      sessionDisplayId: "saved-worker-session", sessionParamsJson: { threadId: "saved-worker-session", plan: "accepted-plan" } });
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false, enableCases: false } as never);
    deps.issuesSvc.getDependencyReadiness.mockResolvedValue({ ready: true, blockers: [] } as never);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    deps.resolveSessionBeforeForWakeup = vi.fn(async () => "saved-worker-session");
    const queue = createHeartbeatQueue(db, deps);
    const input = { companyId, pluginId, issueId, agentId, idempotencyKey: "runner-result:fixed-receipt",
      reason: "runner_result_received", contextSource: "ubuntu.runner.result" };
    const intent = pluginWakeupReceipt(input);
    const options: WakeupOptions = { source: "assignment", reason: input.reason,
      requestedByActorType: "system", requestedByActorId: pluginId, idempotencyKey: input.idempotencyKey,
      durablePluginRequest: intent,
      payload: { issueId, pluginId, pluginWakeupDigest: intent.digest, contextSource: input.contextSource },
      contextSnapshot: { issueId, taskId: issueId, source: input.contextSource } };
    return { ...input, input, intent, options, deps, queue };
  }

  it("delivers one receipt/run through simultaneous callbacks and reuses it after restart", async () => {
    const f = await fixture();
    const results = await Promise.all([f.queue.trackWakeup(f.agentId, f.options),
      createHeartbeatQueue(db, f.deps).trackWakeup(f.agentId, f.options)]);
    expect(results[0]?.id).toBeTruthy(); expect(results[1]?.id).toBe(results[0]?.id);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, results[0]!.id));
    const resumed = await createHeartbeatQueue(db, f.deps).trackWakeup(f.agentId, f.options);
    expect(resumed?.id).toBe(results[0]?.id);
    expect(resumed?.sessionIdBefore).toBe("saved-worker-session");
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.agentId)))[0])
      .toMatchObject({ sessionDisplayId: "saved-worker-session", sessionParamsJson: { plan: "accepted-plan" } });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].description).toContain("accepted candidate");
  });

  it("keeps a paused receipt deferred without dispatching or creating another on replay", async () => {
    const f = await fixture();
    f.deps.treeControlSvc.getActivePauseHoldGate.mockResolvedValue({ holdId: randomUUID(), rootIssueId: f.issueId,
      issueId: f.issueId, isRoot: true, mode: "pause", reason: "Owner pause", releasePolicy: null });
    await f.queue.trackWakeup(f.agentId, f.options);
    await createHeartbeatQueue(db, f.deps).trackWakeup(f.agentId, f.options);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["issueId", "agentId", "reason", "contextSource"] as const)("refuses changed %s on a previously delivered key", async field => {
    const f = await fixture();
    await f.queue.trackWakeup(f.agentId, f.options);
    await expect(preparePluginWakeupReceipt(db, { ...f.input, [field]: field.endsWith("Id") ? randomUUID() : "different" }))
      .rejects.toThrow("different delivery");
  });

  it("separates company/plugin keys and rejects public payload identity substitution", async () => {
    const f = await fixture();
    expect(pluginWakeupReceipt({ ...f.input, companyId: randomUUID() }).id).not.toBe(f.intent.id);
    expect(pluginWakeupReceipt({ ...f.input, pluginId: randomUUID() }).id).not.toBe(f.intent.id);
    await expect(f.queue.trackWakeup(f.agentId, { ...f.options, payload: { issueId: f.issueId, pluginId: randomUUID() } }))
      .rejects.toThrow("admission authority");
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("recovers an exact prior-release random-ID receipt without replacing session or creating a run", async () => {
    const f = await fixture();
    const legacyId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: legacyId, companyId: f.companyId, agentId: f.agentId,
      source: "assignment", reason: f.reason, requestedByActorType: "system", requestedByActorId: f.pluginId,
      idempotencyKey: f.idempotencyKey, status: "completed", payload: { issueId: f.issueId, pluginId: f.pluginId, contextSource: f.contextSource } });
    const restored = await preparePluginWakeupReceipt(db, f.input);
    expect(restored.intent.id).toBe(legacyId); expect(restored.prior?.id).toBe(legacyId);
    expect(await createHeartbeatQueue(db, f.deps).trackWakeup(f.agentId, { ...f.options, durablePluginRequest: restored.intent })).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
  });

  it("permanently refuses ambiguous legacy receipts rather than minting a third", async () => {
    const f = await fixture();
    for (let i = 0; i < 2; i++) await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "assignment", reason: f.reason, requestedByActorType: "system", requestedByActorId: f.pluginId,
      idempotencyKey: f.idempotencyKey, status: "completed", payload: { issueId: f.issueId, pluginId: f.pluginId, contextSource: f.contextSource } });
    await expect(preparePluginWakeupReceipt(db, f.input)).rejects.toThrow("ambiguous prior delivery");
  });

  it("executes the operator reader SQL against the actual migrated native schema", async () => {
    const f = await fixture();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      sessionIdBefore: "saved-worker-session", sessionIdAfter: "saved-worker-session", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, aiConnection: { provider: "anthropic" } } });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId, seq: 1, eventType: "adapter.invoke",
      payload: { command: "node /controlled/claude-agent-acp/dist/index.js" } });
    const broker = fileURLToPath(new URL("../../../integrations/ubuntu-runner/result-bridge/broker", import.meta.url));
    const script = "import sys,json;v=json.load(sys.stdin);sys.path.insert(0,v['broker']);from native_repository import NativeRepository;n=NativeRepository({});print(json.dumps({'metadata':n.metadata_sql(v['company'],[v['run']],[]),'gates':n.admission_gates_sql(v['company'],v['issue'])}))";
    const queries = JSON.parse(execFileSync("python3", ["-B", "-c", script], { encoding: "utf8",
      input: JSON.stringify({ broker, company: f.companyId, issue: f.issueId, run: runId }) }));
    const observations: Array<{ kind: string; id: string; task: string; actualACP: boolean }> = [];
    for (const query of queries.metadata.split(";").filter((text: string) => text.trim())) {
      for (const row of await db.$client.unsafe(query)) observations.push(row.json_build_object);
    }
    expect(observations).toContainEqual(expect.objectContaining({ kind: "run", id: runId, task: f.issueId, actualACP: true }));
    expect((await db.$client.unsafe(queries.gates))[0].json_build_object)
      .toEqual({ companyActive: true, projectActive: true, pauseHeld: false });
  });

  it("preserves legacy keyed SDK calls when a plugin reuses its parent-child key", async () => {
    const f = await fixture();
    await db.insert(plugins).values({ id: f.pluginId, pluginKey: "test.legacy-keys", packageName: "fixture", version: "1", status: "ready", manifestJson: {} });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, title: "Second child", assigneeAgentId: f.agentId, status: "todo" });
    runtime.wakeup.mockReset().mockResolvedValueOnce({ id: randomUUID() }).mockResolvedValueOnce({ id: randomUUID() });
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const host = buildHostServices(db, f.pluginId, "test.legacy-keys", { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as never);
    const key = `${f.issueId}:child`;
    await host.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId, idempotencyKey: key });
    await host.issues.requestWakeup({ issueId: otherIssueId, companyId: f.companyId, idempotencyKey: key });
    expect(runtime.wakeup).toHaveBeenCalledTimes(2);
    expect(runtime.wakeup.mock.calls.every(call => call[1].durablePluginRequest === undefined)).toBe(true);
  }, 60_000);

  it("refuses an SDK result wake addressed to an assignee who no longer owns the task", async () => {
    const f = await fixture();
    await db.insert(plugins).values({ id: f.pluginId, pluginKey: "test.runner-owner", packageName: "fixture", version: "1", status: "ready", manifestJson: {} });
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const host = buildHostServices(db, f.pluginId, "test.runner-owner", { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as never);
    await expect(host.issues.requestWakeup({ issueId: f.issueId, companyId: f.companyId,
      idempotencyKey: "old-owner-result", expectedAssigneeAgentId: randomUUID() })).rejects.toThrow("assignee changed");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(0);
  }, 60_000);

  it("wires the SDK's public keyed request into native durable admission and recovers its saved outcome", async () => {
    const f = await fixture();
    await db.insert(plugins).values({ id: f.pluginId, pluginKey: "test.runner-results", packageName: "fixture", version: "1", status: "ready", manifestJson: {} });
    runtime.wakeup.mockImplementation((agentId, options) => f.queue.trackWakeup(agentId, options));
    const { buildHostServices } = await import("../services/plugin-host-services.js");
    const eventBus = { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) };
    const host = buildHostServices(db, f.pluginId, "test.runner-results", eventBus as never);
    const request = { durable: true, issueId: f.issueId, companyId: f.companyId, reason: f.reason,
      contextSource: f.contextSource, idempotencyKey: f.idempotencyKey };
    const first = await host.issues.requestWakeup(request);
    const second = await host.issues.requestWakeup(request);
    expect(first.runId).toBeTruthy(); expect(second).toEqual({ queued: false, runId: first.runId });
    expect(runtime.wakeup).toHaveBeenCalledTimes(1);
    expect(runtime.wakeup.mock.calls[0][1].durablePluginRequest.id).toBe(f.intent.id);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.idempotencyKey, f.idempotencyKey)))).toHaveLength(1);
  }, 60_000);
});
