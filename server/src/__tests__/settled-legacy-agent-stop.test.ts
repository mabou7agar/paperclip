import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentTaskSessions, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { legacyControllerBootId } from "../services/legacy-controller-lease.js";
import { hasSettledLegacyPreparation } from "../services/settled-legacy-preparation.js";
import * as stopRepository from "../repositories/agent-execution-stop.js";

describe("Stop after a sealed legacy preparation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, agentId: string, issueId: string, runId: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-settled-agent-stop-");
    db = createDb(temporary.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => temporary?.cleanup());
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); issueId = randomUUID(); runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop verification", issuePrefix: `SV${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Existing agent", status: "paused", adapterType: "claude_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep the original task hold",
      status: "blocked", assigneeAgentId: agentId, description: "Original plan and context" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "cancelled", runtimeMode: "legacy",
      startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000),
      executionStage: "settled", controllerBootId: randomUUID(), nextEventSeq: 3,
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      contextSnapshot: { issueId, originalContextMarker: "retained-plan" },
      resultJson: { stopReason: "cancelled" } });
    await db.insert(heartbeatRunEvents).values([
      { runId, companyId, agentId, seq: 1, eventType: "lifecycle", stream: "system", level: "info", message: "preparation started" },
      { runId, companyId, agentId, seq: 2, eventType: "lifecycle", stream: "system", level: "info", message: "Stop settled" },
    ]);
  });
  const stopped = () => agentExecutionsHaveStopped(db, [agentId]);
  const patch = (values: Partial<typeof heartbeatRuns.$inferInsert>) => db.update(heartbeatRuns).set(values).where(eq(heartbeatRuns.id, runId));

  it("allows agent cleanup without acknowledging, resuming or rewriting the historical task", async () => {
    const params = { sessionId: randomUUID(), connectionId: randomUUID(), contextMarker: "retained-plan" };
    await db.insert(agentTaskSessions).values({ companyId, agentId, taskKey: issueId,
      adapterType: "claude_local", sessionParamsJson: params, lastRunId: runId });
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(await stopped()).toBe(true);
    expect(await stopped()).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).toEqual([before]);
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task).toMatchObject({ status: "blocked", description: "Original plan and context" });
    const [session] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, issueId));
    expect(session.sessionParamsJson).toEqual(params);
  });

  it("scans large completed history without selecting its provider output or prompts", async () => {
    const large = "private fixture content ".repeat(350_000);
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded",
      resultJson: { stdout: large, stderr: large }, contextSnapshot: { prompt: large }, usageJson: { raw: large } });
    const observations = await stopRepository.listAgentExecutionStopObservations(db, [agentId]);
    expect(Buffer.byteLength(JSON.stringify(observations))).toBeLessThan(8_192);
    expect(observations.every(row => !("resultJson" in row) && !("contextSnapshot" in row) && !("usageJson" in row))).toBe(true);
    expect(await stopped()).toBe(true);
  });

  it.each(["adapter.invoke", "native.process_start_requested", "session.started", "tool.execution.started", "provider.event"])(
    "retains the hold when the complete journal records %s", async eventType => {
      await db.update(heartbeatRunEvents).set({ eventType }).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.seq, 2)));
      expect(await stopped()).toBe(false);
    });
  it("retains the hold for provider-authored evidence even with a generic event type", async () => {
    await db.update(heartbeatRunEvents).set({ sourceEventId: randomUUID() }).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.seq, 2)));
    expect(await stopped()).toBe(false);
  });
  it("retains the hold when event retention left an incomplete journal", async () => {
    await db.delete(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.seq, 1)));
    expect(await stopped()).toBe(false);
  });
  it.each([
    { controllerBootId: null }, { controllerBootId: legacyControllerBootId },
    { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }, { executionStage: "preparing" },
    { sessionIdAfter: "unexpected-provider-session" }, { externalRunId: "external-execution" },
    { usageJson: { inputTokens: 1 } }, { usageJson: { accountingProviderWorkStarted: true } },
    { lastOutputSeq: 1 }, { logBytes: 1 }, { stdoutExcerpt: "unclassified output" },
    { resultJson: { stdout: "Contradictory provider result" } },
    { resultJson: { providerResult: { completed: true } } },
    { resultJson: { executionRecovery: { providerWorkStarted: true } } },
  ] satisfies Partial<typeof heartbeatRuns.$inferInsert>[])("retains contradictory or incomplete ownership evidence: %j", async values => {
    await patch(values);
    expect(await stopped()).toBe(false);
  });
  it.each([
    { runnerProfileJson: { adapterDispatch: { adapterType: "third_party_adapter" } } },
    { resultJson: { workspaceRestoreFailure: "restore_unsafe_archive" } },
  ] satisfies Partial<typeof heartbeatRuns.$inferInsert>[])("does not offer the compatibility proof to a different Stop protocol: %j", async values => {
    await patch(values);
    const [observed] = await stopRepository.listAgentExecutionStopObservations(db, [agentId]);
    const run = await stopRepository.readCancelledExecutionStopRun(db, observed);
    expect(run).not.toBeNull();
    expect(await hasSettledLegacyPreparation(db, run!)).toBe(false);
    // Those protocols have their own existing cleanup rules. This exception
    // must neither replace them nor resolve the task's repair/recovery wait.
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task.status).toBe("blocked");
  });
  it.each(["legacy_disposition_repair_suppressed", "continuation_task_ownership_changed"])(
    "accepts a server-owned refusal diagnostic only with the sealed complete journal: %s", async errorCode => {
      await patch({ errorCode, lastOutputSeq: 1, usageJson: { accountingProviderWorkStarted: false } });
      expect(await stopped()).toBe(true);
      await db.delete(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.seq, 1)));
      expect(await stopped()).toBe(false);
    });
  it("does not ignore a live local process", async () => {
    await patch({ processPid: process.pid });
    expect(await stopped()).toBe(false);
  });
  it("rejects a process identity recorded between the history scan and the cancellation read", async () => {
    const read = stopRepository.readCancelledExecutionStopRun;
    const race = vi.spyOn(stopRepository, "readCancelledExecutionStopRun").mockImplementation(async (connection, observed) => {
      // Keep the timestamp unchanged: process identity is an independent fence.
      await connection.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, runId));
      return read(connection, observed);
    });
    try { expect(await stopped()).toBe(false); }
    finally { race.mockRestore(); }
  });
  it("does not release an environment whose cleanup is still pending", async () => {
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local", status: "pending_cleanup" });
    expect(await stopped()).toBe(false);
  });
});
