import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { assertReviewEscalationAgent, isReviewEscalationAgentAvailable, resolveReviewEscalationAgentId } from "../services/review-escalation-agent.js";
import { buildExecutionPolicy } from "../../../ui/src/lib/issue-execution-policy.ts";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
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
  it("accepts only a usable agent of the same company as review escalation agent", async () => {
    const companyId = randomUUID(), otherCompanyId = randomUUID();
    const [activeId, pausedId, terminatedId, foreignId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.insert(companies).values([
      { id: companyId, name: "Escalation fixture", issuePrefix: `E${companyId.slice(0, 6)}` },
      { id: otherCompanyId, name: "Other company", issuePrefix: `O${otherCompanyId.slice(0, 6)}` },
    ]);
    const agent = (id: string, owner: string, status: string) => ({
      id, companyId: owner, name: `Agent ${id.slice(0, 4)}`, role: "cto", status, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([
      agent(activeId, companyId, "idle"), agent(pausedId, companyId, "paused"),
      agent(terminatedId, companyId, "terminated"), agent(foreignId, otherCompanyId, "idle"),
    ]);
    const named = (reviewEscalationAgentId: string | null) => ({ reviewEscalationAgentId });

    await expect(assertReviewEscalationAgent(db, companyId, named(activeId))).resolves.toBeUndefined();
    await expect(assertReviewEscalationAgent(db, companyId, named(null))).resolves.toBeUndefined();
    await expect(assertReviewEscalationAgent(db, companyId, null)).resolves.toBeUndefined();
    for (const missing of [foreignId, randomUUID()]) {
      await expect(assertReviewEscalationAgent(db, companyId, named(missing)))
        .rejects.toMatchObject({ status: 422, details: { code: "review_escalation_agent_not_found" } });
    }
    for (const unusable of [pausedId, terminatedId]) {
      await expect(assertReviewEscalationAgent(db, companyId, named(unusable)))
        .rejects.toMatchObject({ status: 422, details: { code: "review_escalation_agent_unavailable" } });
    }

    // At escalation time the same facts decide whether the agent or the human receives the review.
    expect(await isReviewEscalationAgentAvailable(db, companyId, named(activeId))).toBe(true);
    for (const unavailable of [pausedId, terminatedId, foreignId, randomUUID(), null]) {
      expect(await isReviewEscalationAgentAvailable(db, companyId, named(unavailable))).toBe(false);
    }
    // An agent paused after the policy was saved stops being available.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, activeId));
    expect(await isReviewEscalationAgentAvailable(db, companyId, named(activeId))).toBe(false);
  });

  it("resolves the escalation agent from the task, then the company default, and only when it can run", async () => {
    const companyId = randomUUID(), plainCompanyId = randomUUID();
    const [defaultAgentId, taskAgentId] = [randomUUID(), randomUUID()];
    await db.insert(companies).values([
      { id: companyId, name: "Default fixture", issuePrefix: `D${companyId.slice(0, 6)}` },
      { id: plainCompanyId, name: "No default", issuePrefix: `N${plainCompanyId.slice(0, 6)}` },
    ]);
    await db.insert(agents).values([defaultAgentId, taskAgentId].map((id, index) => ({
      id, companyId, name: index === 0 ? "CTO" : "Tech Lead", role: "cto", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    })));
    const stages = [{ type: "review", participants: [{ type: "user", userId: "board-reviewer" }] }];
    const unset = normalizeIssueExecutionPolicy({ stages })!;
    const override = normalizeIssueExecutionPolicy({ stages, reviewEscalationAgentId: taskAgentId })!;
    const optedOut = normalizeIssueExecutionPolicy({ stages, reviewEscalationAgentId: null })!;
    expect("reviewEscalationAgentId" in unset).toBe(false);
    expect(optedOut.reviewEscalationAgentId).toBeNull();

    // A company that has not set a default behaves as before: no agent, straight to the human.
    expect(await resolveReviewEscalationAgentId(db, companyId, unset)).toBeNull();
    expect(await resolveReviewEscalationAgentId(db, plainCompanyId, unset)).toBeNull();

    await db.update(companies).set({ defaultReviewEscalationAgentId: defaultAgentId }).where(eq(companies.id, companyId));
    // The default applies to a task that names none; another company is untouched.
    expect(await resolveReviewEscalationAgentId(db, companyId, unset)).toBe(defaultAgentId);
    expect(await resolveReviewEscalationAgentId(db, plainCompanyId, unset)).toBeNull();
    // The task's own agent wins; an explicit null opts the task out.
    expect(await resolveReviewEscalationAgentId(db, companyId, override)).toBe(taskAgentId);
    expect(await resolveReviewEscalationAgentId(db, companyId, optedOut)).toBeNull();
    // Progress-guarded reviews keep their owner-only escalation.
    expect(await resolveReviewEscalationAgentId(db, companyId, { ...unset, reviewGuard: { mode: "progress", maxStalledRounds: 2 } as never })).toBeNull();
    expect(await resolveReviewEscalationAgentId(db, companyId, null)).toBeNull();

    // An unavailable default falls back to the human; so does an unavailable task agent, without borrowing the default.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, defaultAgentId));
    expect(await resolveReviewEscalationAgentId(db, companyId, unset)).toBeNull();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, defaultAgentId));
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, taskAgentId));
    expect(await resolveReviewEscalationAgentId(db, companyId, override)).toBeNull();

    // End to end through the transition: the resolved default receives the capped review.
    const reviewerId = randomUUID(), executorId = randomUUID();
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerId }] }] })!;
    const capped = {
      status: "in_review", assigneeAgentId: reviewerId, assigneeUserId: null, responsibleUserId: "board-owner", executionPolicy: policy,
      executionState: { status: "pending", currentStageId: policy.stages[0].id, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId }, returnAssignee: { type: "agent", agentId: executorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2 },
    };
    const decide = async (company: string) => applyIssueExecutionPolicyTransition({
      issue: capped as never, policy, reviewEscalationAgentId: await resolveReviewEscalationAgentId(db, company, policy),
      requestedStatus: "in_progress", requestedAssigneePatch: {}, actor: { agentId: reviewerId }, commentBody: "Round three",
    });
    expect((await decide(companyId)).patch).toMatchObject({ status: "in_review", assigneeAgentId: defaultAgentId, assigneeUserId: null });
    expect((await decide(plainCompanyId)).patch).toMatchObject({ status: "in_review", assigneeAgentId: null, assigneeUserId: "board-owner" });
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
    // A monitor receipt arriving after the review read does not invalidate the
    // decision, and must not be overwritten by that decision's stale monitor.
    await service.update(issueId, { executionState: { ...state, monitor: null } });
    const decision = { ...state, lastDecisionId: randomUUID(), reviewProgress: { ...state.reviewProgress, stalledRounds: 1 } };
    const results = await Promise.allSettled([
      service.update(issueId, { companyGuard: companyId, executionState: decision, expectedReviewSnapshot }),
      service.update(issueId, { companyGuard: companyId, executionState: { ...decision, lastDecisionId: randomUUID() }, expectedReviewSnapshot }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await service.getById(issueId))?.executionState).toHaveProperty("monitor", null);
    const rejection = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.details).toMatchObject({ code: "review_progress_snapshot_changed" });
    // A fresh service instance reads the durable streak/credits; no in-memory counter reset.
    expect((await issueService(db).getById(issueId))?.executionState).toMatchObject({ changesRequestedCount: 7,
      reviewProgress: { stalledRounds: 1, creditedFindingIds: ["F1"], openFindingIds: ["F2"] } });
    await expect(service.update(issueId, { executionState: { ...decision, lastDecisionId: randomUUID() } }))
      .rejects.toMatchObject({ details: { code: "review_progress_snapshot_required" } });
    const current = await service.getById(issueId);
    await service.update(issueId, { executionState: { ...current!.executionState, monitor: null } });
    expect((await service.getById(issueId))?.executionState).toMatchObject({ reviewProgress: { creditedFindingIds: ["F1"], stalledRounds: 1 } });
  });

  it("persists a stall escalation despite a concurrent null monitor receipt", async () => {
    const companyId = randomUUID(), issueId = randomUUID(), reviewer = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Escalation race", issuePrefix: `E${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", membershipRole: "owner", status: "active" });
    const policy = normalizeIssueExecutionPolicy({ reviewGuard: { mode: "progress", maxStalledRounds: 3 },
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer }] }] })!;
    const state = { status: "pending", currentStageId: policy.stages[0]!.id, currentStageIndex: 0,
      currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewer, userId: null },
      returnAssignee: { type: "user", userId: "implementer", agentId: null }, reviewRequest: null,
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2 };
    const [row] = await db.insert(issues).values({ id: issueId, companyId, title: "Escalate once", status: "in_review",
      responsibleUserId: "owner", executionPolicy: policy as unknown as Record<string, unknown>, executionState: state }).returning();
    const transition = applyIssueExecutionPolicyTransition({ issue: row!, policy, previousPolicy: policy,
      requestedStatus: "in_progress", requestedAssigneePatch: {}, actor: { agentId: reviewer }, commentBody: "Still unresolved" });
    expect(transition.patch).toMatchObject({ assigneeUserId: "owner", executionState: { reviewEscalated: true, monitor: null } });
    const service = issueService(db);
    await service.update(issueId, { executionState: { ...state, monitor: null } });
    await service.update(issueId, { ...transition.patch, expectedReviewSnapshot: transition.expectedReviewSnapshot });
    expect((await service.getById(issueId))?.executionState).toMatchObject({ reviewEscalated: true, monitor: null });
  });

  it("validates the post-update escalation owner and permits cancellation if an older row has no owner", async () => {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owner invariants", issuePrefix: `O${companyId.slice(0, 6)}` });
    const policy = normalizeIssueExecutionPolicy({ reviewGuard: { mode: "progress", maxStalledRounds: 3 } })!;
    await db.insert(issues).values({ id: issueId, companyId, title: "No owner initially" });
    const service = issueService(db);
    await service.update(issueId, { executionPolicy: policy as unknown as Record<string, unknown>, responsibleUserId: "owner", allowProgressReviewConfiguration: true });
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
    await expect(service.create(companyId, { title: "No escalation owner", allowProgressReviewConfiguration: true, executionPolicy: policy as unknown as Record<string, unknown> }))
      .rejects.toMatchObject({ details: { code: "review_progress_owner_required" } });
    const created = await service.create(companyId, { title: "Board configured task", allowProgressReviewConfiguration: true, createdByUserId: "owner", executionPolicy: policy as unknown as Record<string, unknown> });
    expect(created.executionPolicy).toMatchObject({ reviewGuard: { mode: "progress", maxStalledRounds: 50 } });
    await expect(service.update(created.id, { actorAgentId: randomUUID(), executionPolicy: null }))
      .rejects.toMatchObject({ details: { code: "review_progress_policy_protected" } });
    expect((await service.getById(created.id))?.executionPolicy).toEqual(created.executionPolicy);
    await expect(service.update(created.id, { executionPolicy: null, actorUserId: "owner" }))
      .rejects.toMatchObject({ details: { code: "review_progress_policy_protected" } });
  });

});
