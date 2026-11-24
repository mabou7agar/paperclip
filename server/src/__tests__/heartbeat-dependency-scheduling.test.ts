import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  costEvents,
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  completionContracts,
  nativeRunResults,
  nativeRunFinalizations,
  workAssessments,
  statusDecisions,
  statusDecisionEffects,
  companies,
  authUsers,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueThreadInteractions,
  issueRecoveryActions,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { listBlockerParkedWakeups } from "../services/blocker-parked-wakeups.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";
import { issueService } from "../services/issues.js";
import { isFamilyTaskAssignee } from "../services/unblock-owner-wake.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Dependency-aware heartbeat test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// These journeys exercise queue admission and release, not disk skill import.
// Keep an unrelated asynchronous inventory scan from racing fixture teardown.
vi.mock("../services/company-skills.js", async () => {
  const actual = await vi.importActual<typeof import("../services/company-skills.js")>("../services/company-skills.js");
  return {
    ...actual,
    companySkillService: (...args: Parameters<typeof actual.companySkillService>) => ({
      ...actual.companySkillService(...args),
      listRuntimeSkillEntries: async () => [],
    }),
  };
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_DEPENDENCY_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat dependency scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat dependency-aware queued run selection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-dependency-scheduling-");
    db = createDb(external ?? tempDb!.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await heartbeat.drainActiveRunExecutions();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Dependency-aware heartbeat test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(statusDecisionEffects);
    await db.delete(statusDecisions);
    await db.delete(workAssessments);
    await db.delete(nativeRunFinalizations);
    await db.delete(nativeRunResults);
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companyMemberships);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await db?.delete(authUsers).where(eq(authUsers.id, "responsible-user"));
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedDispositionRecoveryHold(kind = "deliberate_wait_without_target") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), actionId = randomUUID();
    const blockedAt = new Date("2026-11-06T11:00:00Z");
    await db.insert(companies).values({ id: companyId, name: "Recovery guard", issuePrefix: `R${companyId.slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Waiting for operator repair", status: "blocked",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user", blockedTransitionAt: blockedAt });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId,
      kind, cause: kind === "stranded_assigned_issue" ? "provider_quota" : "deliberate_wait_without_target", ownerType: "board",
      fingerprint: "exhausted-episode", nextAction: "Restore API access and explicitly retry.",
      evidence: { terminalReason: "unchanged_source_state_exhausted" }, wakePolicy: { type: "board_escalation" } });
    return { companyId, agentId, issueId, actionId, blockedAt };
  }

  it.each(["deliberate_wait_without_target", "stranded_assigned_issue"])("holds repeated dependency wakes for %s until the board resolves it", async (kind) => {
    const { companyId, agentId, issueId, actionId, blockedAt } = await seedDispositionRecoveryHold(kind);
    mockAdapterExecute.mockImplementation(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Recovered.", provider: "test", model: "test-model" };
    });
    const wake = () => heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_blockers_resolved", requestedByActorType: "system", requestedByActorId: "test-recovery",
      payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_blockers_resolved" } });
    for (let i = 0; i < 20; i++) expect(await wake()).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ reason: "issue_recovery_requires_board", status: "skipped", coalescedCount: 19 });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked", blockedTransitionAt: blockedAt });
    await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date(), outcome: "handed_back" }).where(eq(issueRecoveryActions.id, actionId));
    expect(await wake()).not.toBeNull();
    expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1)).toBe(true);
    await heartbeat.drainActiveRunExecutions();
  }, 30_000);

  it("rechecks the disposition hold before a previously queued dependency run starts", async () => {
    const { companyId, agentId, issueId, actionId } = await seedDispositionRecoveryHold();
    await db.update(issueRecoveryActions).set({ status: "resolved" }).where(eq(issueRecoveryActions.id, actionId));
    const busyIssueId = randomUUID();
    await db.insert(issues).values({ id: busyIssueId, companyId, title: "Occupy the worker", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mockAdapterExecute.mockImplementation(async () => {
      await gate;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, busyIssueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Finished.", provider: "test", model: "test-model" };
    });
    try {
      expect(await heartbeat.wakeup(agentId, { source: "assignment", reason: "issue_assigned", payload: { issueId: busyIssueId },
        contextSnapshot: { issueId: busyIssueId, wakeReason: "issue_assigned" } })).not.toBeNull();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1)).toBe(true);
      const queued = await heartbeat.wakeup(agentId, { source: "automation", reason: "issue_blockers_resolved", payload: { issueId },
        contextSnapshot: { issueId, wakeReason: "issue_blockers_resolved" } });
      expect(queued?.status).toBe("queued");
      await db.update(issueRecoveryActions).set({ status: "active" }).where(eq(issueRecoveryActions.id, actionId));
      release();
      expect(await waitForCondition(async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
        return run?.status === "cancelled";
      })).toBe(true);
      const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
      expect(cancelled?.errorCode).toBe("issue_recovery_requires_board");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    } finally { release(); await heartbeat.drainActiveRunExecutions(); }
  }, 30_000);

  it("delivers a revised native child completion after the running parent blocks", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const childId = randomUUID();
    const decisionId = randomUUID();
    let finishParent!: () => void;
    const parentFinished = new Promise<void>((resolve) => { finishParent = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await parentFinished;
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Waiting for the child revision.", provider: "test", model: "test-model" };
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"),
      ));
      await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId,
        authorType: "agent", createdByRunId: run!.id, body: "Reviewed and delivered the revised ZIP." });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Reviewed and delivered the revised ZIP.", provider: "test", model: "test-model" };
    });
    await db.insert(companies).values({ id: companyId, name: "Native handoff",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Parent", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Deliver the revised ZIP", status: "todo",
        assigneeAgentId: agentId, responsibleUserId: "responsible-user" },
      { id: childId, companyId, parentId: issueId, title: "Revise the ZIP", status: "done",
        responsibleUserId: "responsible-user" },
    ]);
    try {
      const parentRun = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system",
        reason: "issue_assigned", payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
      expect(parentRun).not.toBeNull();
      await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId,
        authorType: "agent", createdByRunId: parentRun!.id, body: "Waiting for the child revision." });
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000)).toBe(true);
      const [intent] = await db.insert(agentWakeupRequests).values({ companyId, agentId,
        source: "automation", triggerDetail: "system", reason: "issue_children_completed",
        requestedByActorType: "system", requestedByActorId: "native-status-committer",
        idempotencyKey: `issue_children_completed:${issueId}:${childId}:${decisionId}`,
        payload: { issueId, taskId: issueId, _paperclipWakeContext: {
          issueId, taskId: issueId, source: "native_status_decision",
          nativeChildCompletionDecisionId: decisionId, completedChildIssueId: childId,
          childIssueIds: [childId], childIssueSummaries: [{ id: childId, summary: "Revised ZIP: 11 tests." }],
        } },
      }).returning();
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      const deferred = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!.runId).toBeNull();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      finishParent();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 2, 10_000)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs.map((run) => ({ id: run.id, status: run.status, context: run.contextSnapshot, error: run.error }))).toHaveLength(2);
      const continuation = runs.find((run) => run.id !== parentRun!.id)!;
      expect(continuation.contextSnapshot).toMatchObject({
        wakeReason: "issue_children_completed", nativeChildCompletionDecisionId: decisionId,
        nativeStatusWakeIntentId: intent!.id, completedChildIssueId: childId,
        childIssueSummaries: [{ id: childId, summary: "Revised ZIP: 11 tests." }],
      });
      expect(continuation.status).toBe("succeeded");
      const first = runs.find((run) => run.id === parentRun!.id)!;
      expect(continuation.startedAt!.getTime()).toBeGreaterThanOrEqual(first.finishedAt!.getTime());
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
    } finally {
      finishParent();
    }
  }, 45_000);

  it("keeps a saved native continuation behind its active predecessor without retagging that run", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    let finishPredecessor!: () => void;
    const predecessorFinished = new Promise<void>(resolve => { finishPredecessor = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await predecessorFinished;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "The repository is staged; continue on the saved admission.", provider: "test", model: "test-model" };
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Verified and delivered the prepared repository.", provider: "test", model: "test-model" };
    });
    await db.insert(companies).values({ id: companyId, name: "Saved repository continuation",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Repository worker", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue repository verification", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    try {
      const predecessor = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId }, contextSnapshot: { issueId, source: "initial-repository-request" } });
      expect(predecessor).not.toBeNull();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000)).toBe(true);
      const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
      await db.update(heartbeatRuns).set({ nativeIssueId: issueId, completionContractId: contractId }).where(eq(heartbeatRuns.id, predecessor!.id));
      await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: predecessor!.id,
        completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
      await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: predecessor!.id,
        contractId, resultId, triggerKind: "turn_finished", triggerActorCompanyId: companyId,
        priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "test", assessmentJson: {}, inputDigest: assessmentId });
      await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: predecessor!.id,
        assessmentId, decisionVersion: 1, policyVersion: "test", fromStatus: "in_progress", toStatus: "in_progress",
        reasonCode: "live_continuation_registered", decisionJson: {}, decisionDigest: decisionId, applicationState: "applied", appliedAt: new Date() });
      const [intent] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
        reason: "issue_status_changed", requestedByActorType: "system", requestedByActorId: "native-status-committer",
        idempotencyKey: `native-status:${decisionId}:continuation`, payload: { issueId, taskId: issueId, nativeDecisionId: decisionId, continuationKind: "same_agent",
          _paperclipWakeContext: { issueId, taskId: issueId, source: "native_status_decision", continuationKind: "same_agent" } } }).returning();
      await db.insert(statusDecisionEffects).values({ companyId, issueId, decisionId, ordinal: 0,
        effectKind: "enqueue_continuation", targetType: "agent_wakeup_request", targetId: intent!.id,
        idempotencyKey: `native-status:${decisionId}:continuation`, payload: { continuationKind: "same_agent" }, deliveryState: "delivered", deliveredAt: new Date() });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      const queued = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(queued.filter(row => row.status === "deferred_issue_execution"), JSON.stringify(queued.map(row => ({ status: row.status, reason: row.reason, runId: row.runId, error: row.error })))).toHaveLength(1);
      expect(queued.find(row => row.id === intent!.id)).toMatchObject({ status: "coalesced", runId: null });
      const [unchanged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, predecessor!.id));
      expect(unchanged!.contextSnapshot).toMatchObject({ source: "initial-repository-request" });
      expect(unchanged!.contextSnapshot?.nativeStatusWakeIntentId).toBeUndefined();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      finishPredecessor();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 2, 10_000)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      const completed = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(completed).toHaveLength(2);
      const successor = completed.find(run => run.id !== predecessor!.id)!;
      expect(successor).toMatchObject({ status: "succeeded", contextSnapshot: { source: "native_status_decision", nativeStatusWakeIntentId: intent!.id } });
      expect(successor.startedAt!.getTime()).toBeGreaterThanOrEqual(completed.find(run => run.id === predecessor!.id)!.finishedAt!.getTime());
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
    } finally { finishPredecessor(); }
  }, 45_000);

  it("dispatches and coalesces durable native status wake intents into one heartbeat run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NativeWakeRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resume after native child completion",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    const nativeWakePayload = {
      issueId,
      taskId: issueId,
      _paperclipWakeContext: {
        issueId,
        taskId: issueId,
        source: "native_status_decision",
      },
    };
    const intents = await db.insert(agentWakeupRequests).values([
      {
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_children_completed",
        payload: nativeWakePayload,
        requestedByActorType: "system",
        requestedByActorId: "native-status-committer",
        idempotencyKey: `native-parent:${issueId}`,
      },
      {
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: nativeWakePayload,
        requestedByActorType: "system",
        requestedByActorId: "native-status-committer",
        idempotencyKey: `native-dependency:${issueId}`,
      },
    ]).returning({ id: agentWakeupRequests.id });

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ scanned: 2, dispatched: 1, recovered: 1 });

    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const dispatchedRequests = await db.select().from(agentWakeupRequests).where(
      sql`${agentWakeupRequests.requestedByActorId} like 'native-status-wake-dispatch:%'`,
    );
    expect(dispatchedRequests).toHaveLength(1);
    const dispatchedRun = runs.find((run) => run.id === dispatchedRequests[0]!.runId);
    expect(dispatchedRun).toMatchObject({
      status: "succeeded",
      agentId,
      contextSnapshot: {
        source: "native_status_decision",
        statusDecisionSource: "native_status_decision",
      },
    });

    const persistedIntents = await db.select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
    }).from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, intents.map((intent) => intent.id)));
    expect(persistedIntents).toHaveLength(2);
    expect(persistedIntents).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "coalesced", runId: dispatchedRun!.id }),
      expect.objectContaining({ status: "coalesced", runId: dispatchedRun!.id }),
    ]));
    expect(dispatchedRequests[0]).toMatchObject({ runId: dispatchedRun!.id });
  });

  it.each(["onboarding", "ordinary", "cancelled"])("dispatches only a verified completed onboarding report: %s", async kind => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), childId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Completion", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Parent", status: kind === "cancelled" ? "cancelled" : "done",
      originKind: kind === "ordinary" ? "manual" : "onboarding_first_task", assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    await db.insert(issues).values({ id: childId, companyId, title: "Saved result", parentId: issueId, status: "done", assigneeAgentId: agentId });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system", reason: "issue_children_completed",
      requestedByActorType: "system", requestedByActorId: "native-status-committer", idempotencyKey: `onboarding-completed:${issueId}`,
      payload: { issueId, _paperclipWakeContext: { issueId, completedChildIssueId: childId, onboardingCompletion: true } } });
    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result.dispatched).toBe(kind === "onboarding" ? 1 : 0);
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(kind === "onboarding" ? 1 : 0);
    if (kind === "onboarding") {
      expect({ status: runs[0].status, errorCode: runs[0].errorCode, error: runs[0].error })
        .toEqual({ status: "succeeded", errorCode: null, error: null });
      expect(runs[0].contextSnapshot).toMatchObject({
        onboardingCompletion: true, chatCompletionUpdates: [expect.objectContaining({ id: childId, status: "done" })],
      });
      expect(mockAdapterExecute).toHaveBeenCalledOnce();
    }
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe(kind === "cancelled" ? "cancelled" : "done");
  });

  it("coalesces the native intent when dispatch admission defers behind an active issue run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NativeWakeRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native wake behind active run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      executionRunId: activeRunId,
      executionLockedAt: new Date(),
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: activeRunId,
      evidence: { runId: activeRunId },
      nextAction: "Wait for the active execution to stop.",
    });
    const [intent] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId, taskId: issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: `native-race:${issueId}`,
    }).returning();

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ scanned: 1, dispatched: 0, deferred: 1 });

    const rows = await db.select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
    }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(rows.find((row) => row.id === intent!.id)).toMatchObject({
      status: "coalesced",
      runId: null,
    });
    expect(rows.filter((row) => row.status === "deferred_issue_execution")).toHaveLength(1);
    expect(rows.filter((row) => row.requestedByActorId?.startsWith("native-status-wake-dispatch:"))).toHaveLength(1);

    // Simulate the process crash window after the dispatch receipt was written
    // but before the committer intent was reconciled.
    await db.update(agentWakeupRequests).set({ status: "queued", updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, intent!.id));
    const recovered = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(recovered).toMatchObject({ scanned: 1, recovered: 1 });
    const recoveredIntent = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent!.id))
      .then((result) => result[0]);
    expect(recoveredIntent).toMatchObject({ status: "coalesced" });
  });

  it("keeps blocked descendants idle until their blockers resolve", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Mission 0",
        status: "todo",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Mission 2",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: readyIssueId,
        companyId,
        title: "Mission 1",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    expect(blockedWake).toBeNull();

    const blockedWakeRequest = await waitForCondition(async () => {
      const wakeup = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
          ),
        )
        .orderBy(agentWakeupRequests.requestedAt)
        .then((rows) => rows[0] ?? null);
      return Boolean(
        wakeup &&
        wakeup.status === "skipped" &&
        wakeup.reason === "issue_dependencies_blocked",
      );
    });
    expect(blockedWakeRequest).toBe(true);

    const blockedRunsBeforeResolution = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${blockedIssueId}`)
      .then((rows) => rows[0]?.count ?? 0);
    expect(blockedRunsBeforeResolution).toBe(0);

    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId: blockedIssueId,
      authorType: "user", authorUserId: "responsible-user",
      body: "Explain the current dependency without starting blocked work.",
    });
    const interactionWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: blockedIssueId, commentId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_commented",
      },
    });
    expect(interactionWake).not.toBeNull();

    // This checks dependency interaction semantics, not provider startup speed.
    // Join the admitted execution before inspecting its persisted outcome.
    await heartbeat.drainActiveRunExecutions();

    const interactionRun = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, interactionWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(interactionRun?.status).toBe("succeeded");
    expect(interactionRun?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
    });

    let finishReadyRun!: () => void;
    const readyRunCanFinish = new Promise<void>((resolve) => {
      finishReadyRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await readyRunCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Ready dependency scheduling run complete.",
        provider: "test",
        model: "test-model",
      };
    });

    const readyWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: readyIssueId },
      contextSnapshot: { issueId: readyIssueId, wakeReason: "issue_assigned" },
    });
    expect(readyWake).not.toBeNull();
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyWake!.id,
      body: "Ready dependency scheduling run complete.",
    });
    finishReadyRun();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const readyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, readyWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(readyRun?.status).toBe("succeeded");

    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, blockerId));

    const promotedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });
    expect(promotedWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, promotedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const promotedBlockedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promotedWake!.id))
      .then((rows) => rows[0] ?? null);
    const blockedWakeRequestCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);

    expect(promotedBlockedRun?.status).toBe("succeeded");
    expect(blockedWakeRequestCount).toBeGreaterThanOrEqual(2);

    const noActiveRuns = await waitForCondition(async () => {
      const rows = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    }, 10_000);
    expect(noActiveRuns).toBe(true);
  });

  async function seedAnsweredQuestionOnBlockedTask(options: { withSourceComment: boolean; interactionStatus?: string; issueStatus?: string }) {
    const companyId = randomUUID(), askerId = randomUUID(), answererId = randomUUID();
    const blockerId = randomUUID(), issueId = randomUUID(), interactionId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Answered question", issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values([askerId, answererId].map((id, index) => ({
      id, companyId, name: index === 0 ? "Delivery Lead" : "CTO", role: index === 0 ? "pm" : "cto", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    })));
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Child waiting for the answer", status: "blocked", priority: "high", responsibleUserId: "responsible-user" },
      { id: issueId, companyId, title: "Parent that asked", status: options.issueStatus ?? "blocked", priority: "high", assigneeAgentId: askerId, responsibleUserId: "responsible-user",
        // Already worked on once, so the never-started exception for todo tasks does not apply.
        startedAt: new Date("2026-11-20T09:00:00.000Z") },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    const sourceCommentId = options.withSourceComment ? randomUUID() : null;
    if (sourceCommentId) {
      await db.insert(issueComments).values({
        id: sourceCommentId, companyId, issueId, authorType: "agent", authorAgentId: askerId, body: "Which option should the child task take?",
      });
    }
    const interactionStatus = options.interactionStatus ?? "answered";
    await db.insert(issueThreadInteractions).values({
      id: interactionId, companyId, issueId, kind: "ask_user_questions", status: interactionStatus,
      createdByAgentId: askerId, addresseeAgentId: answererId, sourceCommentId,
      resolvedByAgentId: interactionStatus === "answered" ? answererId : null,
      resolvedAt: interactionStatus === "answered" ? new Date() : null,
      payload: { version: 1, questions: [{ id: "option", prompt: "Which option should the child task take?", selectionMode: "single", required: true,
        options: [{ id: "first", label: "First" }] }] },
      result: interactionStatus === "answered" ? { version: 1, answers: [{ questionId: "option", optionIds: ["first"] }] } : null,
    });
    // The same wake the question-response delivery sends to the task assignee.
    const wake = (overrides: { idempotencyKey?: string | null } = {}) => heartbeat.wakeup(askerId, {
      source: "automation", triggerDetail: "system", reason: "issue_commented",
      payload: {
        issueId, interactionId, interactionKind: "ask_user_questions", interactionStatus: "answered",
        sourceCommentId, sourceRunId: null, externalChatContinuation: false,
        ...(sourceCommentId ? { wakeCommentId: sourceCommentId, wakeCommentIds: [sourceCommentId] } : {}),
        mutation: "interaction",
      },
      idempotencyKey: overrides.idempotencyKey === undefined ? `question-response:${interactionId}` : overrides.idempotencyKey,
      requestedByActorType: "agent", requestedByActorId: answererId,
      contextSnapshot: {
        issueId, taskId: issueId, interactionId, interactionKind: "ask_user_questions", interactionStatus: "answered",
        mutation: "interaction", sourceCommentId, sourceRunId: null, externalChatContinuation: false,
        ...(sourceCommentId ? { wakeCommentId: sourceCommentId, wakeCommentIds: [sourceCommentId] } : {}),
        wakeReason: "issue_commented", source: "issue.interaction.respond",
      },
    });
    return { companyId, askerId, answererId, blockerId, issueId, interactionId, wake };
  }

  it.each([
    { name: "with the question's source comment", withSourceComment: true },
    { name: "without a source comment", withSourceComment: false },
  ])("runs the assignee of a blocked task when its question is answered ($name)", async ({ withSourceComment }) => {
    const seeded = await seedAnsweredQuestionOnBlockedTask({ withSourceComment });
    const answeredWake = await seeded.wake();
    expect(answeredWake).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const run = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, answeredWake!.id)).then((rows) => rows[0] ?? null);
    expect(run?.errorCode ?? null).toBeNull();
    expect(run?.status).toBe("succeeded");
    // The blocker is still unresolved, so the turn stays in the restricted answer-and-triage mode.
    expect(run?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [seeded.blockerId],
    });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("runs the assignee of a todo task that waits on blockers when its question is answered", async () => {
    // The gate at enqueue and claim does not look at the status, so the later checks must agree with it.
    const seeded = await seedAnsweredQuestionOnBlockedTask({ withSourceComment: false, issueStatus: "todo" });
    const answeredWake = await seeded.wake();
    expect(answeredWake).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const run = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, answeredWake!.id)).then((rows) => rows[0] ?? null);
    expect(run?.errorCode ?? null).toBeNull();
    expect(run?.status).toBe("succeeded");
    expect(run?.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
    // The task was not started: it still waits on its blocker.
    const task = await db.select({ status: issues.status, checkoutRunId: issues.checkoutRunId }).from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]);
    expect(task).toMatchObject({ status: "todo", checkoutRunId: null });
  });

  it("keeps a task the board parked in the backlog idle when its question is answered", async () => {
    const seeded = await seedAnsweredQuestionOnBlockedTask({ withSourceComment: false, issueStatus: "backlog" });
    const wake = await seeded.wake();
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    if (wake) {
      const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.id)).then((rows) => rows[0]);
      expect(run?.status).toBe("cancelled");
    }
  });

  it("lets an answer pass the blocker gate only under the delivery's own wake key", async () => {
    const seeded = await seedAnsweredQuestionOnBlockedTask({ withSourceComment: false });
    // The same context without the key, or under another key, is an ordinary wake on a blocked task.
    expect(await seeded.wake({ idempotencyKey: null })).toBeNull();
    expect(await seeded.wake({ idempotencyKey: `question-response:${randomUUID()}` })).toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    // The delivery's wake runs, once.
    expect(await seeded.wake()).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("keeps a blocked task idle when the wake claims an answer the question does not have", async () => {
    // The card is still pending: a wake context saying "answered" is not proof.
    const seeded = await seedAnsweredQuestionOnBlockedTask({ withSourceComment: false, interactionStatus: "pending" });
    expect(await seeded.wake()).toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const wakeup = await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.askerId)).then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({ status: "skipped", reason: "issue_dependencies_blocked" });
  });

  it("keeps automatic wakes on a blocked task suppressed after its question was answered", async () => {
    const seeded = await seedAnsweredQuestionOnBlockedTask({ withSourceComment: false });
    const automatic = await heartbeat.wakeup(seeded.askerId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: seeded.issueId },
      contextSnapshot: { issueId: seeded.issueId, wakeReason: "issue_assigned" },
    });
    expect(automatic).toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("wakes the assignee waiting on a task its own worker parks as blocked, once per transition", async () => {
    const companyId = randomUUID(), engineerId = randomUUID(), qaId = randomUUID();
    const blockerId = randomUUID(), waiterId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Parked blocker", issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values([engineerId, qaId].map((id, index) => ({
      id, companyId, name: index === 0 ? "Backend Engineer" : "QA Engineer", role: index === 0 ? "engineer" : "qa", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    })));
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Build the package", status: "in_progress", priority: "high", assigneeAgentId: engineerId, responsibleUserId: "responsible-user" },
      { id: waiterId, companyId, title: "Verify the package", status: "blocked", priority: "high", assigneeAgentId: qaId, responsibleUserId: "responsible-user" },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: waiterId, type: "blocks" });
    const deliver = async () => {
      const wakeups = await listBlockerParkedWakeups(db, { companyId, blockerIssueId: blockerId });
      const runs = [];
      for (const parked of wakeups) {
        runs.push(await heartbeat.wakeup(parked.agentId, { ...parked.wakeup, requestedByActorType: "agent", requestedByActorId: engineerId }));
      }
      await heartbeat.drainActiveRunExecutions();
      return { wakeups, runs };
    };

    // Nothing is owed while the blocker is still being worked on.
    expect((await deliver()).wakeups).toEqual([]);

    const firstParkedAt = new Date("2026-11-22T10:00:00.000Z");
    await db.update(issues).set({ status: "blocked", blockedTransitionAt: firstParkedAt }).where(eq(issues.id, blockerId));
    const first = await deliver();
    expect(first.wakeups.map((parked) => parked.agentId)).toEqual([qaId]);
    expect(first.runs[0]).not.toBeNull();
    const run = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runs[0]!.id)).then((rows) => rows[0] ?? null);
    expect(run?.errorCode ?? null).toBeNull();
    expect(run?.status).toBe("succeeded");
    // The dependency is still unresolved, so the waiter gets the restricted turn, not its normal work.
    expect(run?.contextSnapshot).toMatchObject({
      wakeReason: "issue_blocker_parked",
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
      blockerParked: { blockerIssueId: blockerId, blockedTransitionAt: firstParkedAt.toISOString() },
    });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    // The same transition never wakes twice.
    expect((await deliver()).wakeups).toEqual([]);

    // The wake context alone is not enough: without the transition's key it stays behind the dependency gate.
    const forged = await heartbeat.wakeup(qaId, {
      source: "automation", triggerDetail: "system", reason: "issue_blocker_parked",
      payload: { issueId: waiterId }, requestedByActorType: "agent", requestedByActorId: qaId,
      contextSnapshot: { ...first.wakeups[0]!.wakeup.contextSnapshot },
    });
    expect(forged).toBeNull();

    // Resumed and parked again: a new transition wakes the waiter again.
    await db.update(issues).set({ status: "in_progress", blockedTransitionAt: null }).where(eq(issues.id, blockerId));
    expect((await deliver()).wakeups).toEqual([]);
    await db.update(issues).set({ status: "blocked", blockedTransitionAt: new Date("2026-11-22T12:30:00.000Z") }).where(eq(issues.id, blockerId));
    const second = await deliver();
    expect(second.wakeups).toHaveLength(1);
    expect(second.runs[0]).not.toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
  });

  it("runs the waiting assignee when a native status commit parks its blocker", async () => {
    const companyId = randomUUID(), engineerId = randomUUID(), qaId = randomUUID();
    const blockerId = randomUUID(), waiterId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Native parked blocker", issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values([engineerId, qaId].map((id, index) => ({
      id, companyId, name: index === 0 ? "Backend Engineer" : "QA Engineer", role: index === 0 ? "engineer" : "qa", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    })));
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Build the package", status: "in_progress", priority: "high", assigneeAgentId: engineerId, responsibleUserId: "responsible-user" },
      { id: waiterId, companyId, title: "Verify the package", status: "blocked", priority: "high", assigneeAgentId: qaId, responsibleUserId: "responsible-user" },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: waiterId, type: "blocks" });
    // The engineer's native run reports the task blocked; the committer records it.
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId: blockerId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "parked-test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", criteria: [] }, canonicalSha256: randomUUID(), createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: engineerId, status: "running", runtimeMode: "native",
      nativeIssueId: blockerId, completionContractId: contractId, contextSnapshot: { issueId: blockerId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId: blockerId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() });
    const [task] = await db.select().from(issues).where(eq(issues.id, blockerId));
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId: blockerId, runId, contractId, resultId,
      triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: task!.status,
      priorStatusVersion: task!.statusVersion, policyVersion: "parked-test", assessmentJson: {}, inputDigest: randomUUID() });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: blockerId, phase: "arbitrating", resultId });
    await commitNativeStatusDecision({ db, companyId, issueId: blockerId, runId, assessmentId,
      priorStatus: task!.status, priorStatusVersion: task!.statusVersion, priorDecisionId: task!.lastStatusDecisionId,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "blocked", toStatus: "blocked",
        reasonCode: "parked_blocker_test", unblockDescriptor: null, effects: [] } });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));

    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.drainActiveRunExecutions();
    const waiterRuns = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, qaId)));
    expect(waiterRuns).toHaveLength(1);
    expect(waiterRuns[0]!.errorCode ?? null).toBeNull();
    expect(waiterRuns[0]!.status).toBe("succeeded");
    // The dependency is still unresolved, so the waiter gets the restricted turn, not its normal work.
    expect(waiterRuns[0]!.contextSnapshot).toMatchObject({
      wakeReason: "issue_blocker_parked",
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
      blockerParked: { blockerIssueId: blockerId },
    });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    // Another dispatch pass delivers nothing new.
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    // The native source alone is not enough: without the transition's key the wake stays behind the dependency gate.
    const forged = await heartbeat.wakeup(qaId, {
      source: "automation", triggerDetail: "system", reason: "issue_blocker_parked",
      payload: { issueId: waiterId }, requestedByActorType: "agent", requestedByActorId: qaId,
      contextSnapshot: { ...(waiterRuns[0]!.contextSnapshot as Record<string, unknown>), dependencyBlockedInteraction: undefined },
    });
    expect(forged).toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    // The finalization row references the committed decision; release it before shared cleanup.
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
  });

  it("runs the agent a blocked sibling task names as the one who must unblock it", async () => {
    // Live shape: engineer and QA tasks are siblings under one parent, with no blocks relation.
    const companyId = randomUUID(), engineerId = randomUUID(), qaId = randomUUID();
    const parentId = randomUUID(), engineerTaskId = randomUUID(), qaTaskId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Sibling hand-off", issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values([engineerId, qaId].map((id, index) => ({
      id, companyId, name: index === 0 ? "Backend Engineer" : "QA Engineer", role: index === 0 ? "engineer" : "qa", status: "active",
      adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    })));
    const parkedAt = new Date("2026-11-22T19:31:28.000Z");
    await db.insert(issues).values([
      { id: parentId, companyId, title: "Delivery", status: "blocked", priority: "high", responsibleUserId: "responsible-user" },
      { id: engineerTaskId, companyId, parentId, title: "Correct the package", status: "blocked", blockedTransitionAt: parkedAt, priority: "high",
        assigneeAgentId: engineerId, responsibleUserId: "responsible-user",
        unblockDescriptor: { owner: { agentId: qaId }, action: "Publish the review disposition on the QA task." } },
      { id: qaTaskId, companyId, parentId, title: "Qualify the package", status: "in_review", priority: "high", assigneeAgentId: qaId, responsibleUserId: "responsible-user" },
    ]);
    // The engineer may name QA because QA holds a sibling task; an agent outside the family may not be named.
    const engineerTask = { id: engineerTaskId, parentId };
    expect(await isFamilyTaskAssignee(db, { companyId, issue: engineerTask, agentId: qaId })).toBe(true);
    expect(await isFamilyTaskAssignee(db, { companyId, issue: engineerTask, agentId: randomUUID() })).toBe(false);
    expect(await isFamilyTaskAssignee(db, { companyId, issue: { id: parentId, parentId: null }, agentId: qaId })).toBe(false);

    // A wake that only claims the reason, without the transition's key, is still refused.
    const forged = await heartbeat.wakeup(qaId, {
      source: "automation", triggerDetail: "system", reason: "issue_unblock_requested",
      payload: { issueId: engineerTaskId, action: "x" },
      contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: engineerTaskId, taskId: engineerTaskId },
    });
    await heartbeat.drainActiveRunExecutions();
    if (forged) {
      const forgedRun = await db.select({ errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(eq(heartbeatRuns.id, forged.id)).then((rows) => rows[0]);
      expect(forgedRun?.errorCode).toBe("issue_assignee_changed");
    }
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wake = await heartbeat.wakeup(qaId, {
      source: "automation", triggerDetail: "system", reason: "issue_unblock_requested",
      idempotencyKey: `issue-unblock:${engineerTaskId}:${parkedAt.toISOString()}`,
      payload: { issueId: engineerTaskId, action: "Publish the review disposition on the QA task." },
      contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: engineerTaskId, taskId: engineerTaskId },
    });
    expect(wake).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const run = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.id)).then((rows) => rows[0] ?? null);
    expect(run?.errorCode ?? null).toBeNull();
    expect(run?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

    // The owner's run acted on a request. It did not take the task: no checkout, no
    // execution lock, and the assignee and status are as the engineer left them.
    const after = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId, checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, engineerTaskId)).then((rows) => rows[0]);
    expect(after).toEqual({ status: "blocked", assigneeAgentId: engineerId, checkoutRunId: null, executionRunId: null });
    const context = (await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.id)).then((rows) => rows[0]))?.contextSnapshot as Record<string, unknown>;
    expect(Object.entries(context).filter(([key, value]) => /checkout/i.test(key) && value === true)).toEqual([]);
    // Nor can it check the task out for itself afterwards.
    await expect(issueService(db).checkout(engineerTaskId, qaId, ["blocked", "todo", "in_progress"], wake!.id)).rejects.toMatchObject({ status: 409 });
  });

  it("does not wake a waiter held by the agent that parked the blocker, or one that is finished", async () => {
    const companyId = randomUUID(), engineerId = randomUUID(), qaId = randomUUID();
    const blockerId = randomUUID(), ownWaiterId = randomUUID(), doneWaiterId = randomUUID(), backlogWaiterId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Parked blocker scope", issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([engineerId, qaId].map((id, index) => ({
      id, companyId, name: index === 0 ? "Backend Engineer" : "QA Engineer", role: index === 0 ? "engineer" : "qa", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Build the package", status: "blocked", blockedTransitionAt: new Date(), priority: "high", assigneeAgentId: engineerId },
      { id: ownWaiterId, companyId, title: "Engineer's own follow-up", status: "blocked", priority: "high", assigneeAgentId: engineerId },
      { id: doneWaiterId, companyId, title: "Finished check", status: "done", priority: "high", assigneeAgentId: qaId },
      { id: backlogWaiterId, companyId, title: "Parked by the board", status: "backlog", priority: "high", assigneeAgentId: qaId },
    ]);
    await db.insert(issueRelations).values([ownWaiterId, doneWaiterId, backlogWaiterId].map((relatedIssueId) => ({
      companyId, issueId: blockerId, relatedIssueId, type: "blocks" as const,
    })));
    expect(await listBlockerParkedWakeups(db, { companyId, blockerIssueId: blockerId })).toEqual([]);
  });

  it("resumes normal work once after a child completes during the parent's restricted triage turn", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), blockerId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Triage handoff", issuePrefix: "TH", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coordinator", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Child", status: "in_progress", priority: "medium" },
      { id: issueId, companyId, title: "Parent", status: "blocked", priority: "medium", assigneeAgentId: agentId, responsibleUserId: "responsible-user" },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "responsible-user", body: "Triage the pending child." });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await gate;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Triage finished", provider: "test", model: "test-model" };
    });
    const triage = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: { issueId, commentId }, contextSnapshot: { issueId, wakeReason: "issue_commented" } });
    try {
      expect(triage).not.toBeNull();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 10_000)).toBe(true);
      await db.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, blockerId));
      const request = { source: "automation" as const, triggerDetail: "system" as const, reason: "issue_children_completed",
        idempotencyKey: `child-terminal:${issueId}:${blockerId}`, payload: { issueId, completedChildIssueId: blockerId },
        contextSnapshot: { issueId, wakeReason: "issue_children_completed", completedChildIssueId: blockerId } };
      await heartbeat.wakeup(agentId, request);
      await heartbeat.wakeup(agentId, request);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, request.idempotencyKey));
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!.status).toBe("deferred_issue_execution");
      release();
      expect(await waitForCondition(async () => {
        const runs = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
        return runs.length === 2 && runs.every(r => r.status === "succeeded");
      }, 15_000)).toBe(true);
      const runs = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
      expect(runs.find(r => r.id === triage!.id)?.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true });
      const resumed = runs.find(r => r.id !== triage!.id)!;
      expect(resumed.contextSnapshot?.dependencyBlockedInteraction).not.toBe(true);
      expect(resumed.contextSnapshot?.completedChildIssueId).toBe(blockerId);
      await heartbeat.wakeup(agentId, request);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, request.idempotencyKey))).toHaveLength(1);
    } finally { release(); }
  });

  it("admits an issue_blocker_stalled wake while a blocker is unresolved", async () => {
    // The waiter's blocker stalled on a board-owned recovery action. Parking
    // this wake until the blocker resolves would hide the stall again.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Paperclip", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "CodexCoder", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Stalled blocker", status: "blocked", priority: "high", responsibleUserId: "responsible-user" },
      { id: dependentId, companyId, title: "Waiting dependent", status: "blocked", priority: "medium", assigneeAgentId: agentId,
        responsibleUserId: "responsible-user" },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: dependentId, type: "blocks" });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: blockerId, kind: "run_recovery",
      status: "resolved", outcome: "blocked", ownerType: "board", cause: "native_session_retry_exhausted",
      fingerprint: "stall", nextAction: "Retry", resolvedAt: new Date() }).returning();
    const stallWake = (requestedByActorType: "system" | "agent") => heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blocker_stalled",
      payload: { issueId: dependentId, stalledIssueId: blockerId },
      idempotencyKey: `issue_blocker_stalled:${dependentId}:${blockerId}:${action.id}:${requestedByActorType}`,
      requestedByActorType,
      requestedByActorId: requestedByActorType === "system" ? "issue-blocker-stall" : agentId,
      contextSnapshot: { issueId: dependentId, wakeReason: "issue_blocker_stalled",
        blockerStall: { stalledIssueId: blockerId, relation: "blocker", recoveryAction: { id: action.id } } },
    });

    // The reason string alone is not trusted: an agent cannot use it to skip the blocker gate.
    expect(await stallWake("agent")).toBeNull();

    const stalledWake = await stallWake("system");
    expect(stalledWake).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const [run] = await db.select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, stalledWake!.id));
    expect(run?.status).toBe("succeeded");
    expect(run?.contextSnapshot).toMatchObject({ dependencyBlockedInteraction: true, unresolvedBlockerIssueIds: [blockerId] });

    // A resource wait replaces the run with a server-created retry that keeps
    // the stall context but not the wake reason. The retry gate still admits it.
    const retryGate = async (contextSnapshot: Record<string, unknown>) => {
      const [retry] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation",
        status: "scheduled_retry", scheduledRetryAt: new Date(), scheduledRetryReason: "transient_failure",
        retryOfRunId: stalledWake!.id, contextSnapshot }).returning();
      return createPostgresRunDispatchAdapter(db).evaluateScheduledRetryGate({ companyId, runId: retry.id,
        retryReasonOverride: "transient_failure", now: new Date() });
    };
    const replacement: Record<string, unknown> = { ...(run!.contextSnapshot as Record<string, unknown>),
      wakeReason: "bounded_transient_heartbeat_retry", retryReason: "transient_failure", retryOfRunId: stalledWake!.id };
    expect(await retryGate(replacement)).toMatchObject({ allowed: true });
    const { blockerStall: _stall, ...withoutStall } = replacement;
    expect(await retryGate(withoutStall)).toMatchObject({ allowed: false, errorCode: "issue_dependencies_blocked" });
    // Once the stall's action is no longer current, the retry waits for the blocker like any other.
    await db.update(issueRecoveryActions).set({ outcome: "restored" }).where(eq(issueRecoveryActions.id, action.id));
    expect(await retryGate(replacement)).toMatchObject({ allowed: false, errorCode: "issue_dependencies_blocked" });
  });

  it.each(["issue_blockers_resolved", "issue_children_completed"])("defers %s behind running dependency triage without duplicate wakes", async (reason) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_commented",
        dependencyBlockedInteraction: true,
      },
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Completed prerequisite",
        status: "done",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: activeRunId,
        executionLockedAt: new Date(),
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    runningProcesses.set(activeRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    const idempotencyKey = `${reason}:${blockedIssueId}:${blockerId}`;
    const request = {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason,
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerId,
      },
      idempotencyKey,
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: reason,
        completedChildIssueId: blockerId,
        resolvedBlockerIssueId: blockerId,
      },
    };
    expect(await heartbeat.wakeup(agentId, request)).toBeNull();
    expect(await heartbeat.wakeup(agentId, request)).toBeNull();

    const wakeRequests = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    expect(wakeRequests).toEqual([
      expect.objectContaining({
        status: "deferred_issue_execution",
        reason: "issue_execution_deferred",
        idempotencyKey,
        runId: null,
      }),
    ]);

    runningProcesses.delete(activeRunId);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, activeRunId));
  });

  it("honors maxConcurrentRuns 1 by leaving a second assignment wake queued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First assignment run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    try {
      const firstWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: firstIssueId },
        contextSnapshot: { issueId: firstIssueId, wakeReason: "issue_assigned" },
      });
      expect(firstWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: firstIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: firstWake!.id,
        body: "First assignment run completed.",
      });

      const firstRunStarted = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      expect(firstRunStarted).toBe(true);
      const firstAdapterStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000);
      expect(firstAdapterStarted).toBe(true);

      const secondWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: secondIssueId },
        contextSnapshot: { issueId: secondIssueId, wakeReason: "issue_assigned" },
      });
      expect(secondWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: secondIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: secondWake!.id,
        body: "Second assignment run completed.",
      });

      const secondRunWhileFirstRunning = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(secondRunWhileFirstRunning?.status).toBe("queued");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

      finishFirstRun();

      const firstRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      });
      expect(firstRunSucceeded).toBe(true);

      const secondRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondRunSucceeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("cancels stale queued runs when issue blockers are still unresolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();
    const blockedWakeupRequestId = randomUUID();
    const readyWakeupRequestId = randomUUID();
    const blockedRunId = randomUUID();
    const readyRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QAChecker",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Security review",
        status: "blocked",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "QA validation",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: readyIssueId,
        companyId,
        title: "Ready QA task",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: blockedWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "transient_failure_retry",
        payload: { issueId: blockedIssueId },
        status: "queued",
      },
      {
        id: readyWakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: readyIssueId },
        status: "queued",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: blockedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: blockedWakeupRequestId,
        contextSnapshot: {
          issueId: blockedIssueId,
          wakeReason: "transient_failure_retry",
        },
      },
      {
        id: readyRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: readyWakeupRequestId,
        contextSnapshot: {
          issueId: readyIssueId,
          wakeReason: "issue_assigned",
        },
      },
    ]);
    await db
      .update(agentWakeupRequests)
      .set({ runId: blockedRunId })
      .where(eq(agentWakeupRequests.id, blockedWakeupRequestId));
    await db
      .update(agentWakeupRequests)
      .set({ runId: readyRunId })
      .where(eq(agentWakeupRequests.id, readyWakeupRequestId));
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyRunId,
      body: "Ready queued run completed.",
    });
    await db
      .update(issues)
      .set({
        executionRunId: blockedRunId,
        executionAgentNameKey: "qa-checker",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, blockedIssueId));

    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, readyIssueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Ready queued run completed.", provider: "test", model: "test-model" };
    });
    await heartbeat.resumeQueuedRuns();

    expect(await waitForCondition(async () => {
      const [ready] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, readyRunId));
      return ready?.status === "succeeded";
    }, 30_000)).toBe(true);
    await heartbeat.drainActiveRunExecutions();

    const [blockedRun, blockedWakeup, blockedIssue, readyRun] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          finishedAt: heartbeatRuns.finishedAt,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, blockedRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          status: agentWakeupRequests.status,
          error: agentWakeupRequests.error,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, blockedWakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(blockedRun?.status).toBe("cancelled");
    expect(blockedRun?.errorCode).toBe("issue_dependencies_blocked");
    expect(blockedRun?.finishedAt).toBeTruthy();
    expect(blockedRun?.resultJson).toMatchObject({ stopReason: "issue_dependencies_blocked" });
    expect(blockedRun?.resultJson).toMatchObject({ cancellation: { source: "control_plane", expected: true } });
    const [waitingIssue] = await db.select().from(issues).where(eq(issues.id, blockedIssueId));
    expect(await taskInterruptionPresentation(db, waitingIssue!)).toMatchObject({ state: "resolved", canRetry: false });
    await db.update(heartbeatRuns).set({ resultJson: { ...blockedRun!.resultJson, timeoutFired: true } })
      .where(eq(heartbeatRuns.id, blockedRunId));
    expect(await taskInterruptionPresentation(db, waitingIssue!)).toMatchObject({ state: "failed", canRetry: true });
    await db.update(heartbeatRuns).set({ resultJson: blockedRun!.resultJson }).where(eq(heartbeatRuns.id, blockedRunId));
    expect(blockedWakeup?.status).toBe("skipped");
    expect(blockedWakeup?.error).toContain("dependencies are still blocked");
    expect(blockedIssue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(readyRun?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  }, 40_000);

  it("suppresses normal wakeups while allowing comment interaction wakes under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const issueChain = Array.from({ length: 17 }, () => randomUUID());
    const deepDescendantIssueId = issueChain.at(-1)!;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      ...issueChain.map((issueId, index) => ({
        id: issueId,
        companyId,
        parentId: index === 0 ? rootIssueId : issueChain[index - 1],
        title: `Paused desc ${index + 1}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      })),
    ]);
    const [hold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "security test hold",
        releasePolicy: { strategy: "manual" },
      })
      .returning();

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: deepDescendantIssueId },
      contextSnapshot: { issueId: deepDescendantIssueId, wakeReason: "issue_blockers_resolved" },
    });

    expect(blockedWake).toBeNull();
    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${deepDescendantIssueId}`)
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });

    const childCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: childCommentId,
      companyId,
      issueId: deepDescendantIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const forgedChildCommentWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(forgedChildCommentWake).toBeNull();

    const childCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: deepDescendantIssueId,
        commentId: childCommentId,
        wakeCommentId: childCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(childCommentWake).not.toBeNull();
    const childRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, childCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(childRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        holdId: hold.id,
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  it("allows comment interaction wakes when a legacy hold has a full_pause note", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      title: "Paused root",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "pause",
      status: "active",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });

    const rootCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: rootCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const rootCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: rootIssueId, commentId: rootCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: rootIssueId,
        commentId: rootCommentId,
        wakeCommentId: rootCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(rootCommentWake).not.toBeNull();
    const rootRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, rootCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(rootRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });
});
