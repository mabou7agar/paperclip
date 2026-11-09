import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { completionReceiptHttpMutationAllowed, completionReceiptSourceReady, reconcileTaskCompletionReceipt, taskCompletionReceiptState } from "../services/task-completion-receipts.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";

const execute = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ exitCode: 0, signal: null, timedOut: false,
  errorMessage: null, summary: "Acknowledged saved completion", provider: "test", model: "test-model" })));
vi.mock("../adapters/index.ts", async () => ({ ...await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("closed delegator completion receipts", () => {
  let db: ReturnType<typeof createDb>, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("completion-receipts-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function seed(parentStatus = "done") {
    const companyId = randomUUID(), brain = randomUUID(), worker = randomUUID();
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "receipt-fixture@example.invalid", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Receipt company", issuePrefix: `R${companyId.slice(0, 5)}`, defaultResponsibleUserId: "responsible-user", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([brain, worker].map((id, i) => ({ id, companyId, name: i ? "Worker" : "Delegator", role: i ? "engineer" : "cto", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} })));
    const [parent] = await db.insert(issues).values({ companyId, title: "Delegator disposition", status: parentStatus, assigneeAgentId: brain }).returning();
    const [child] = await db.insert(issues).values({ companyId, parentId: parent.id, title: "Frozen implementation", description: "Plan revision A; exact candidate abc123; completed evidence must not be re-executed", status: "in_progress", assigneeAgentId: worker }).returning();
    const finish = () => issueService(db).update(child.id, { status: "done" });
    const receipts = () => db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "task_completion_receipt"), eq(agentWakeupRequests.requestedByActorId, "native-status-committer")));
    return { companyId, brain, worker, parent, child, finish, receipts };
  }

  it("records once on the worker's status transaction and deduplicates concurrent reconciliation", async () => {
    const f = await seed(); await f.finish();
    await Promise.all([reconcileTaskCompletionReceipt(db, f.companyId, f.child.id), reconcileTaskCompletionReceipt(db, f.companyId, f.child.id)]);
    expect(await f.receipts()).toHaveLength(1);
    const [receipt] = await f.receipts();
    expect(receipt).toMatchObject({ agentId: f.brain, requestedByActorType: "system", requestedByActorId: "native-status-committer" });
    expect(receipt.payload).toMatchObject({ issueId: f.child.id, completionReceiptParentId: f.parent.id });
    const [child] = await db.select().from(issues).where(eq(issues.id, f.child.id));
    expect(child).toMatchObject({ status: "done", assigneeAgentId: f.worker, executionRunId: null });
  });

  it("rejects execution, other-task comments, and resume/reopen flags on HTTP acknowledgement writes", () => {
    const context = { wakeReason: "task_completion_receipt", issueId: "task", paperclipIssue: { identifier: "TEST-1" } };
    expect(completionReceiptHttpMutationAllowed(context, "GET", "/api/issues/task", null)).toBe(true);
    expect(completionReceiptHttpMutationAllowed(context, "POST", "/api/issues/task/comments", { body: "Acknowledged" })).toBe(true);
    expect(completionReceiptHttpMutationAllowed(context, "POST", "/api/issues/TEST-1/comments", { body: "Acknowledged" })).toBe(true);
    for (const path of ["/api/issues/other/comments", "/api/issues/task/checkout", "/api/issues/task/interactions", "/api/companies/company/issues"]) expect(completionReceiptHttpMutationAllowed(context, "POST", path, {})).toBe(false);
    for (const flag of ["reopen", "resume", "interrupt"]) expect(completionReceiptHttpMutationAllowed(context, "POST", "/api/issues/task/comments", { [flag]: true })).toBe(false);
    expect(completionReceiptHttpMutationAllowed(context, "PATCH", "/api/issues/task", { status: "todo" })).toBe(false);
  });

  it("does not create a wake when the status transaction rolls back", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => { await issueService(tx as unknown as typeof db).update(f.child.id, { status: "done" }, tx); throw Error("rollback"); })).rejects.toThrow("rollback");
    expect(await f.receipts()).toHaveLength(0);
  });

  it("retains the ordinary open-parent protocol", async () => {
    const f = await seed("in_progress"); await f.finish();
    expect(await f.receipts()).toHaveLength(0);
    expect(await issueService(db).getWakeableParentAfterChildCompletion(f.parent.id)).toMatchObject({ id: f.parent.id, assigneeAgentId: f.brain });
  });

  it("keeps onboarding and watchdog parent notifications on their existing paths", async () => {
    for (const originKind of ["onboarding_first_task", "task_watchdog"]) {
      const f = await seed(); await db.update(issues).set({ originKind }).where(eq(issues.id, f.parent.id));
      await f.finish(); expect(await f.receipts()).toHaveLength(0);
      if (originKind === "onboarding_first_task") expect(await issueService(db).getWakeableParentAfterChildCompletion(f.parent.id)).toMatchObject({ onboardingCompletion: true });
    }
  });

  it("waits for the same worker run to settle before handing off its final evidence", async () => {
    const f = await seed(), sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: f.companyId, agentId: f.worker, status: "running", invocationSource: "on_demand", contextSnapshot: { issueId: f.child.id } });
    await f.finish(); const [receipt] = await f.receipts();
    expect(receipt.payload?.sourceRunId).toBe(sourceRunId);
    const input = { companyId: f.companyId, issueId: f.child.id, agentId: f.brain, contextSnapshot: receipt.payload!._paperclipWakeContext as Record<string, unknown> };
    expect(await completionReceiptSourceReady(db, input)).toBe(false);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, sourceRunId));
    expect(await completionReceiptSourceReady(db, input)).toBe(true);
    expect(await f.receipts()).toHaveLength(1);
  });

  it("rejects forged, wrong-company, wrong-recipient and superseded receipt context", async () => {
    const f = await seed(); await f.finish(); const [receipt] = await f.receipts();
    const context = receipt.payload!._paperclipWakeContext as Record<string, unknown>;
    const input = { companyId: f.companyId, issueId: f.child.id, agentId: f.brain, contextSnapshot: context };
    expect(await taskCompletionReceiptState(db, input)).toBe("pending");
    expect(await taskCompletionReceiptState(db, { ...input, companyId: randomUUID() })).toBe("stale");
    expect(await taskCompletionReceiptState(db, { ...input, agentId: f.worker })).toBe("stale");
    expect(await taskCompletionReceiptState(db, { ...input, contextSnapshot: { ...context, completionReceiptId: randomUUID() } })).toBe("stale");
    await issueService(db).update(f.child.id, { status: "todo" });
    expect(await taskCompletionReceiptState(db, input)).toBe("stale");
    await f.finish(); expect(await f.receipts()).toHaveLength(2);
  });

  it("limits native receipt tools to reads and a single acknowledgement", async () => {
    const f = await seed(); await f.finish(); const [receipt] = await f.receipts(); const runId = randomUUID();
    const contextSnapshot = receipt.payload!._paperclipWakeContext as Record<string, unknown>;
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.brain, status: "running", runtimeMode: "native",
      nativeIssueId: f.child.id, invocationSource: "on_demand", contextSnapshot });
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, issueId: f.child.id, agentId: f.brain, runId, completionReceipt: true });
    try {
      for (const tool of ["workspace_run", "create_task", "set_task_monitor", "write_document", "call_api"]) {
        await expect(authority.execute({ tool, callId: randomUUID(), arguments: {} })).rejects.toThrow("Completion receipts permit");
      }
      const args = { tool: "report_progress", callId: randomUUID(), arguments: { body: "Acknowledged frozen candidate and saved test results", idempotencyKey: "receipt" } };
      const first = await authority.execute(args);
      expect(await authority.execute({ ...args, callId: randomUUID() })).toEqual(first);
      expect(await taskCompletionReceiptState(db, { companyId: f.companyId, issueId: f.child.id, agentId: f.brain, contextSnapshot })).toBe("stale");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.child.id)); expect(comments).toHaveLength(1);
    } finally { authority.close(); }
  });

  it("dispatches the existing receipt once, acknowledges on the original task, and never takes worker ownership", async () => {
    const f = await seed(); const heartbeat = heartbeatService(db); heartbeat.startTaskDrain();
    try {
      await f.finish();
      execute.mockImplementation(async () => {
        const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.brain), eq(heartbeatRuns.status, "running")));
        expect(run?.contextSnapshot?.paperclipTaskMarkdown).toContain("delegated completion receipt");
        expect(run?.contextSnapshot?.paperclipTaskMarkdown).toContain("abc123");
        const first = await issueService(db).addComment(f.child.id, "Acknowledged abc123 and saved evidence; no tests repeated", { agentId: f.brain, runId: run.id });
        const duplicate = await issueService(db).addComment(f.child.id, "A duplicate acknowledgement must not be published", { agentId: f.brain, runId: run.id });
        expect(duplicate.id).toBe(first.id);
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Acknowledged abc123", provider: "test", model: "test-model" };
      });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      heartbeat.stopTaskDrain(); await heartbeat.resumeQueuedRuns();
      await vi.waitFor(async () => {
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.child.id));
        expect(comments.filter(c => c.authorAgentId === f.brain)).toHaveLength(1);
        const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.brain)));
        expect(runs).toHaveLength(1); expect(runs[0].status).toBe("succeeded");
      }, { timeout: 20_000 });
      const original = await reconcileTaskCompletionReceipt(db, f.companyId, f.child.id);
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      const [child] = await db.select().from(issues).where(eq(issues.id, f.child.id));
      expect(child).toMatchObject({ status: "done", assigneeAgentId: f.worker, executionRunId: null, checkoutRunId: null });
      const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent.id)); expect(parent.status).toBe("done");
      const [receipt] = await f.receipts(); expect(receipt.payload?.completionAcknowledgementCommentId).toEqual(expect.any(String));
      expect(original?.id).toBe(receipt.id);
    } finally { heartbeat.stopTaskDrain(); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);
});
