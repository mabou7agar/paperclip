import { randomUUID } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import * as runState from "../services/heartbeat/run-state.js";
import * as deferredNotifications from "../services/deferred-execution-notifications.js";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  agentWakeupRequests,
  agentRuntimeState,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  applyPendingMigrations,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  documentRevisions,
  documents,
  environmentLeases,
  nativeRunFinalizations,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueDocuments,
  issueRelations,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";
import {
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";
import { runningProcesses, type AdapterExecutionContext, type AdapterExecutionResult } from "../adapters/index.ts";
import { issueService } from "../services/issues.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { recoveryService } from "../services/recovery/service.ts";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: AdapterExecutionContext): Promise<AdapterExecutionResult> => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale-queue invalidation test run.",
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

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_STALE_QUEUE_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat stale-queue invalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

// Runtime preparation includes accounting and workspace transactions; assert
// the observable handoff rather than a three-second machine-speed assumption.
async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

const HEARTBEAT_INVALIDATION_FIXTURE_TABLES = [
  "company_skills",
  "issue_comments",
  "issue_documents",
  "document_revisions",
  "documents",
  "issue_relations",
  "issue_tree_holds",
  "issues",
  "heartbeat_run_events",
  "cost_events",
  "activity_log",
  "heartbeat_runs",
  "agent_wakeup_requests",
  "agent_runtime_state",
  "agents",
  "companies",
];

// Per-test reset with the same effect as
//   TRUNCATE <fixture tables> RESTART IDENTITY CASCADE
// but without TRUNCATE's file churn. TRUNCATE gives every table it touches a
// new relation file, and CASCADE reaches every company-scoped table (and its
// indexes and TOAST relations). Across this file's 133 tests that left about
// 280,000 files in the cluster's data directory, and removing the directory in
// afterAll took longer than the 30-second hook timeout. DELETE reuses the
// existing files. FK triggers are disabled for the reset, so every table that
// CASCADE would reach is listed explicitly; the list is computed from the live
// schema so new company-scoped tables are covered without editing this file.
async function buildHeartbeatInvalidationResetStatement(db: ReturnType<typeof createDb>): Promise<string> {
  const roots = sql.join(HEARTBEAT_INVALIDATION_FIXTURE_TABLES.map((table) => sql`${table}::regclass`), sql`, `);
  const closure = sql`
    WITH RECURSIVE reached(oid) AS (
      SELECT unnest(ARRAY[${roots}])::oid
      UNION
      SELECT constraint_row.conrelid
      FROM pg_constraint constraint_row
      JOIN reached ON constraint_row.confrelid = reached.oid
      WHERE constraint_row.contype = 'f'
    )`;
  const tables = await db.execute<{ name: string }>(sql`${closure} SELECT oid::regclass::text AS name FROM reached ORDER BY 1`);
  const sequences = await db.execute<{ name: string; start: string }>(sql`${closure}
    SELECT sequence_class.oid::regclass::text AS name, sequence_row.seqstart::text AS start
    FROM pg_depend dependency
    JOIN reached ON dependency.refobjid = reached.oid
    JOIN pg_class sequence_class ON sequence_class.oid = dependency.objid AND sequence_class.relkind = 'S'
    JOIN pg_sequence sequence_row ON sequence_row.seqrelid = sequence_class.oid
    WHERE dependency.classid = 'pg_class'::regclass
      AND dependency.refclassid = 'pg_class'::regclass
      AND dependency.deptype IN ('a', 'i')
    ORDER BY 1`);
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    "DO $reset$ BEGIN",
    "SET LOCAL session_replication_role = replica;",
    ...[...tables].map(({ name }) => `DELETE FROM ${name};`),
    ...[...sequences].map(({ name, start }) => `PERFORM setval(${literal(name)}, ${start}, false);`),
    "END $reset$;",
  ].join("\n");
}

async function cleanupHeartbeatInvalidationFixture(db: ReturnType<typeof createDb>, resetStatement: string) {
  await truncateTablesWithDeadlockRetry(db, resetStatement, { attempts: 10, delayMs: () => 100 });
}

type SeedOptions = {
  agentName?: string;
  agentRole?: string;
  maxConcurrentRuns?: number;
  heartbeatConfig?: Record<string, unknown>;
};

type SeedResult = {
  companyId: string;
  agentId: string;
};

