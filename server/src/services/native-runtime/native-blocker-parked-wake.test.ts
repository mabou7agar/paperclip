import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, completionContracts, createDb, heartbeatRuns, issueRelations, issues,
  nativeRunFinalizations, nativeRunResults, statusDecisionEffects, workAssessments, type Db,
} from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { logger } from "../../middleware/logger.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";
import { issueBlockerParkedWakeKey } from "../blocker-parked-wakeups.js";

// When set, the waiter lookup fails inside the database, as a broken query would.
const lookupFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("../blocker-parked-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../blocker-parked-wakeups.js")>("../blocker-parked-wakeups.js");
  return {
    ...actual,
    listBlockerParkedWakeups: async (db: Db, input: { companyId: string; blockerIssueId: string }) => {
      if (lookupFailure.enabled) await db.execute(sql`select 1 / 0`);
      return actual.listBlockerParkedWakeups(db, input);
    },
  };
});

describe.skipIf(!recoveryPostgresSupport.supported)("native status commit of a parked blocker", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db;
  beforeAll(async () => {
    database = await startRecoveryPostgres("native-blocker-parked-wake-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(() => { lookupFailure.enabled = false; vi.restoreAllMocks(); });

  async function seed(options: { blockerStatus?: "in_progress" | "blocked" } = {}) {
    const companyId = randomUUID(), workerId = randomUUID(), waiterAgentId = randomUUID();
    const blockerId = randomUUID(), waiterId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Parked blocker", issuePrefix: `B${companyId.slice(0, 7)}` });
    await db.insert(agents).values([
      { id: workerId, companyId, name: "Engineer", adapterType: "paperclip_runner" },
      { id: waiterAgentId, companyId, name: "QA", adapterType: "paperclip_runner" },
    ]);
    const blockerStatus = options.blockerStatus ?? "in_progress";
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Build the package", status: blockerStatus, assigneeAgentId: workerId,
        blockedTransitionAt: blockerStatus === "blocked" ? new Date("2026-11-22T10:00:00.000Z") : null },
      { id: waiterId, companyId, title: "Verify the package", status: "blocked", assigneeAgentId: waiterAgentId },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: waiterId, type: "blocks" });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId: blockerId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "parked-test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "1", criteria: [] }, canonicalSha256: randomUUID(), createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: workerId, status: "running", runtimeMode: "native",
      nativeIssueId: blockerId, completionContractId: contractId, contextSnapshot: { issueId: blockerId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId: blockerId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: {}, canonicalSha256: randomUUID() });
    const [task] = await db.select().from(issues).where(eq(issues.id, blockerId));
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId: blockerId, runId, contractId, resultId,
      triggerKind: "native_result", triggerActorCompanyId: companyId, priorIssueStatus: task.status,
      priorStatusVersion: task.statusVersion, policyVersion: "parked-test", assessmentJson: {}, inputDigest: randomUUID() });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: blockerId, phase: "arbitrating", resultId });
    const commit = (executor: Db = db) => commitNativeStatusDecision({ db: executor,
      companyId, issueId: blockerId, runId, assessmentId, priorStatus: task.status, priorStatusVersion: task.statusVersion,
      priorDecisionId: task.lastStatusDecisionId,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "blocked", toStatus: "blocked",
        reasonCode: "parked_blocker_test", unblockDescriptor: null, effects: [] } });
    const wakes = () => db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blocker_parked")));
    const blocker = async () => (await db.select().from(issues).where(eq(issues.id, blockerId)))[0]!;
    return { companyId, blockerId, waiterId, waiterAgentId, commit, wakes, blocker };
  }

  it("wakes the assignee waiting on the task once per blocked transition", async () => {
    const f = await seed();
    const committed = await f.commit();
    const parked = await f.blocker();
    expect(parked.status).toBe("blocked");
    expect(parked.blockedTransitionAt).not.toBeNull();

    const wakes = await f.wakes();
    expect(wakes).toHaveLength(1);
    const transitionAt = parked.blockedTransitionAt!.toISOString();
    expect(wakes[0]).toMatchObject({
      agentId: f.waiterAgentId,
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: issueBlockerParkedWakeKey({ waiterIssueId: f.waiterId, blockerIssueId: f.blockerId, blockedTransitionAt: transitionAt }),
      payload: {
        issueId: f.waiterId,
        blockerParked: { blockerIssueId: f.blockerId, blockerIssueStatus: "blocked", blockedTransitionAt: transitionAt },
        _paperclipWakeContext: {
          issueId: f.waiterId,
          wakeReason: "issue_blocker_parked",
          blockerParked: { blockerIssueId: f.blockerId, blockedTransitionAt: transitionAt },
        },
      },
    });
    const effects = await db.select().from(statusDecisionEffects)
      .where(and(eq(statusDecisionEffects.decisionId, committed.decision.id), eq(statusDecisionEffects.effectKind, "blocker_parked_wake")));
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ targetType: "agent_wakeup_request", targetId: wakes[0]!.id });

    // Replaying the same decision never wakes twice.
    const reopened = createDb(database.connectionString);
    try { expect((await f.commit(reopened)).replayed).toBe(true); }
    finally { await reopened.$client.end(); }
    expect(await f.wakes()).toHaveLength(1);
  });

  it("does not wake again when the task was already blocked", async () => {
    const f = await seed({ blockerStatus: "blocked" });
    await f.commit();
    expect((await f.blocker()).status).toBe("blocked");
    expect(await f.wakes()).toHaveLength(0);
  });

  it("commits the blocked status when the waiter lookup fails", async () => {
    const f = await seed();
    const warned = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    lookupFailure.enabled = true;
    const committed = await f.commit();
    expect(committed.replayed).toBe(false);
    expect(committed.decision.applicationState).toBe("applied");
    expect((await f.blocker()).status).toBe("blocked");
    expect(await f.wakes()).toHaveLength(0);
    expect(warned).toHaveBeenCalledWith(expect.objectContaining({ issueId: f.blockerId }),
      "failed to wake waiters of a natively parked blocker");
  });
});
