import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions,
  issues, type Db,
} from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { reassignedConversationHoldReleasedPredicate } from "./conversation-continuation.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";

describe.skipIf(!recoveryPostgresSupport.supported)("a conversation hold released by a verified reassignment", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => {
    database = await startRecoveryPostgres("reassigned-conversation-hold-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  /**
   * A person moved the task from the old agent to a new one while the old
   * agent's legacy conversation run was live. The run was stopped for the
   * reassignment, settled cleanly, and its recovery hold was resolved.
   */
  async function seed() {
    const companyId = randomUUID(), oldAgentId = randomUUID(), newAgentId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), actionId = randomUUID();
    const startedAt = new Date(Date.now() - 10 * 60_000), finishedAt = new Date(Date.now() - 5 * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Reassigned hold", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: oldAgentId, companyId, name: "Old owner", adapterType: "codex_local" },
      { id: newAgentId, companyId, name: "New owner", adapterType: "codex_local" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassigned conversation", status: "in_progress",
      assigneeAgentId: newAgentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: oldAgentId, issueId, status: "cancelled",
      runtimeMode: "legacy", errorCode: "issue_reassigned", startedAt, finishedAt, executionStage: "settled", nextEventSeq: 2,
      contextSnapshot: { issueId },
      // The run is a conversation run by the adapter that executed it. Without
      // a continuation policy, only the verified reassignment can release its hold.
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: randomUUID(),
        cancellation: { source: "control_plane", expected: true } } });
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId: oldAgentId, seq: 1, eventType: "lifecycle",
      stream: "system", payload: { phase: "task.run.measured", outcome: "cancelled", durableSettlement: true },
      createdAt: new Date(finishedAt.getTime() + 1_000) });
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "person", action: "issue.updated",
      entityType: "issue", entityId: issueId, createdAt: new Date(startedAt.getTime() + 60_000),
      details: { assigneeAgentId: newAgentId, _previous: { assigneeAgentId: oldAgentId } } });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "restored", resolvedAt: finishedAt, returnOwnerAgentId: oldAgentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `reassigned:${runId}`,
      nextAction: "The new owner continues the task.", resolutionNote: "Released by the verified reassignment.",
      evidence: { runId, automaticRecovery: { runId, replay: "blocked" } } });
    const released = async () => (await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.id, actionId), reassignedConversationHoldReleasedPredicate()))).length === 1;
    return { companyId, oldAgentId, newAgentId, issueId, runId, actionId, finishedAt, released };
  }

  it("matches the verified reassignment and lets the new owner run", async () => {
    const f = await seed();
    expect(await f.released()).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it.each<[string, (f: Awaited<ReturnType<typeof seed>>) => Promise<unknown>]>([
    ["the hold is still active", f => db.update(issueRecoveryActions).set({ status: "active" }).where(eq(issueRecoveryActions.id, f.actionId))],
    ["the run was stopped for another reason", f => db.update(heartbeatRuns).set({ errorCode: "process_lost" }).where(eq(heartbeatRuns.id, f.runId))],
    ["the run never settled", f => db.update(heartbeatRuns).set({ executionStage: "running" }).where(eq(heartbeatRuns.id, f.runId))],
    ["the stop was not confirmed", f => db.update(heartbeatRuns).set({ resultJson: { cancellation: { source: "control_plane", expected: true } } })
      .where(eq(heartbeatRuns.id, f.runId))],
    ["the run is not a conversation run", f => db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "process" } } })
      .where(eq(heartbeatRuns.id, f.runId))],
    ["the task went back to the old agent", f => db.update(issues).set({ assigneeAgentId: f.oldAgentId }).where(eq(issues.id, f.issueId))],
    ["the old agent is the pending reviewer", f => db.update(issues).set({ executionState: { status: "pending",
      currentParticipant: { type: "agent", agentId: f.oldAgentId, userId: null } } }).where(eq(issues.id, f.issueId))],
    ["no person reassigned the task", f => db.delete(activityLog).where(eq(activityLog.entityId, f.issueId))],
    ["the run's settlement was never measured", f => db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))],
    ["the run still holds an environment lease", f => db.insert(environmentLeases).values({ companyId: f.companyId,
      heartbeatRunId: f.runId, status: "active" })],
    ["the hold carries system recovery", f => db.update(issueRecoveryActions).set({ evidence: { runId: f.runId,
      automaticRecovery: { runId: f.runId, replay: "blocked" }, systemRecovery: { state: "pending" } } })
      .where(eq(issueRecoveryActions.id, f.actionId))],
  ])("does not match when %s", async (_label, change) => {
    const f = await seed();
    await change(f);
    expect(await f.released()).toBe(false);
  });

  it("keeps the dispatch hold when the reassignment cannot be verified", async () => {
    const f = await seed();
    await db.delete(activityLog).where(eq(activityLog.entityId, f.issueId));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
  });

  it("settles the released hold without replacing its recorded outcome", async () => {
    const f = await seed();
    await settleUnrecoverableExecutions(db);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    expect(action).toMatchObject({
      status: "resolved", outcome: "restored", resolvedAt: f.finishedAt,
      nextAction: "The new owner continues the task.", resolutionNote: "Released by the verified reassignment.",
      evidence: { runId: f.runId, automaticRecovery: { runId: f.runId, replay: "conversation_continuation" } },
    });
    const [settled] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, "issue.execution_recovery_settled")));
    expect(settled?.details).toMatchObject({ recoveryActionId: f.actionId, outcome: "restored", continuation: "conversation" });
    // Still released for the new owner after settling.
    expect(await f.released()).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });
});