describeEmbeddedPostgres("heartbeat stale queued-run invalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtureResetStatement = "";
  let beforeContinuationDispatchCheck:
    | ((input: { runId: string; issueId: string }) => Promise<void>)
    | null = null;
  let afterContinuationDispatchCheck:
    | ((input: { runId: string; issueId: string }) => Promise<void>)
    | null = null;

  const countExecuteCallsForRun = (runId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => context?.runId === runId).length;

  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-stale-queue-");
    db = createDb(external ?? tempDb!.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      beforeResolvedInteractionContinuationDispatchCheck: async (input) => {
        await beforeContinuationDispatchCheck?.(input);
      },
      afterResolvedInteractionContinuationDispatchCheck: async (input) => {
        await afterContinuationDispatchCheck?.(input);
      },
    });
    await ensureIssueRelationsTable(db);
    fixtureResetStatement = await buildHeartbeatInvalidationResetStatement(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    beforeContinuationDispatchCheck = null;
    afterContinuationDispatchCheck = null;
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Stale-queue invalidation test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    // A table poll for "queued" or "running" rows cannot see a wakeup promise
    // that has not yet written its run row. The shared drain helper awaits
    // both in-flight wakeup promises and in-flight run executions first, then
    // re-checks the run table, so a late writer cannot still be in flight when
    // the fixture reset below runs.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupHeartbeatInvalidationFixture(db, fixtureResetStatement);
    await db.delete(authUsers).where(eq(authUsers.id, "responsible-user"));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: SeedOptions = {}): Promise<SeedResult> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    // Admission intersects agent authority with an existing responsible user
    // and that user's active company membership.
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Fixture user",
      email: "responsible-user@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: opts.agentName ?? "ClaudeCoder",
      role: opts.agentRole ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: opts.maxConcurrentRuns ?? 1,
          ...(opts.heartbeatConfig ?? {}),
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it.each([
    { change: "assignment", paused: false }, { change: "assignment", paused: true },
    { change: "interaction", paused: false }, { change: "interaction", paused: true },
  ])("promotes a deferred stage after stale $change cancellation, paused=$paused", async ({ change, paused }) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [recipient] = await db.insert(agents).values({ companyId, name: "Independent review recipient", role: "engineer",
      status: paused ? "paused" : "idle", adapterType: "codex_local", adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    }).returning();
    const stageId = randomUUID();
    const participant = { type: "agent" as const, agentId: recipient.id, userId: null };
    const returnAssignee = { type: "agent" as const, agentId, userId: null };
    const stage = { stageId, stageType: "review", wakeRole: "reviewer", currentParticipant: participant,
      returnAssignee, allowedActions: ["approve", "request_changes"], lastDecisionOutcome: null, reviewRequest: null };
    const [issue] = await db.insert(issues).values({ companyId, title: "Review arrived before old assignment settled",
      status: "in_review", assigneeAgentId: recipient.id,
      executionPolicy: { mode: "normal", stages: [{ id: stageId, type: "review",
        participants: [{ id: randomUUID(), ...participant }], approvalsNeeded: 1 }], commentRequired: true },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: participant, returnAssignee, completedStageIds: [], changesRequestedCount: 0,
        lastDecisionId: null, lastDecisionOutcome: null, monitor: null, reviewRequest: null },
    }).returning();
    const obsoleteInteractionId = randomUUID();
    if (change === "interaction") {
      await db.insert(issueThreadInteractions).values({ id: obsoleteInteractionId, companyId, issueId: issue.id,
        kind: "request_confirmation", status: "expired", addresseeAgentId: agentId,
        effectiveResolverPolicy: "not_creator", payload: { version: 1, prompt: "Review obsolete source" },
      });
    }
    const stale = await seedQueuedRun({ companyId, agentId, issueId: issue.id,
      wakeReason: change === "interaction" ? "interaction_pending" : "issue_assigned",
      ...(change === "interaction" ? { contextExtras: { source: "issue.interaction.created",
        interactionId: obsoleteInteractionId, interactionKind: "request_confirmation" } } : {}),
    });
    await db.update(issues).set({ executionRunId: stale.runId }).where(eq(issues.id, issue.id));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: recipient.id,
      source: "assignment", triggerDetail: "system", reason: "issue_execution_deferred",
      status: "deferred_issue_execution", requestedByActorType: "system",
      payload: { issueId: issue.id, mutation: "update", executionStage: stage, _paperclipWakeContext: {
        issueId: issue.id, wakeReason: "execution_review_requested", wakeSource: "assignment", executionStage: stage,
      } },
    }).returning();

    // The fake provider records a real policy-service decision, rather than
    // returning without closing its stage and inviting participant recovery.
    mockAdapterExecute.mockImplementation(async ctx => {
      const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
      const transition = applyIssueExecutionPolicyTransition({ issue: current,
        policy: normalizeIssueExecutionPolicy(current.executionPolicy), requestedStatus: "done",
        requestedAssigneePatch: {}, actor: { agentId: recipient.id }, commentBody: "Accept the frozen fixture candidate",
      });
      expect(transition.decision?.outcome).toBe("approved");
      await db.transaction(async tx => {
        await issueService(db).update(issue.id, { status: "done", ...transition.patch,
          actorAgentId: recipient.id, actorRunId: ctx.runId, companyGuard: companyId }, tx);
        await tx.insert(issueExecutionDecisions).values({ companyId, issueId: issue.id, stageId,
          stageType: "review", actorAgentId: recipient.id, outcome: "approved",
          body: "Accept the frozen fixture candidate", createdByRunId: ctx.runId });
      });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Frozen fixture candidate accepted", provider: "test", model: "test-model" };
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await heartbeat.getRun(stale.runId)).toMatchObject({ status: "cancelled",
      errorCode: change === "interaction" ? "issue_interaction_changed" : "issue_assignee_changed", startedAt: null });
    expect(countExecuteCallsForRun(stale.runId)).toBe(0);
    const readWake = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)).then(rows => rows[0]);
    if (paused) {
      expect(await readWake()).toMatchObject({ status: "deferred_issue_execution", runId: null,
        finishedAt: null, payload: wake.payload });
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(async () => {
        const admitted = await readWake();
        expect(admitted.runId).toBeTruthy();
        expect(countExecuteCallsForRun(admitted.runId!)).toBe(1);
      }, { timeout: 15_000 });
      const admitted = await readWake();
      await heartbeat.waitForRunExecutionDrain(admitted.runId!, { timeoutMs: 30_000 });
      expect((await heartbeat.getRun(admitted.runId!))?.contextSnapshot).toMatchObject({ issueId: issue.id, executionStage: { stageId } });
    }
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute.mock.calls.length).toBe(paused ? 0 : 1);
    if (paused) {
      // A new service reconstructs the original receipt after pause is lifted;
      // no replacement intent, comment, counter reset, or provider retry.
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, recipient.id));
      const restarted = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
      await restarted.resumeQueuedRuns();
      await vi.waitFor(async () => expect((await readWake()).runId).toBeTruthy(), { timeout: 15_000 });
      await restarted.waitForRunExecutionDrain((await readWake()).runId!, { timeoutMs: 30_000 });
      await restarted.resumeQueuedRuns();
      await restarted.drainActiveRunExecutions();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    }
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({
      status: "done",
      executionState: { status: "completed", completedStageIds: [stageId], changesRequestedCount: 0 },
    });
  }, 60_000);

  it.each(["ready", "paused", "expired", "human", "reconciliation"] as const)(
    "reconstructs only the saved addressed review receipt after restart: %s", async condition => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const [reviewer] = await db.insert(agents).values({ companyId, name: "Addressed reviewer", role: "engineer",
        status: condition === "paused" ? "paused" : "idle", adapterType: "codex_local", adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true } }, permissions: {} }).returning();
      const [issue] = await db.insert(issues).values({ companyId, title: "Frozen source awaiting attention",
        status: "in_progress", assigneeAgentId: agentId }).returning();
      const source = await seedQueuedRun({ companyId, agentId, issueId: issue.id, wakeReason: "issue_assigned" });
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "cancelled", finishedAt: new Date(),
        errorCode: condition === "reconciliation" ? "execution_reconciliation_required" : "issue_interaction_changed",
      }).where(eq(heartbeatRuns.id, source.runId));
      await db.update(agentWakeupRequests).set({ status: "skipped", finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, source.wakeupRequestId));
      const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
        kind: "request_confirmation", status: condition === "expired" ? "expired" : "pending",
        createdByAgentId: agentId, addresseeAgentId: reviewer.id,
        ...(condition === "human" ? { addresseeUserId: "responsible-user", effectiveResolverPolicy: "human_only" } : { effectiveResolverPolicy: "not_creator" }),
        payload: { version: 1, prompt: "Review exact saved source" } }).returning();
      if (condition === "reconciliation") await db.insert(issueRecoveryActions).values({ companyId,
        sourceIssueId: issue.id, kind: "active_run_watchdog", ownerType: "board", cause: "uncertain_external_action",
        status: "resolved", evidence: { runId: source.runId, automaticRecovery: { replay: "blocked" } },
        fingerprint: source.runId, nextAction: "Reconcile the uncertain action" });
      const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId: reviewer.id,
        source: "assignment", triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
        requestedByActorType: "system", payload: { issueId: issue.id, _paperclipWakeContext: {
          issueId: issue.id, source: "issue.interaction.created", wakeReason: "interaction_pending",
          interactionId: card.id, interactionKind: "request_confirmation" } } }).returning();
      const readReceipt = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)).then(rows => rows[0]);
      const restarted = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
      await restarted.resumeQueuedRuns();
      await restarted.drainActiveRunExecutions();
      if (condition !== "ready") {
        expect(await readReceipt()).toMatchObject({ runId: null, status: "deferred_issue_execution", payload: receipt.payload });
        expect(mockAdapterExecute).not.toHaveBeenCalled();
      }
      if (condition === "paused") {
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, reviewer.id));
        await restarted.resumeQueuedRuns();
      }
      if (condition === "ready" || condition === "paused") {
        await vi.waitFor(async () => expect((await readReceipt()).runId).toBeTruthy(), { timeout: 15_000 });
        const delivered = await readReceipt();
        await restarted.waitForRunExecutionDrain(delivered.runId!, { timeoutMs: 30_000 });
        const actual = await restarted.getRun(delivered.runId!);
        const [currentCard] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
        expect(actual, JSON.stringify({ status: actual?.status, error: actual?.errorCode, context: actual?.contextSnapshot,
          card: { status: currentCard.status, resolver: currentCard.effectiveResolverPolicy } })).toMatchObject({ status: "succeeded" });
        expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
        expect(actual?.contextSnapshot)
          .toMatchObject({ issueId: issue.id, interactionId: card.id, interactionKind: "request_confirmation", wakeReason: "interaction_pending" });
        await restarted.resumeQueuedRuns();
        await restarted.drainActiveRunExecutions();
        expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
        expect((await readReceipt()).id).toBe(receipt.id);
        expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].assigneeAgentId).toBe(agentId);
      }
    }, 60_000,
  );

  it.each(["issue_waiting_for_response", "execution_reconciliation_required"] as const)(
    "does not renew a deferred queue after deliberate %s cancellation", async errorCode => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const [issue] = await db.insert(issues).values({ companyId, title: "Held continuation with saved input",
        status: "in_progress", assigneeAgentId: agentId }).returning();
      const queued = await seedQueuedRun({ companyId, agentId, issueId: issue.id, wakeReason: "issue_assigned" });
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", responsibleUserId: "responsible-user",
        resultJson: { conversationContinuation: "continue_conversation_v1" },
      }).where(eq(heartbeatRuns.id, queued.runId));
      await db.update(issues).set({ executionRunId: queued.runId }).where(eq(issues.id, issue.id));
      if (errorCode === "issue_waiting_for_response") {
        await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "request_confirmation",
          status: "pending", addresseeUserId: "responsible-user", effectiveResolverPolicy: "human_only",
          payload: { version: 1, prompt: "Confirm the held change" },
        });
      } else {
        await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id, kind: "active_run_watchdog",
          ownerType: "board", cause: "uncertain_external_action", status: "resolved",
          evidence: { runId: queued.runId, automaticRecovery: { replay: "blocked" } }, fingerprint: queued.runId,
          nextAction: "Reconcile the uncertain action before continuing",
        });
      }
      const [saved] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
        triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
        requestedByActorType: "system", payload: { issueId: issue.id, _paperclipWakeContext: {
          issueId: issue.id, wakeReason: "issue_assigned", wakeSource: "automation",
        } },
      }).returning();
      const beforeRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
      const beforeWakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests);
      const notify = vi.spyOn(deferredNotifications, "notifyDeferredWakesForIssue");
      try {
        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();
        expect(await heartbeat.getRun(queued.runId)).toMatchObject({ status: "cancelled", errorCode, startedAt: null });
        expect(mockAdapterExecute).not.toHaveBeenCalled();
        expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved.id)))[0])
          .toMatchObject({ status: "deferred_issue_execution", runId: null, payload: saved.payload });
        expect((await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).map(row => row.id).sort())
          .toEqual(beforeRuns.map(row => row.id).sort());
        expect((await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).map(row => row.id).sort())
          .toEqual(beforeWakes.map(row => row.id).sort());
        expect(notify.mock.calls.filter(([, scope]) => scope.issueId === issue.id)).toHaveLength(0);
      } finally { notify.mockRestore(); }
    }, 60_000,
  );

  it.each(["legacy", "native"])("delivers an accepted non-assignee queue after its %s owner finished", async runtimeMode => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [recipient] = await db.insert(agents).values({ companyId, name: "Saved feedback recipient", role: "engineer",
      status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } }, permissions: {},
    }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Existing accepted feedback", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [owner] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment", status: "succeeded",
      runtimeMode, nativeIssueId: runtimeMode === "native" ? issue.id : null, startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: issue.id },
    }).returning();
    if (runtimeMode === "native") await db.insert(nativeRunFinalizations).values({ runId: owner.id, companyId, issueId: issue.id, phase: "committed" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: issue.id, body: "Saved feedback for the recipient",
      authorAgentId: agentId, createdByRunId: owner.id,
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: recipient.id, source: "automation",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "agent", requestedByActorId: agentId,
      payload: withQueuedCommentIdsInWakePayload({ issueId: issue.id, _paperclipWakeContext: {
        issueId: issue.id, wakeReason: "issue_comment_mentioned", wakeSource: "automation",
      } }, [comment.id]),
    }).returning();
    await heartbeat.resumeQueuedRuns();
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(delivered.runId).toBeTruthy();
    // The receipt can commit before execution enters liveRunExecutions.
    // Observe actual adapter admission before awaiting its drain.
    await vi.waitFor(async () => {
      const current = await heartbeat.getRun(delivered.runId!);
      expect(countExecuteCallsForRun(delivered.runId!), JSON.stringify({
        status: current?.status, errorCode: current?.errorCode,
      })).toBe(1);
    }, { timeout: 30_000 });
    await heartbeat.waitForRunExecutionDrain(delivered.runId!);
    expect(countExecuteCallsForRun(delivered.runId!)).toBe(1);
    expect((await heartbeat.getRun(delivered.runId!))?.contextSnapshot).toMatchObject({ wakeCommentIds: [comment.id] });
    await heartbeat.resumeQueuedRuns();
    expect(countExecuteCallsForRun(delivered.runId!)).toBe(1);
    expect((await db.select().from(issueComments).where(eq(issueComments.id, comment.id)))[0]?.body).toBe(comment.body);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]?.assigneeAgentId).toBe(agentId);
  }, 60_000);

  it.each(["preparing", "verifying", "resuming"] as const)("keeps assigned work queued through %s, including recovery with timers disabled", async lifecycleState => {
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatConfig: { enabled: false } });
    await db.update(agents).set({ status: "paused", lifecycleState }).where(eq(agents.id, agentId));
    const [issue] = await db.insert(issues).values({ companyId, title: "Work accepted during setup", status: "todo", assigneeAgentId: agentId }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      requestedByActorType: "system", payload: { issueId: issue.id } });
    expect(run?.status).toBe("queued");
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(run!.id))?.status).toBe("queued");
    expect(countExecuteCallsForRun(run!.id)).toBe(0);
    expect((await heartbeat.reconcileStrandedAssignedIssues()).escalated).toBe(0);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ status: "todo", assigneeAgentId: agentId });
    await db.update(agents).set({ status: "idle", lifecycleState: "ready" }).where(eq(agents.id, agentId));
    const recovered = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await recovered.resumeQueuedRuns();
    await recovered.drainActiveRunExecutions();
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    wakeReason: string;
    contextExtras?: Record<string, unknown>;
    invocationSource?: "assignment" | "automation";
    scheduledRetryReason?: string | null;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      reason: input.wakeReason,
      payload: { issueId: input.issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: input.invocationSource ?? "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      contextSnapshot: {
        issueId: input.issueId,
        wakeReason: input.wakeReason,
        ...(input.contextExtras ?? {}),
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it("joins a claimed execution whose initial run read has not reached live registration", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [issue] = await db.insert(issues).values({ companyId, title: "Held preparation", status: "todo", assigneeAgentId: agentId }).returning();
    const queued = await seedQueuedRun({ companyId, agentId, issueId: issue.id, wakeReason: "issue_assigned" });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const factory = runState.createHeartbeatRunState;
    let held = false;
    const spy = vi.spyOn(runState, "createHeartbeatRunState").mockImplementation((...args) => {
      const owner = factory(...args);
      const read = owner.getRun;
      return { ...owner, getRun: async (...readArgs: Parameters<typeof read>) => {
        const row = await read(...readArgs);
        if (!held && row?.id === queued.runId && row.status === "running") {
          held = true; entered.resolve(); await release.promise;
        }
        return row;
      } };
    });
    const recovered = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    try {
      await recovered.resumeQueuedRuns();
      await entered.promise;
      // Receipt admission is earlier than live-run registration. The legacy
      // run-specific drain can return here; the tracked execution must not.
      await recovered.waitForRunExecutionDrain(queued.runId);
      expect(countExecuteCallsForRun(queued.runId)).toBe(0);
      let settled = false;
      const draining = recovered.drainActiveRunExecutions().then(() => { settled = true; });
      await immediate();
      expect(settled).toBe(false);
      release.resolve();
      await draining;
      expect(countExecuteCallsForRun(queued.runId)).toBe(1);
      expect(await recovered.getRun(queued.runId)).toMatchObject({ status: "succeeded", runtimeMode: "legacy" });
    } finally {
      release.resolve();
      await recovered.drainActiveRunExecutions();
      spy.mockRestore();
    }
  });

  it.each([
    { name: "assignments", sameIssue: true, first: "assignment", second: "assignment" },
    { name: "unrelated tasks", sameIssue: false, first: "assignment", second: "assignment" },
    { name: "assignment then direct comment", sameIssue: true, first: "assignment", second: "direct" },
    { name: "direct comment then assignment", sameIssue: true, first: "direct", second: "assignment" },
    { name: "assignment then queued comment", sameIssue: true, first: "assignment", second: "queued" },
    { name: "queued comment then assignment", sameIssue: true, first: "queued", second: "assignment" },
    { name: "queued comments", sameIssue: true, first: "queued", second: "queued" },
  ])("serializes issue claims without serializing unrelated work: $name", async ({ sameIssue, first, second }) => {
    const { companyId, agentId } = await seedCompanyAndAgent({ maxConcurrentRuns: 2 });
    const firstIssueId = randomUUID();
    const secondIssueId = sameIssue ? firstIssueId : randomUUID();
    for (const id of new Set([firstIssueId, secondIssueId])) {
      await db.insert(issues).values({ id, companyId, title: "Concurrent assignment", status: "todo", assigneeAgentId: agentId });
    }
    async function queue(issueId: string, kind: string) {
      const commentId = kind === "assignment" ? null : randomUUID();
      if (commentId) await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: "local-board", body: "Continue this task." });
      const queued = await seedQueuedRun({ companyId, agentId, issueId,
        wakeReason: commentId ? "issue_commented" : "issue_assigned",
        invocationSource: commentId ? "automation" : "assignment",
        contextExtras: commentId ? { wakeCommentIds: [commentId], wakeCommentId: commentId } : {},
      });
      if (kind === "queued") await db.update(agentWakeupRequests).set({
        payload: withQueuedCommentIdsInWakePayload({ issueId }, [commentId!]),
      }).where(eq(agentWakeupRequests.id, queued.wakeupRequestId));
    }
    await queue(firstIssueId, first);
    await queue(secondIssueId, second);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = Promise.withResolvers<void>();
    const expectedExecutions = sameIssue ? 1 : 2;
    let executions = 0;
    mockAdapterExecute.mockImplementation(async () => {
      if (++executions === expectedExecutions) entered.resolve();
      await gate;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Assignment finished.", provider: "test", model: "test-model" };
    });
    try {
      await heartbeat.resumeQueuedRuns();
      await entered.promise;
      expect(mockAdapterExecute).toHaveBeenCalledTimes(expectedExecutions);
      const runs = await db.select().from(heartbeatRuns);
      const running = runs.filter((run) => run.status === "running");
      expect(running).toHaveLength(sameIssue ? 1 : 2);
      expect(runs.filter((run) => run.status === "queued")).toHaveLength(sameIssue ? 1 : 0);
      for (const run of running) {
        const [issue] = await db.select().from(issues).where(eq(issues.id, (run.contextSnapshot as { issueId: string }).issueId));
        expect(issue.executionRunId).toBe(run.id);
      }
    } finally {
      release();
      await heartbeat.drainActiveRunExecutions();
    }
  });

  it.each(["active_lease", "pending_cleanup", "failed_cleanup", "finalizer_lease", "workspace_finalization",
    "retained_ready", "retained_missing_receipt", "retained_failed", "retained_wrong_policy"])(
    "waits for durable cleanup from another controller: %s", async (pending) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID(), previousId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "Remote cleanup", status: "todo", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: previousId, companyId, agentId,
        status: "succeeded", runtimeMode: "native", nativeIssueId: issueId,
        invocationSource: "assignment", contextSnapshot: { issueId }, finishedAt: new Date() });
      await db.update(issues).set({ executionRunId: previousId }).where(eq(issues.id, issueId));
      const leaseId = randomUUID();
      const retained = pending.startsWith("retained_");
      const hasLease = retained || ["active_lease", "pending_cleanup", "failed_cleanup"].includes(pending);
      if (hasLease) await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId,
        heartbeatRunId: previousId, provider: "daytona",
        status: retained ? "retained" : pending === "pending_cleanup" ? "pending_cleanup" : "released",
        leasePolicy: pending === "retained_wrong_policy" ? "retain_on_failure" : retained ? "reuse_by_environment" : "ephemeral",
        releasedAt: retained || pending === "active_lease" ? null : new Date(),
        cleanupStatus: ["retained_ready", "retained_wrong_policy"].includes(pending) ? "success"
          : ["failed_cleanup", "retained_failed"].includes(pending) ? "failed" : null });
      await db.insert(nativeRunFinalizations).values({ runId: previousId, companyId, issueId,
        phase: pending === "workspace_finalization" ? "workspace_finalizing" : "committed",
        leaseOwner: pending === "finalizer_lease" ? "another-controller" : null });
      const next = await seedQueuedRun({ companyId, agentId, issueId, wakeReason: "issue_assigned", invocationSource: "assignment" });
      mockAdapterExecute.mockImplementation(async () => {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
          summary: "Task completed", provider: "test", model: "test-model" };
      });
      // No in-memory executor exists in this service. Durable ownership alone
      // must fence a second controller until cleanup settles. A verified warm
      // retention receipt is already a settled boundary and allows continuation.
      await heartbeat.resumeQueuedRuns();
      if (pending !== "retained_ready") {
        expect((await heartbeat.getRun(next.runId))?.status).toBe("queued");
        expect(mockAdapterExecute).not.toHaveBeenCalled();
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(previousId);
        if (hasLease) await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(environmentLeases.id, leaseId));
        await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null }).where(eq(nativeRunFinalizations.runId, previousId));
        await heartbeat.resumeQueuedRuns();
      }
      await heartbeat.drainActiveRunExecutions();
      expect((await heartbeat.getRun(next.runId))?.status).toBe("succeeded");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    },
  );

  it("skips generic timer wakes with no actionable assigned work before adapter execution", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const runRows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.timer.no_actionable_work",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        reason: expect.stringContaining("No assigned todo or in_progress issue"),
      },
    });
    expect(runRows).toHaveLength(0);
  });

  it("checks guarded issue status and assignee under the enqueue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const parkedIssueId = randomUUID();
    const reassignedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: parkedIssueId,
        companyId,
        title: "Parked connection intent",
        status: "backlog" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
      },
      {
        id: reassignedIssueId,
        companyId,
        title: "Reassigned connection intent",
        status: "in_progress" as const,
        priority: "medium" as const,
        assigneeAgentId: null,
      },
    ]);

    for (const issueId of [parkedIssueId, reassignedIssueId]) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, interactionId: randomUUID() },
        contextSnapshot: { issueId, wakeReason: "issue_commented" },
        requestedByActorType: "user",
        requestedByActorId: "responsible-user",
        issueStateGuard: {
          statuses: ["in_progress"],
          assigneeAgentId: agentId,
        },
      });
      expect(run).toBeNull();
    }

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)).toEqual([
      { status: "skipped", reason: "issue_state_guard_mismatch" },
      { status: "skipped", reason: "issue_state_guard_mismatch" },
    ]);
  });

  it.each([
    { runtimeMode: "native", status: "done", reassigned: false },
    { runtimeMode: "legacy", status: "done", reassigned: false },
    { runtimeMode: "native", status: "cancelled", reassigned: false },
    { runtimeMode: "native", status: "backlog", reassigned: false },
    { runtimeMode: "native", status: "in_review", reassigned: false },
    { runtimeMode: "native", status: "blocked", reassigned: false },
    { runtimeMode: "native", status: "in_progress", reassigned: true },
  ] as const)("skips stale $runtimeMode productive recovery after status=$status reassigned=$reassigned commits under the enqueue lock", async ({ runtimeMode, status, reassigned }) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completion racing with productive recovery",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      runtimeMode,
      status: "succeeded",
      livenessState: "completed",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    // Let the real sweep select its in-progress snapshot, then hold the issue
    // lock until the real enqueue transaction is waiting on the newer state.
    const enqueueWakeup = vi.fn(async (...[targetAgentId, options]: Parameters<typeof heartbeat.wakeup>) => {
      let pendingWake!: ReturnType<typeof heartbeat.wakeup>;
      await db.transaction(async (tx) => {
        await tx.update(issues).set({
          status,
          ...(reassigned ? { assigneeAgentId: null, assigneeUserId: "responsible-user" } : {}),
        }).where(eq(issues.id, issueId));
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pendingWake = heartbeat.wakeup(targetAgentId, options);
        try {
          expect(await waitForCondition(async () => {
            const [{ waiting }] = await db.execute<{ waiting: boolean }>(sql`
              select exists (
                select 1 from pg_stat_activity
                where ${pid} = any(pg_blocking_pids(pid))
              ) as waiting
            `);
            return waiting;
          })).toBe(true);
        } catch (error) {
          // Observe a pending rejection even if the lock assertion fails.
          void pendingWake.catch(() => {});
          throw error;
        }
      });
      return pendingWake;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ continuationRequeued: 0, escalated: 0, skipped: 1, issueIds: [] });
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toEqual([{ id: runId }]);
    expect(await db.select().from(issueComments)).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [wakeup] = await db.select().from(agentWakeupRequests);
    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "issue_state_guard_mismatch",
      runId: null,
      payload: {
        heartbeatSkip: {
          expectedStatuses: ["in_progress"],
          actualStatus: status,
          expectedAssigneeAgentId: agentId,
          actualAssigneeAgentId: reassigned ? null : agentId,
        },
      },
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status, assigneeAgentId: reassigned ? null : agentId });
  });

  // Cold Linux preparation and settlement exceed the short default budgets.
  // Bound each at 30 seconds inside a 75-second test budget.
  it.each(["in_review", "blocked"])("delivers an addressed CTO question once without taking worker ownership or losing context (%s)", async status => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "CTO", heartbeatConfig: { enabled: false } });
    const workerId = randomUUID();
    await db.insert(agents).values({ id: workerId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Worker needs a bounded planning answer", status, assigneeAgentId: workerId }).returning();
    if (status === "blocked") {
      const [blocker] = await db.insert(issues).values({ companyId, title: "Unfinished QA", status: "blocked" }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
    }
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "ask_user_questions", createdByAgentId: workerId, addresseeAgentId: agentId,
      effectiveResolverPolicy: "anyone", payload: { version: 1, questions: [] } }).returning();
    const context = { source: "issue.interaction.created", interactionId: interaction.id,
      interactionKind: interaction.kind, planningContext: "Keep the original bounded implementation and review constraints" };
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId: issue.id,
      wakeReason: "interaction_pending", invocationSource: "automation", contextExtras: context });

    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => countExecuteCallsForRun(runId) === 1, 30_000)).toBe(true);
    await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: 30_000 });
    await heartbeat.resumeQueuedRuns();
    const run = await heartbeat.getRun(runId);
    expect(run).toMatchObject({ status: "succeeded", contextSnapshot: { ...context, issueId: issue.id, wakeReason: "interaction_pending" } });
    expect(countExecuteCallsForRun(runId)).toBe(1);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ status, assigneeAgentId: workerId });
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe("pending");
    if (status === "blocked") expect((await issueService(db).listDependencyReadiness(companyId, [issue.id])).get(issue.id)?.isDependencyReady).toBe(false);
  }, 75_000);

  it.each(["pending", "answered", "wrong_recipient", "human_only", "self_addressed", "owner_not_creator", "creator_not_owner"] as const)("admits only a current authorized addressed card on a dependency-blocked task (%s)", async kind => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [worker] = await db.insert(agents).values({ companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
    const ownerId = kind === "self_addressed" || kind === "owner_not_creator" ? agentId : worker.id;
    const creatorId = kind === "self_addressed" || kind === "creator_not_owner" ? agentId : worker.id;
    const [issue] = await db.insert(issues).values({ companyId, title: "Blocked worker needs lead disposition", status: "blocked", assigneeAgentId: ownerId }).returning();
    const [blocker] = await db.insert(issues).values({ companyId, title: "QA cannot proceed", status: "blocked" }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "ask_user_questions", createdByAgentId: creatorId,
      addresseeAgentId: kind === "wrong_recipient" ? worker.id : agentId,
      status: kind === "answered" ? "answered" : "pending",
      effectiveResolverPolicy: kind === "human_only" ? "human_only" : "anyone",
      payload: { version: 1, questions: [] } }).returning();
    await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "interaction_pending",
      requestedByActorType: "agent", requestedByActorId: creatorId,
      payload: { issueId: issue.id, interactionId: interaction.id, interactionKind: interaction.kind, mutation: "interaction" },
      idempotencyKey: `interaction-pending:${interaction.id}`,
      contextSnapshot: { issueId: issue.id, source: "issue.interaction.created",
        interactionId: interaction.id, interactionKind: interaction.kind, wakeReason: "interaction_pending",
        ...(kind !== "pending" ? { dependencyBlockedInteraction: true } : {}) } });
    await heartbeat.resumeQueuedRuns();
    if (kind === "pending") {
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id)),
        JSON.stringify(await db.select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason }).from(agentWakeupRequests)))
        .toHaveLength(1);
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000)).toBe(true);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id));
      await heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 30_000 });
      expect(await heartbeat.getRun(run.id)).toMatchObject({ status: "succeeded", contextSnapshot: { dependencyBlockedInteraction: true } });
    }
    if (kind !== "pending") expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id))).toEqual([]);
    await heartbeat.resumeQueuedRuns();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(kind === "pending" ? 1 : 0);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: ownerId });
    expect((await issueService(db).listDependencyReadiness(companyId, [issue.id])).get(issue.id)?.isDependencyReady).toBe(false);
  }, 75_000);

  it.each(["answered", "recipient_became_owner"] as const)("refuses a blocked addressed card changed while waiting for recipient capacity (%s)", async change => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [worker] = await db.insert(agents).values({ companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Blocked worker question", status: "blocked", assigneeAgentId: worker.id }).returning();
    const [blocker] = await db.insert(issues).values({ companyId, title: "Unfinished QA", status: "blocked" }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: blocker.id, relatedIssueId: issue.id, type: "blocks" });
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "ask_user_questions", createdByAgentId: worker.id, addresseeAgentId: agentId,
      effectiveResolverPolicy: "anyone", payload: { version: 1, questions: [] } }).returning();
    const [occupied] = await db.insert(issues).values({ companyId, title: "Recipient is occupied", status: "in_progress", assigneeAgentId: agentId }).returning();
    const { runId: occupyingRunId } = await seedQueuedRun({ companyId, agentId, issueId: occupied.id, wakeReason: "issue_assigned" });
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, occupyingRunId));
    await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "interaction_pending",
      requestedByActorType: "agent", requestedByActorId: worker.id,
      payload: { issueId: issue.id, interactionId: interaction.id, interactionKind: interaction.kind, mutation: "interaction" },
      idempotencyKey: `interaction-pending:${interaction.id}`,
      contextSnapshot: { issueId: issue.id, source: "issue.interaction.created",
        interactionId: interaction.id, interactionKind: interaction.kind, wakeReason: "interaction_pending" } });
    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id));
    expect(queued).toMatchObject({ status: "queued", contextSnapshot: { dependencyBlockedInteraction: true } });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    if (change === "answered") {
      await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, interaction.id));
    } else {
      await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issue.id));
    }
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, occupyingRunId));
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await heartbeat.getRun(queued.id))?.status === "cancelled")).toBe(true);
    expect(await heartbeat.getRun(queued.id)).toMatchObject({ status: "cancelled", errorCode: "issue_dependencies_blocked" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: change === "answered" ? worker.id : agentId });
    expect((await issueService(db).listDependencyReadiness(companyId, [issue.id])).get(issue.id)?.isDependencyReady).toBe(false);
  });

  it.each(["direct", "transitive", "unrelated", "reassigned", "failed_source", "completed_branch", "answered", "self", "cycle", "cross_company"] as const)("checks a blocked parent disposition against its live source (%s)", async kind => {
    const { companyId, agentId } = await seedCompanyAndAgent({ agentName: "Parent owner" });
    const [worker] = await db.insert(agents).values({ companyId, name: "QA worker", role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
    const [parent] = await db.insert(issues).values({ companyId, title: "Parent disposition", status: "blocked", assigneeAgentId: agentId }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Validation source", status: "in_progress", assigneeAgentId: worker.id }).returning();
    const [lead] = await db.insert(issues).values({ companyId, title: "Delivery", status: kind === "completed_branch" ? "done" : "blocked" }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: lead.id, relatedIssueId: parent.id, type: "blocks" });
    if (kind !== "unrelated") await db.insert(issueRelations).values({ companyId, issueId: child.id,
      relatedIssueId: kind === "direct" ? parent.id : lead.id, type: "blocks" });
    if (kind === "completed_branch") {
      const [other] = await db.insert(issues).values({ companyId, title: "Other blocker", status: "blocked" }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: other.id, relatedIssueId: parent.id, type: "blocks" });
    }
    if (kind === "cycle") await db.insert(issueRelations).values({ companyId, issueId: lead.id, relatedIssueId: child.id, type: "blocks" });
    const { runId: sourceRunId } = await seedQueuedRun({ companyId, agentId: worker.id, issueId: child.id, wakeReason: "issue_assigned" });
    if (kind === "cross_company") {
      const other = await seedCompanyAndAgent();
      await db.update(heartbeatRuns).set({ companyId: other.companyId }).where(eq(heartbeatRuns.id, sourceRunId));
    }
    await db.update(heartbeatRuns).set({ status: kind === "failed_source" ? "failed" : "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, sourceRunId));
    if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, child.id));
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: parent.id,
      kind: "request_confirmation", status: kind === "answered" ? "accepted" : "pending",
      createdByAgentId: kind === "self" ? agentId : worker.id, addresseeAgentId: agentId, sourceRunId,
      effectiveResolverPolicy: "not_creator", payload: { version: 1, prompt: "Review saved results only" } }).returning();
    const request = { source: "automation" as const, triggerDetail: "system" as const, reason: "interaction_pending",
      requestedByActorType: "agent" as const, requestedByActorId: worker.id,
      payload: { issueId: parent.id, interactionId: card.id, interactionKind: card.kind, mutation: "interaction" },
      idempotencyKey: `interaction-pending:${card.id}`,
      contextSnapshot: { issueId: parent.id, source: "issue.interaction.created", wakeReason: "interaction_pending",
        interactionId: card.id, interactionKind: card.kind, planningContext: "Preserve frozen candidate and plan" } };
    await Promise.all([heartbeat.wakeup(agentId, request), heartbeat.wakeup(agentId, request)]);
    await heartbeat.resumeQueuedRuns();
    const allowed = kind === "direct" || kind === "transitive" || kind === "cycle";
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, parent.id));
    expect(runs).toHaveLength(allowed ? 1 : 0);
    if (allowed) {
      const runId = runs[0]!.id;
      expect(await waitForCondition(async () => countExecuteCallsForRun(runId) === 1, 30_000)).toBe(true);
      await heartbeat.waitForRunExecutionDrain(runId, { timeoutMs: 30_000 });
      await heartbeat.wakeup(agentId, request);
      await heartbeat.resumeQueuedRuns();
      expect(countExecuteCallsForRun(runId)).toBe(1);
      expect(await heartbeat.getRun(runId)).toMatchObject({ status: "succeeded", contextSnapshot: {
        interactionId: card.id, dependencyBlockedInteraction: true, planningContext: "Preserve frozen candidate and plan" } });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, parent.id))).toHaveLength(1);
    } else expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, parent.id)))[0]).toMatchObject({ status: "blocked", assigneeAgentId: agentId });
    expect((await issueService(db).listDependencyReadiness(companyId, [parent.id])).get(parent.id)?.isDependencyReady).toBe(false);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id)))[0].status)
      .toBe(kind === "answered" ? "accepted" : "pending");
  }, 75_000);

  it.each(["ownership", "link"] as const)("rechecks a blocked parent disposition when source %s changes before dispatch", async change => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [worker] = await db.insert(agents).values({ companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
    const [parent] = await db.insert(issues).values({ companyId, title: "Parent", status: "blocked", assigneeAgentId: agentId }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Child", status: "blocked", assigneeAgentId: worker.id }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: child.id, relatedIssueId: parent.id, type: "blocks" });
    const [other] = await db.insert(issues).values({ companyId, title: "Independent unresolved blocker", status: "blocked" }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: other.id, relatedIssueId: parent.id, type: "blocks" });
    const { runId: sourceRunId } = await seedQueuedRun({ companyId, agentId: worker.id, issueId: child.id, wakeReason: "issue_assigned" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, sourceRunId));
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: parent.id,
      kind: "request_confirmation", createdByAgentId: worker.id, addresseeAgentId: agentId, sourceRunId,
      effectiveResolverPolicy: "not_creator", payload: { version: 1, prompt: "Review saved results" } }).returning();
    const [occupied] = await db.insert(issues).values({ companyId, title: "Recipient busy", status: "in_progress", assigneeAgentId: agentId }).returning();
    const { runId: occupyingRunId } = await seedQueuedRun({ companyId, agentId, issueId: occupied.id, wakeReason: "issue_assigned" });
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, occupyingRunId));
    const request = { source: "automation" as const, triggerDetail: "system" as const, reason: "interaction_pending",
      requestedByActorType: "agent" as const, requestedByActorId: worker.id,
      payload: { issueId: parent.id, interactionId: card.id, interactionKind: card.kind, mutation: "interaction" },
      idempotencyKey: `interaction-pending:${card.id}`,
      contextSnapshot: { issueId: parent.id, source: "issue.interaction.created", interactionId: card.id,
        interactionKind: card.kind, wakeReason: "interaction_pending" } };
    await heartbeat.wakeup(agentId, request);
    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, parent.id));
    expect(queued).toMatchObject({ status: "queued", contextSnapshot: { dependencyBlockedInteraction: true } });
    if (change === "ownership") await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, child.id));
    else await db.delete(issueRelations).where(eq(issueRelations.issueId, child.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, occupyingRunId));
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await heartbeat.getRun(queued!.id))?.status === "cancelled")).toBe(true);
    expect(await heartbeat.getRun(queued!.id)).toMatchObject({ status: "cancelled", errorCode: "issue_dependencies_blocked" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    if (change === "ownership") await db.update(issues).set({ assigneeAgentId: worker.id }).where(eq(issues.id, child.id));
    else await db.insert(issueRelations).values({ companyId, issueId: child.id, relatedIssueId: parent.id, type: "blocks" });
    await heartbeat.wakeup(agentId, request);
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000)).toBe(true);
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.wakeup(agentId, request);
    await heartbeat.resumeQueuedRuns();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  }, 75_000);

  it.each(["owner", "non_owner"] as const)("resumes a blocked parent disposition after pre-start cancellation, recipient pause and restart (%s)", async mode => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [worker] = await db.insert(agents).values({ companyId, name: "Blocking worker", role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
    const [parent] = await db.insert(issues).values({ companyId, title: "Saved disposition", status: "blocked", assigneeAgentId: mode === "owner" ? agentId : worker.id }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Source", status: "blocked", assigneeAgentId: worker.id }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: child.id, relatedIssueId: parent.id, type: "blocks" });
    const source = await seedQueuedRun({ companyId, agentId: worker.id, issueId: child.id, wakeReason: "issue_assigned" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, source.runId));
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: parent.id, kind: "request_confirmation",
      createdByAgentId: worker.id, addresseeAgentId: agentId, sourceRunId: source.runId, effectiveResolverPolicy: "not_creator",
      payload: { version: 1, prompt: "Disposition existing evidence" } }).returning();
    const context = { issueId: parent.id, source: "issue.interaction.created", wakeReason: "interaction_pending", interactionId: card.id, interactionKind: card.kind };
    const old = await seedQueuedRun({ companyId, agentId, issueId: parent.id, wakeReason: "interaction_pending", contextExtras: context });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "issue_interaction_changed" }).where(eq(heartbeatRuns.id, old.runId));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date(), idempotencyKey: `interaction-pending:${card.id}`,
      payload: { issueId: parent.id, mutation: "interaction", _paperclipWakeContext: context } }).where(eq(agentWakeupRequests.id, old.wakeupRequestId));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", triggerDetail: "system",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "system",
      idempotencyKey: `interaction-pending:${card.id}`, payload: { issueId: parent.id, mutation: "interaction", _paperclipWakeContext: context } }).returning();
    const restarted = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await restarted.resumeQueuedRuns();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    await restarted.resumeQueuedRuns();
    const delivered = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)).then(rows => rows[0]);
    const resumed = await waitForCondition(async () => Boolean((await delivered()).runId), 15_000);
    expect(resumed, JSON.stringify({ receipt: await delivered(), runs: await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, error: heartbeatRuns.errorCode }).from(heartbeatRuns).where(eq(heartbeatRuns.issueId, parent.id)) })).toBe(true);
    await restarted.waitForRunExecutionDrain((await delivered()).runId!, { timeoutMs: 30_000 });
    await restarted.resumeQueuedRuns();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(await restarted.getRun((await delivered()).runId!)).toMatchObject({ status: "succeeded", contextSnapshot: context });
  }, 75_000);

  it("deduplicates a blocked parent disposition while the parent execution is occupied", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [worker] = await db.insert(agents).values({ companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
    const [parent] = await db.insert(issues).values({ companyId, title: "Busy parent", status: "blocked", assigneeAgentId: agentId }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Current source", status: "blocked", assigneeAgentId: worker.id }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: child.id, relatedIssueId: parent.id, type: "blocks" });
    const source = await seedQueuedRun({ companyId, agentId: worker.id, issueId: child.id, wakeReason: "issue_assigned" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, source.runId));
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: parent.id, kind: "request_confirmation",
      createdByAgentId: worker.id, addresseeAgentId: agentId, sourceRunId: source.runId, effectiveResolverPolicy: "not_creator",
      payload: { version: 1, prompt: "Disposition current saved evidence" } }).returning();
    const occupied = await seedQueuedRun({ companyId, agentId: worker.id, issueId: parent.id, wakeReason: "issue_commented" });
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, occupied.runId));
    await db.update(issues).set({ executionRunId: occupied.runId }).where(eq(issues.id, parent.id));
    const request = { source: "automation" as const, triggerDetail: "system" as const, reason: "interaction_pending",
      requestedByActorType: "agent" as const, requestedByActorId: worker.id, idempotencyKey: `interaction-pending:${card.id}`,
      payload: { issueId: parent.id, interactionId: card.id, interactionKind: card.kind, mutation: "interaction" },
      contextSnapshot: { issueId: parent.id, source: "issue.interaction.created", wakeReason: "interaction_pending", interactionId: card.id, interactionKind: card.kind } };
    await Promise.all([heartbeat.wakeup(agentId, request), heartbeat.wakeup(agentId, request)]);
    const pending = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, request.idempotencyKey));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, occupied.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, parent.id));
    const restarted = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    await restarted.resumeQueuedRuns();
    expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000)).toBe(true);
    await restarted.drainActiveRunExecutions();
    await restarted.wakeup(agentId, request);
    await restarted.resumeQueuedRuns();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending[0]!.id));
    expect(receipt?.runId).toBeTruthy();
    expect(await restarted.getRun(receipt!.runId!)).toMatchObject({ status: "succeeded", contextSnapshot: request.contextSnapshot });
  }, 75_000);

  it.each(["accepted", "rejected", "unrelated", "source_reassigned", "wrong_resolver", "wrong_resolver_task", "failed_resolver", "governed", "expired", "no_continuation", "forged_source", "not_owner", "rejected_on_accept", "human_only", "ordinary_resolver"] as const)(
    "admits a blocking disposition follow-up only from its saved decision (%s)", async kind => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const [worker] = await db.insert(agents).values({ companyId, name: "Source worker", role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
      const [parent] = await db.insert(issues).values({ companyId, title: "Decision owner", status: "blocked", assigneeAgentId: agentId }).returning();
      const [lead] = await db.insert(issues).values({ companyId, title: "Lead", status: "blocked" }).returning();
      const [child] = await db.insert(issues).values({ companyId, title: "Unfinished worker", status: "in_progress", assigneeAgentId: worker.id }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: lead.id, relatedIssueId: parent.id, type: "blocks" });
      if (kind !== "unrelated") await db.insert(issueRelations).values({ companyId, issueId: child.id, relatedIssueId: lead.id, type: "blocks" });
      const source = await seedQueuedRun({ companyId, agentId: worker.id, issueId: child.id, wakeReason: "issue_assigned" });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, source.runId));
      const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: parent.id, kind: "request_confirmation",
        createdByAgentId: worker.id, addresseeAgentId: agentId, sourceRunId: source.runId, effectiveResolverPolicy: kind === "human_only" ? "human_only" : "not_creator",
        continuationPolicy: kind === "no_continuation" ? "none" : kind === "rejected_on_accept" ? "wake_assignee_on_accept" : "wake_assignee",
        payload: { version: 1, prompt: "Disposition and route the follow-up only", ...(kind === "governed" ? { toolAction: {} } : {}) } }).returning();
      const decision = await seedQueuedRun({ companyId, agentId, issueId: kind === "wrong_resolver_task" ? child.id : parent.id,
        wakeReason: "interaction_pending", contextExtras: { source: "issue.interaction.created", interactionId: card.id,
          interactionKind: card.kind, dependencyBlockedInteraction: kind !== "ordinary_resolver" } });
      await db.update(heartbeatRuns).set({ status: kind === "failed_resolver" ? "failed" : "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, decision.runId));
      for (const id of [source.wakeupRequestId, decision.wakeupRequestId]) await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, id));
      const status = kind === "rejected" || kind === "rejected_on_accept" ? "rejected" : "accepted";
      await db.update(issueThreadInteractions).set({ status: kind === "expired" ? "expired" : status, resolvedByAgentId: kind === "wrong_resolver" ? worker.id : agentId,
        resolvedByRunId: decision.runId, resolvedAt: new Date(), result: { version: 1, outcome: status } }).where(eq(issueThreadInteractions.id, card.id));
      if (kind === "source_reassigned") await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, child.id));
      if (kind === "not_owner") await db.update(issues).set({ assigneeAgentId: worker.id }).where(eq(issues.id, parent.id));
      const context = { issueId: parent.id, source: kind === "forged_source" ? "issue.comment.created" : `issue.interaction.${status === "accepted" ? "accept" : "reject"}`,
        wakeReason: "issue_commented", interactionId: card.id, interactionKind: card.kind, interactionStatus: status, sourceRunId: source.runId,
        planningContext: "Keep the accepted candidate and plan" };
      const request = { source: "automation" as const, triggerDetail: "system" as const, reason: "issue_commented",
        requestedByActorType: "agent" as const, requestedByActorId: agentId, idempotencyKey: `interaction:${card.id}:${status}`,
        payload: { issueId: parent.id, interactionId: card.id, interactionKind: card.kind, interactionStatus: status, mutation: "interaction" }, contextSnapshot: context };
      await Promise.all([heartbeat.wakeup(agentId, request), heartbeat.wakeup(agentId, request)]);
      await heartbeat.resumeQueuedRuns();
      const allowed = kind === "accepted" || kind === "rejected";
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, parent.id));
      expect(runs.filter(run => run.id !== decision.runId)).toHaveLength(allowed ? 1 : 0);
      if (allowed) {
        const run = runs.find(run => run.id !== decision.runId)!;
        expect(await waitForCondition(async () => countExecuteCallsForRun(run.id) === 1, 30_000)).toBe(true);
        await heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 30_000 });
        await heartbeat.wakeup(agentId, request);
        await heartbeat.resumeQueuedRuns();
        expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
        expect(await heartbeat.getRun(run.id)).toMatchObject({ status: "succeeded", contextSnapshot: { ...context, dependencyBlockedInteraction: true } });
      } else expect(mockAdapterExecute).not.toHaveBeenCalled();
      expect((await issueService(db).listDependencyReadiness(companyId, [parent.id])).get(parent.id)?.isDependencyReady).toBe(false);
    }, 75_000,
  );

  it.each(["succeeded", "failed", "forwarded", "passive_note", "other_run", "failed_handoff", "unstarted_handoff", "old_comment", "deleted_comment", "plan_confirmation"] as const)("settles one blocking disposition continuation after the deciding run (%s)", async settlement => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [worker] = await db.insert(agents).values({ companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" }).returning();
    const [parent] = await db.insert(issues).values({ companyId, title: "Parent", status: "blocked", assigneeAgentId: agentId }).returning();
    const [child] = await db.insert(issues).values({ companyId, title: "Source", status: "in_progress", assigneeAgentId: worker.id }).returning();
    await db.insert(issueRelations).values({ companyId, issueId: child.id, relatedIssueId: parent.id, type: "blocks" });
    const source = await seedQueuedRun({ companyId, agentId: worker.id, issueId: child.id, wakeReason: "issue_assigned" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, source.runId));
    const [card] = await db.insert(issueThreadInteractions).values({ companyId, issueId: parent.id, kind: "request_confirmation",
      createdByAgentId: worker.id, addresseeAgentId: agentId, sourceRunId: source.runId, effectiveResolverPolicy: "not_creator",
      continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Decide and route the saved source",
        ...(settlement === "plan_confirmation" ? { target: { type: "issue_document", key: "plan", revisionId: randomUUID() } } : {}),
      } }).returning();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    mockAdapterExecute.mockImplementation(async () => {
      if (++calls === 1) {
        await held;
        if (settlement === "failed") return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Synthetic deciding-run failure", errorCode: "synthetic_decision_failure", summary: "Decision persisted before failed settlement", provider: "test", model: "test" };
      }
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Decision or routing only", provider: "test", model: "test" };
    });
    try {
      const decision = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "interaction_pending",
        requestedByActorType: "agent", requestedByActorId: worker.id, idempotencyKey: `interaction-pending:${card.id}`,
        payload: { issueId: parent.id, interactionId: card.id, interactionKind: card.kind, mutation: "interaction" },
        contextSnapshot: { issueId: parent.id, source: "issue.interaction.created", wakeReason: "interaction_pending", interactionId: card.id, interactionKind: card.kind } });
      expect(decision).toBeTruthy();
      expect(await waitForCondition(async () => calls === 1, 30_000)).toBe(true);
      await db.update(issueThreadInteractions).set({ status: "accepted", resolvedByAgentId: agentId,
        resolvedByRunId: decision!.id, resolvedAt: new Date(), result: { version: 1, outcome: "accepted" } }).where(eq(issueThreadInteractions.id, card.id));
      const request = { source: "automation" as const, triggerDetail: "system" as const, reason: "issue_commented",
        requestedByActorType: "agent" as const, requestedByActorId: agentId, idempotencyKey: `interaction:${card.id}:accepted`,
        payload: { issueId: parent.id, interactionId: card.id, interactionKind: card.kind, interactionStatus: "accepted", mutation: "interaction" },
        contextSnapshot: { issueId: parent.id, source: "issue.interaction.accept", wakeReason: "issue_commented",
          interactionId: card.id, interactionKind: card.kind, interactionStatus: "accepted", sourceRunId: source.runId } };
      await Promise.all([heartbeat.wakeup(agentId, request), heartbeat.wakeup(agentId, request)]);
      const [saved] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, request.idempotencyKey));
      expect(saved).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, request.idempotencyKey))).toHaveLength(1);
      expect(calls).toBe(1);
      let handoff: { commentId: string; wakeId: string } | null = null;
      if (settlement !== "succeeded" && settlement !== "failed") {
        const [comment] = await db.insert(issueComments).values({
          companyId, issueId: child.id, authorType: "agent", authorAgentId: agentId,
          createdByRunId: settlement === "other_run" ? source.runId : decision!.id,
          body: "Continue from the saved decision",
          ...(settlement === "old_comment" ? { createdAt: new Date(0) } : {}),
          ...(settlement === "deleted_comment" ? { deletedAt: new Date() } : {}),
        }).returning();
        const [wake] = await db.insert(agentWakeupRequests).values({
          companyId, agentId: worker.id, reason: "issue_commented", source: "automation",
          requestedByActorType: "agent", requestedByActorId: agentId,
          status: settlement === "failed_handoff" ? "failed" :
            settlement === "unstarted_handoff" ? "queued" : "completed",
          payload: { issueId: child.id, commentId: comment.id, resumeIntent: settlement !== "passive_note",
            _paperclipWakeContext: { source: "issue.comment" } },
        }).returning();
        const [workerRun] = await db.insert(heartbeatRuns).values({
          companyId, agentId: worker.id, issueId: child.id, invocationSource: "automation",
          status: settlement === "unstarted_handoff" ? "queued" : "succeeded",
          startedAt: settlement === "unstarted_handoff" ? null : new Date(),
          wakeupRequestId: wake.id,
        }).returning();
        await db.update(agentWakeupRequests).set({ runId: workerRun.id }).where(eq(agentWakeupRequests.id, wake.id));
        if (settlement === "unstarted_handoff") {
          // This is a competing delivery, not part of the parent run's work.
          await db.update(agents).set({ status: "paused" }).where(eq(agents.id, worker.id));
        }
        handoff = { commentId: comment.id, wakeId: wake.id };
      }
      release();
      await heartbeat.waitForRunExecutionDrain(decision!.id, { timeoutMs: 30_000 });
      if (settlement === "failed" || settlement === "forwarded") {
        expect(await waitForCondition(async () => {
          const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved!.id));
          return receipt?.status === (settlement === "forwarded" ? "completed" : "skipped");
        }, 30_000)).toBe(true);
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved!.id));
        const run = await heartbeat.getRun(receipt!.runId!);
        expect(run).toMatchObject({ status: "cancelled", startedAt: null,
          errorCode: settlement === "forwarded" ? "blocking_disposition_already_forwarded" : "issue_dependencies_blocked" });
        if (settlement === "forwarded") {
          expect(run?.resultJson).toMatchObject({ blockingDispositionHandoff: handoff });
          await heartbeat.wakeup(agentId, request);
          await heartbeat.resumeQueuedRuns();
          expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, request.idempotencyKey))).toHaveLength(1);
        }
        expect(calls).toBe(1);
        return;
      }
      expect(await waitForCondition(async () => calls === 2, 30_000)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.wakeup(agentId, request);
      await heartbeat.resumeQueuedRuns();
      expect(calls).toBe(2);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, saved!.id));
      expect(await heartbeat.getRun(receipt!.runId!)).toMatchObject({ status: "succeeded", contextSnapshot: {
        interactionId: card.id, interactionStatus: "accepted", sourceRunId: source.runId, dependencyBlockedInteraction: true } });
    } finally { release(); }
  }, 90_000);

  it.each(["queued", "scheduled_retry"] as const)("retains a valid %s addressed question when a worker wake arrives", async status => {
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatConfig: { enabled: false } });
    const workerId = randomUUID();
    await db.insert(agents).values({ id: workerId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Pending planning answer", status: "in_review", assigneeAgentId: workerId }).returning();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "ask_user_questions", addresseeAgentId: agentId, createdByAgentId: workerId,
      effectiveResolverPolicy: "anyone", payload: { version: 1, questions: [] } }).returning();
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId: issue.id, wakeReason: "interaction_pending",
      contextExtras: { source: "issue.interaction.created", interactionId: interaction.id, interactionKind: interaction.kind } });
    await db.update(heartbeatRuns).set({ status, scheduledRetryReason: status === "scheduled_retry" ? "ai_connection_busy" : null,
      scheduledRetryAt: status === "scheduled_retry" ? new Date(Date.now() + 3_600_000) : null }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issue.id));
    heartbeat.startTaskDrain();
    try {
      await heartbeat.wakeup(workerId, { source: "automation", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId: issue.id }, contextSnapshot: { issueId: issue.id, wakeReason: "issue_assigned" } });
      expect(await heartbeat.getRun(runId)).toMatchObject({ status, errorCode: null });
      expect(countExecuteCallsForRun(runId)).toBe(0);
    } finally { heartbeat.stopTaskDrain(); }
  });

  it("cancels an addressed card resolved after claim at the final provider handoff", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const [issue] = await db.insert(issues).values({ companyId, title: "Question answered during startup", status: "in_review", assigneeAgentId: agentId }).returning();
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id,
      kind: "ask_user_questions", addresseeAgentId: agentId, payload: { version: 1, questions: [] } }).returning();
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId: issue.id, wakeReason: "interaction_pending",
      contextExtras: { source: "issue.interaction.created", interactionId: interaction.id, interactionKind: interaction.kind } });
    beforeContinuationDispatchCheck = async () => { await db.update(issueThreadInteractions).set({ status: "answered", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, interaction.id)); };
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => (await heartbeat.getRun(runId))?.status === "cancelled")).toBe(true);
    await heartbeat.waitForRunExecutionDrain(runId);
    const run = await heartbeat.getRun(runId);
    expect({ status: run?.status, errorCode: run?.errorCode }).toEqual({ status: "cancelled", errorCode: "issue_interaction_changed" });
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("cancels a resolved connection-intent wake parked before queued-run claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked after enqueue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, issueId));
    await heartbeat.resumeQueuedRuns();

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("backlog");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("does not re-open a resolved connection-intent issue parked after claim", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked between claim and checkout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION park_connection_intent_after_claim()
      RETURNS trigger AS $trigger$
      BEGIN
        IF NEW.id = '${runId}'::uuid AND NEW.status = 'running' THEN
          UPDATE issues SET status = 'backlog' WHERE id = '${issueId}'::uuid;
        END IF;
        RETURN NEW;
      END;
      $trigger$ LANGUAGE plpgsql;

      CREATE TRIGGER park_connection_intent_after_claim
      AFTER UPDATE OF status ON heartbeat_runs
      FOR EACH ROW EXECUTE FUNCTION park_connection_intent_after_claim();
    `));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("backlog");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    {
      mutation: "parked",
      expectedErrorCode: "issue_not_in_progress",
      expectedError: "no longer in_progress",
    },
    {
      mutation: "reassigned",
      expectedErrorCode: "issue_assignee_changed",
      expectedError: "changed assignee",
    },
  ])(
    "cancels a resolved connection-intent wake $mutation after checkout but before adapter dispatch",
    async ({ mutation, expectedErrorCode, expectedError }) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const replacementAgentId = randomUUID();
      if (mutation === "reassigned") {
        await db.insert(agents).values({
          id: replacementAgentId,
          companyId,
          name: "ReplacementCoder",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
          permissions: {},
        });
      }
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Connection intent ${mutation} at final dispatch`,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      });
      const { runId, wakeupRequestId } = await seedQueuedRun({
        companyId,
        agentId,
        issueId,
        wakeReason: "issue_commented",
        invocationSource: "automation",
        contextExtras: {
          interactionId: randomUUID(),
          interactionKind: "connection_intent",
          interactionStatus: "accepted",
          interactionResolvedAt: "2026-08-28T13:30:00.000Z",
          mutation: "interaction",
          source: "connection_intent.resolved",
        },
      });
      beforeContinuationDispatchCheck = async ({ runId: guardedRunId, issueId: guardedIssueId }) => {
        expect(guardedRunId).toBe(runId);
        expect(guardedIssueId).toBe(issueId);
        await db
          .update(issues)
          .set(mutation === "parked"
            ? { status: "backlog", updatedAt: new Date() }
            : { assigneeAgentId: replacementAgentId, updatedAt: new Date() })
          .where(eq(issues.id, issueId));
      };

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const [run, wakeup, issue] = await Promise.all([
        db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeupRequestId))
          .then((rows) => rows[0] ?? null),
        db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null),
      ]);
      expect(run).toMatchObject({ status: "cancelled", errorCode: expectedErrorCode });
      expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining(expectedError) });
      expect(issue).toMatchObject(mutation === "parked"
        ? { status: "backlog", assigneeAgentId: agentId }
        : { status: "in_progress", assigneeAgentId: replacementAgentId });
      expect(countExecuteCallsForRun(runId)).toBe(0);
    },
  );

  it("rejects ownership changes immediately before the final continuation handoff", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Connection intent parked at the atomic dispatch gate",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const { runId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: "issue_commented",
      invocationSource: "automation",
      contextExtras: {
        interactionId: randomUUID(),
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        source: "connection_intent.resolved",
      },
    });

    const ordering: string[] = [];
    let parkPromise: Promise<unknown> | null = null;
    afterContinuationDispatchCheck = async ({ runId: guardedRunId, issueId: guardedIssueId }) => {
      expect(guardedRunId).toBe(runId);
      expect(guardedIssueId).toBe(issueId);
      ordering.push("validated");
      parkPromise = Promise.resolve(
        db
          .update(issues)
          .set({
            status: "backlog",
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issueId))
          .returning({ id: issues.id }),
      ).then((rows) => {
        expect(rows).toHaveLength(1);
        ordering.push("parked");
      });
      // Admission is committed before adapter-owned setup. This concurrent
      // update must not wait on a lock held by the adapter callback.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await parkPromise;
      expect(ordering).toEqual(["validated", "parked"]);
    };
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await parkPromise;

    expect((await heartbeat.getRun(runId))?.status).toBe("cancelled");
    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("backlog");
    expect(ordering).toEqual(["validated", "parked"]);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it("leaves ineligible timers disarmed without writing skipped wakes or moving their baseline", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
        skipTimerWhenNoActionableWork: true,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({ lastHeartbeatAt: new Date(now.getTime() - 120_000) })
      .where(eq(agents.id, agentId));

    const firstTick = await heartbeat.tickTimers(now);
    const secondTick = await heartbeat.tickTimers(now);

    expect(firstTick.skipped).toBe(0);
    expect(await heartbeat.nextAgentTimerAt()).toBeNull();
    expect(secondTick.skipped).toBe(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(wakeups).toEqual([]);
    expect(agent?.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(agent?.lastHeartbeatAt?.getTime()).toBe(now.getTime() - 120_000);
  });

  it("atomically claims a due timer interval across overlapping scheduler ticks", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        intervalSec: 60,
      },
    });
    const now = new Date();
    await db
      .update(agents)
      .set({
        createdAt: new Date(now.getTime() - 120_000),
        lastHeartbeatAt: null,
      })
      .where(eq(agents.id, agentId));

    const results = await Promise.all([
      heartbeat.tickTimers(now),
      heartbeat.tickTimers(now),
    ]);

    expect(results.reduce((total, result) => total + result.enqueued, 0)).toBe(1);

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const [agent] = await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.contextSnapshot).toMatchObject({
      timerClaimWasFirstHeartbeat: true,
    });
    expect(agent?.lastHeartbeatAt?.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("allows generic timer wakes when the agent has assigned todo work", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: true,
      },
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Assigned work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
    });

    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows legacy generic timer wakes by default when no skip policy is set", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
    });

    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("allows explicit proactive generic timer wakes without assigned issue work", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        enabled: true,
        skipTimerWhenNoActionableWork: false,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
    });

    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
  });

  it("skips wakes before queueing when per-agent daily run cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("treats zero daily run cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("counts started cancelled runs toward the per-agent daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "cancelled",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_run_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 1,
        limit: 1,
      },
    });
  });

  it("coalesces same-issue wakes before enforcing the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      payload: { issueId },
    });

    expect(run?.id).toBe(queuedRunId);
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const wakeups = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "coalesced",
          reason: "issue_execution_same_name",
          runId: queuedRunId,
        }),
      ]),
    );
  });

  it.each(["codex_local", "gemini_local"].flatMap(adapterType => [
    { adapterType, inputTokens: 50_000, cachedInputTokens: 550_000, rotate: true, rawInputIncludesCached: false },
    { adapterType, inputTokens: 50_000, cachedInputTokens: 449_999, rotate: false, rawInputIncludesCached: false },
    { adapterType, inputTokens: 0, cachedInputTokens: 500_000, rotate: true, rawInputIncludesCached: false },
    { adapterType, inputTokens: 400_000, cachedInputTokens: 350_000, rotate: false, rawInputIncludesCached: undefined },
    { adapterType, inputTokens: 500_000, cachedInputTokens: 350_000, rotate: true, rawInputIncludesCached: undefined },
  ]))("counts cached prompt input for $adapterType session rotation ($inputTokens + $cachedInputTokens; raw includes cache: $rawInputIncludesCached)", async ({ adapterType, inputTokens, cachedInputTokens, rotate, rawInputIncludesCached }) => {
    const { companyId, agentId } = await seedCompanyAndAgent({ heartbeatConfig: {
      sessionCompaction: { enabled: true, maxSessionRuns: 0, maxRawInputTokens: 500_000, maxSessionAgeHours: 0 },
    } });
    const sessionId = randomUUID();
    await db.update(agents).set({ adapterType }).where(eq(agents.id, agentId));
    await db.insert(agentRuntimeState).values({ companyId, agentId, adapterType, sessionId });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "succeeded", sessionIdAfter: sessionId,
      usageJson: { ...(rawInputIncludesCached === false ? { rawInputIncludesCached } : {}), inputTokens, cachedInputTokens, outputTokens: 10, rawInputTokens: inputTokens, rawCachedInputTokens: cachedInputTokens },
      resultJson: { summary: "Continue from this completed turn" }, startedAt: new Date(), finishedAt: new Date(),
    });
    mockAdapterExecute.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      provider: "test", model: "test-model", costUsd: 0, usageComplete: true, usageBasis: "per_run",
      usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 },
    });
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual" });
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(countExecuteCallsForRun(run!.id)).toBe(1);
    const [context] = mockAdapterExecute.mock.calls.find(([context]) => context?.runId === run!.id)!;
    expect(context.runtime.sessionId).toBe(rotate ? null : sessionId);
    if (rotate) {
      expect(context.context.paperclipSessionRotationReason).toContain((inputTokens + (rawInputIncludesCached === false ? cachedInputTokens : 0)).toLocaleString("en-US"));
      expect(context.context.paperclipSessionHandoffMarkdown).toContain("Continue from this completed turn");
    } else expect(context.context.paperclipSessionRotationReason).toBeUndefined();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(finished.usageJson).toMatchObject({ rawInputTokens: 1, rawCachedInputTokens: 2, rawInputIncludesCached: false });
  });

  it("skips wakes before queueing when per-agent daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 75,
        limit: 75,
      },
    });
  });

  it("treats zero daily cost cap as a hard stop", async () => {
    const { agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 0,
      },
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    expect(wakeup).toMatchObject({
      status: "skipped",
      reason: "heartbeat.daily_cost_limit",
    });
    expect(wakeup?.payload).toMatchObject({
      heartbeatSkip: {
        observed: 0,
        limit: 0,
      },
    });
  });

  it("skips already queued runs before adapter execution when the daily cost cap is reached", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyCostCents: 75,
      },
    });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {},
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(costEvents).values({
      companyId,
      agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      costCents: 75,
      occurredAt: new Date(),
    });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    const [wakeup] = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_cost_limit",
    });
    expect(run?.resultJson).toMatchObject({
      stopReason: "heartbeat.daily_cost_limit",
      observed: 75,
      limit: 75,
    });
    expect(wakeup).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("per-day heartbeat budget cap"),
    });
  });

  it("skips already queued issue runs at the daily run cap and releases the execution lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const [run] = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId));
    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const [issue] = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId));

    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "heartbeat.daily_run_limit",
    });
    expect(wakeup).toMatchObject({ status: "skipped" });
    expect(issue?.executionRunId).toBeNull();
  });

  it("promotes deferred issue wakes when a queued holder is cancelled by the daily run cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent({
      heartbeatConfig: {
        maxDailyRuns: 1,
      },
    });
    const peerAgentId = randomUUID();
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const queuedRunId = randomUUID();
    const deferredWakeupId = randomUUID();
    await db.insert(agents).values({
      id: peerAgentId,
      companyId,
      name: "PeerAgent",
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
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "succeeded",
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      contextSnapshot: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued issue work",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: queuedRunId,
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeupId,
      companyId,
      agentId: peerAgentId,
      source: "comment",
      triggerDetail: "mention",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_mention",
        },
      },
      status: "deferred_issue_execution",
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: queuedRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [deferred] = await db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeupId));
    const [promotedRun] = deferred?.runId
      ? await db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, deferred.runId))
      : [];

    expect(deferred?.status).not.toBe("deferred_issue_execution");
    expect(promotedRun?.agentId).toBe(peerAgentId);
  });

  it("cancels queued max-turn continuations when another continuation owns the issue lock", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const lockOwnerRunId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: lockOwnerRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
      scheduledRetryAt: new Date("2026-04-20T12:00:00.000Z"),
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Duplicate max-turn continuation",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: lockOwnerRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: new Date("2026-04-20T11:59:00.000Z"),
    });

    const { runId, wakeupRequestId } = await seedQueuedRun({
      companyId,
      agentId,
      issueId,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      invocationSource: "automation",
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextExtras: {
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [run, wakeup, issue] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(run?.status).toBe("cancelled");
    expect(run?.errorCode).toBe("issue_execution_lock_changed");
    expect(run?.resultJson).toMatchObject({ stopReason: "issue_execution_lock_changed" });
    expect(wakeup?.status).toBe("skipped");
    expect(wakeup?.error).toContain("execution lock");
    expect(issue?.executionRunId).toBe(lockOwnerRunId);
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });

  it.each([
    ["accepted", "connection_intent"],
    ["rejected", "connection_intent"],
    ["rejected", "request_confirmation"],
  ])("resumes a %s %s outcome and promotes the claimed review task", async (interactionStatus, interactionKind) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const wakeCommentId = randomUUID();
    let claimedIssue: { status: string; executionRunId: string | null } | null = null;
    let resumedRunId: string | undefined;
    let signalAdapterStarted!: () => void;
    const adapterStarted = new Promise<void>(resolve => { signalAdapterStarted = resolve; });
    const execute = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementation(async (...args: Parameters<typeof execute>) => {
      if ((args[0] as { runId: string }).runId === resumedRunId) {
        signalAdapterStarted();
        // A claimed continuation can finish after the old terminal poll.
        if (interactionStatus === "rejected" && interactionKind === "connection_intent") {
          await new Promise(resolve => setTimeout(resolve, 3100));
        }
      }
      return execute(...args);
    });
    afterContinuationDispatchCheck = async ({ runId: checkedRunId, issueId: checkedIssueId }) => {
      if (checkedIssueId !== issueId || checkedRunId !== resumedRunId) return;
      claimedIssue = await db
        .select({ status: issues.status, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(claimedIssue).toEqual({ status: "in_progress", executionRunId: checkedRunId });
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Waiting for connection", status: "in_review", priority: "medium", assigneeAgentId: agentId });
    await db.insert(issueComments).values({
      id: wakeCommentId,
      companyId,
      issueId,
      authorUserId: "local-board",
      body: "Continue after the interaction result.",
    });
    if (interactionKind === "request_confirmation") {
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "rejected",
        continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Approve the plan?" },
        result: { version: 1, outcome: "rejected", reason: "Needs more work" },
        createdByAgentId: agentId,
        resolvedAt: new Date(),
      });
    }
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId, wakeReason: "issue_commented",
      contextExtras: { interactionId, interactionKind, interactionStatus, wakeCommentId,
        originCommentIds: [wakeCommentId],
        interactionResolvedAt: new Date().toISOString(), mutation: "interaction", source: `${interactionKind}.resolved`, forceFreshSession: true } });
    resumedRunId = runId;
    await heartbeat.resumeQueuedRuns();
    // Adapter entry guarantees this exact execution is registered. Await its
    // owning completion barrier before terminal assertions and fixture cleanup.
    await adapterStarted;
    await heartbeat.waitForRunExecutionDrain(runId);
    expect((await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status).toBe("succeeded");
    expect(countExecuteCallsForRun(runId)).toBe(1);
    expect(claimedIssue).toEqual({ status: "in_progress", executionRunId: runId });
  });

  async function seedAnsweredQuestion(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    sourceRunId: string | null;
    rejectedConfirmation?: boolean;
  }) {
    const interactionId = randomUUID();
    const resolved = {
      id: interactionId,
      companyId: input.companyId,
      issueId: input.issueId,
      continuationPolicy: "wake_assignee",
      createdByAgentId: input.agentId,
      sourceRunId: input.sourceRunId,
      resolvedByUserId: "responsible-user",
      resolvedAt: new Date(),
    };
    await db.insert(issueThreadInteractions).values(input.rejectedConfirmation
      ? {
        ...resolved,
        kind: "request_confirmation",
        status: "rejected",
        payload: { version: 1, prompt: "Approve the plan?" },
        result: { version: 1, outcome: "rejected", reason: "Needs more work" },
      }
      : {
        ...resolved,
        kind: "ask_user_questions",
        status: "answered",
        payload: { version: 1, questions: [{ id: "first-task-opening", prompt: "What would you like to do?", selectionMode: "single",
          required: true, options: [{ id: "interview", label: "Interview me" }] }] },
        result: { version: 1, answers: [{ questionId: "first-task-opening", optionIds: ["interview"] }] },
      });
    // Mirrors the context question-response delivery queues for an answer.
    return {
      interactionId,
      interactionKind: input.rejectedConfirmation ? "request_confirmation" : "ask_user_questions",
      interactionStatus: input.rejectedConfirmation ? "rejected" : "answered",
      mutation: "interaction",
      sourceRunId: input.sourceRunId,
      externalChatContinuation: false,
      source: "issue.interaction.respond",
    };
  }

  it("starts the assignee when a question no run asked is answered on a todo task that has never started", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    let answeredRunId: string | undefined;
    let claimedIssue: { status: string; executionRunId: string | null } | null = null;
    afterContinuationDispatchCheck = async ({ runId: checkedRunId, issueId: checkedIssueId }) => {
      if (checkedIssueId !== issueId || checkedRunId !== answeredRunId) return;
      claimedIssue = await db
        .select({ status: issues.status, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Onboarding first task", status: "todo", priority: "medium", assigneeAgentId: agentId });
    const contextExtras = await seedAnsweredQuestion({ companyId, issueId, agentId, sourceRunId: null });
    const { runId } = await seedQueuedRun({ companyId, agentId, issueId, wakeReason: "issue_commented",
      invocationSource: "automation", contextExtras });
    answeredRunId = runId;

    await heartbeat.resumeQueuedRuns();
    await vi.waitFor(async () => {
      const current = await heartbeat.getRun(runId);
      expect(countExecuteCallsForRun(runId), JSON.stringify({
        status: current?.status, errorCode: current?.errorCode,
      })).toBe(1);
    }, { timeout: 30_000 });
    await heartbeat.waitForRunExecutionDrain(runId);

    expect((await heartbeat.getRun(runId))?.status).toBe("succeeded");
    expect(claimedIssue).toEqual({ status: "in_progress", executionRunId: runId });
    expect((await db.select({ startedAt: issues.startedAt }).from(issues).where(eq(issues.id, issueId)))[0]?.startedAt)
      .toBeInstanceOf(Date);
  }, 60_000);

  it.each([
    { name: "a started task parked back in todo", startedAt: new Date("2026-01-01T00:00:00.000Z"), askedByRun: false, rejectedConfirmation: false },
    { name: "a question an agent run asked", startedAt: null, askedByRun: true, rejectedConfirmation: false },
    { name: "a rejected confirmation no run asked", startedAt: null, askedByRun: false, rejectedConfirmation: true },
  ])("keeps cancelling an answer continuation for $name", async ({ startedAt, askedByRun, rejectedConfirmation }) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Parked or agent-asked", status: "todo", priority: "medium",
      assigneeAgentId: agentId, startedAt });
    const [sourceRun] = askedByRun
      ? await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment", status: "succeeded",
        startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId } }).returning()
      : [null];
    const contextExtras = await seedAnsweredQuestion({ companyId, issueId, agentId, sourceRunId: sourceRun?.id ?? null,
      rejectedConfirmation });
    const { runId, wakeupRequestId } = await seedQueuedRun({ companyId, agentId, issueId, wakeReason: "issue_commented",
      invocationSource: "automation", contextExtras });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [run, wakeup, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_not_in_progress" });
    expect(wakeup).toMatchObject({ status: "skipped", error: expect.stringContaining("no longer in_progress") });
    expect(issue?.status).toBe("todo");
    expect(countExecuteCallsForRun(runId)).toBe(0);
  });
});
