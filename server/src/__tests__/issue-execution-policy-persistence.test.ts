import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { buildExecutionPolicy } from "../../../ui/src/lib/issue-execution-policy.ts";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("edited execution policy persistence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-policy-persistence-");
    db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it.each(["reviewer", "monitor"] as const)("retains the independent review limit after removing the last %s", async (removed) => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const original = normalizeIssueExecutionPolicy({
      maxReviewRounds: 4,
      ...(removed === "monitor"
        ? { monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" } }
        : { stages: [{ type: "review", participants: [{ type: "user", userId: "board-reviewer" }] }] }),
    });
    await db.insert(companies).values({ id: companyId, name: "Policy fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review limit fixture", executionPolicy: original as Record<string, unknown> | null });
    const edited = buildExecutionPolicy({ existingPolicy: original, reviewerValues: [], approverValues: [] })!;
    // The monitor editor removes this key after building the unchanged stages.
    const { monitor: _removedMonitor, ...withoutMonitor } = edited;
    const normalized = normalizeIssueExecutionPolicy(removed === "monitor" ? withoutMonitor : edited);
    const service = issueService(db);
    await service.update(issueId, { executionPolicy: normalized as Record<string, unknown> | null, companyGuard: companyId });
    const saved = await service.getById(issueId);
    expect(saved?.executionPolicy).toEqual({ mode: "normal", commentRequired: true, stages: [], maxReviewRounds: 4 });

    const restored = normalizeIssueExecutionPolicy(buildExecutionPolicy({
      existingPolicy: normalizeIssueExecutionPolicy(saved?.executionPolicy),
      reviewerValues: ["user:board-reviewer"], approverValues: [],
    }));
    expect(restored).toMatchObject({ maxReviewRounds: 4, stages: [{ type: "review" }] });
  });
  it("persists progress history and rejects stale concurrent review snapshots under the real row lock", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review progress persistence", issuePrefix: `R${companyId.slice(0, 6)}` });
    const policy = normalizeIssueExecutionPolicy({ reviewGuard: { mode: "progress", maxStalledRounds: 3 },
      stages: [{ type: "review", participants: [{ type: "user", userId: "reviewer" }] }] })!;
    const state = { status: "pending", currentStageId: policy.stages[0]!.id, currentStageIndex: 0,
      currentStageType: "review", currentParticipant: { type: "user", userId: "reviewer", agentId: null },
      returnAssignee: null, reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      changesRequestedCount: 7, reviewProgress: { stageId: policy.stages[0]!.id, stalledRounds: 0,
        openFindingIds: ["F2"], requiredGateIds: ["security"], creditedFindingIds: ["F1"], creditedGateIds: [],
        lastAssessment: { baselineDecisionId: null, candidateRef: "candidate-A", evidenceRefs: ["receipt-A"],
          openFindingIds: ["F2"], requiredGateIds: ["security"], resolvedFindingIds: [], passedGateIds: [] } } };
    const [row] = await db.insert(issues).values({ id: issueId, companyId, title: "Progress snapshot", status: "in_review", responsibleUserId: "owner",
      executionPolicy: policy as unknown as Record<string, unknown>, executionState: state }).returning();
    const service = issueService(db);
    const expectedReviewSnapshot = { executionPolicy: row!.executionPolicy, executionState: row!.executionState,
      status: row!.status, assigneeAgentId: row!.assigneeAgentId, assigneeUserId: row!.assigneeUserId };
    const decision = { ...state, lastDecisionId: randomUUID(), reviewProgress: { ...state.reviewProgress, stalledRounds: 1 } };
    const results = await Promise.allSettled([
      service.update(issueId, { companyGuard: companyId, executionState: decision, expectedReviewSnapshot }),
      service.update(issueId, { companyGuard: companyId, executionState: { ...decision, lastDecisionId: randomUUID() }, expectedReviewSnapshot }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.details).toMatchObject({ code: "review_progress_snapshot_changed" });
    // A fresh service instance reads the durable streak/credits; no in-memory counter reset.
    expect((await issueService(db).getById(issueId))?.executionState).toMatchObject({ changesRequestedCount: 7,
      reviewProgress: { stalledRounds: 1, creditedFindingIds: ["F1"], openFindingIds: ["F2"] } });
  });

  it("validates the post-update escalation owner and permits cancellation if an older row has no owner", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owner invariants", issuePrefix: `O${companyId.slice(0, 6)}` });
    const policy = normalizeIssueExecutionPolicy({ reviewGuard: { mode: "progress", maxStalledRounds: 3 } })!;
    await db.insert(issues).values({ id: issueId, companyId, title: "No owner initially" });
    const service = issueService(db);
    await service.update(issueId, { executionPolicy: policy as unknown as Record<string, unknown>, responsibleUserId: "owner" });
    await expect(service.update(issueId, { responsibleUserId: null })).rejects.toMatchObject({ details: { code: "review_progress_owner_required" } });
    expect((await service.getById(issueId))?.responsibleUserId).toBe("owner");
    // A real legacy/corrupt row without an owner can still be cancelled safely.
    await service.update(issueId, { status: "cancelled", responsibleUserId: null });
    expect((await service.getById(issueId))?.status).toBe("cancelled");
  });

  it("enforces progress review authority and effective owner on every service create path", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Create governance", issuePrefix: `C${companyId.slice(0, 6)}` });
    const service = issueService(db);
    const policy = normalizeIssueExecutionPolicy({ reviewGuard: { mode: "progress", maxStalledRounds: 50 } })!;
    await expect(service.create(companyId, { title: "Agent guard bypass", createdByAgentId: randomUUID(), executionPolicy: policy as unknown as Record<string, unknown> }))
      .rejects.toMatchObject({ details: { code: "review_progress_policy_protected" } });
    await expect(service.create(companyId, { title: "No escalation owner", executionPolicy: policy as unknown as Record<string, unknown> }))
      .rejects.toMatchObject({ details: { code: "review_progress_owner_required" } });
    const created = await service.create(companyId, { title: "Board configured task", createdByUserId: "owner", executionPolicy: policy as unknown as Record<string, unknown> });
    expect(created.executionPolicy).toMatchObject({ reviewGuard: { mode: "progress", maxStalledRounds: 50 } });
    await expect(service.update(created.id, { actorAgentId: randomUUID(), executionPolicy: null }))
      .rejects.toMatchObject({ details: { code: "review_progress_policy_protected" } });
    expect((await service.getById(created.id))?.executionPolicy).toEqual(created.executionPolicy);
  });

});
