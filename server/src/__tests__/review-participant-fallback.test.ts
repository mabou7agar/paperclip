import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues } from "@paperclipai/db";
import {
  applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, NO_ELIGIBLE_STAGE_PARTICIPANT_CODE, selectReviewFallbackParticipant,
} from "../services/issue-execution-policy.ts";
import { applyIssueExecutionPolicyTransitionWithReviewerFallback } from "../services/review-escalation-agent.ts";
import { monitoringService, settleMonitoringOwnerNudges } from "../services/monitoring.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const coderAgentId = "11111111-1111-4111-8111-111111111111";
const qaAgentId = "22222222-2222-4222-8222-222222222222";
const ctoAgentId = "33333333-3333-4333-8333-333333333333";
const agent = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });

// The author is the only reviewer configured: nobody else can review its work.
const soloPolicy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: coderAgentId }] }] })!;
// QA reviews first; the second review stage names only the author.
const twoStagePolicy = normalizeIssueExecutionPolicy({ stages: [
  { type: "review", participants: [{ type: "agent", agentId: qaAgentId }] },
  { type: "review", participants: [{ type: "agent", agentId: coderAgentId }] },
] })!;

const submit = (fallbackReviewerAgentId?: string | null) => applyIssueExecutionPolicyTransition({
  issue: { status: "in_progress", assigneeAgentId: coderAgentId, assigneeUserId: null, executionPolicy: soloPolicy, executionState: null },
  policy: soloPolicy, requestedStatus: "in_review", requestedAssigneePatch: {}, actor: { agentId: coderAgentId },
  commentBody: "Ready for review", fallbackReviewerAgentId,
});

function firstStagePending() {
  return {
    status: "in_review", assigneeAgentId: qaAgentId, assigneeUserId: null, executionPolicy: twoStagePolicy,
    executionState: {
      status: "pending", currentStageId: twoStagePolicy.stages[0]!.id, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: agent(qaAgentId), returnAssignee: agent(coderAgentId), completedStageIds: [],
      lastDecisionId: null, lastDecisionOutcome: null,
    },
  };
}
const approveFirstStage = (fallbackReviewerAgentId?: string | null) => applyIssueExecutionPolicyTransition({
  issue: firstStagePending(), policy: twoStagePolicy, requestedStatus: "done", requestedAssigneePatch: {},
  actor: { agentId: qaAgentId }, commentBody: "Approved", fallbackReviewerAgentId,
});

describe("selectReviewFallbackParticipant", () => {
  const stage = { type: "review" as const };
  it("returns the fallback agent only when it is neither the author nor the actor, and only for review stages", () => {
    expect(selectReviewFallbackParticipant({ stage, fallbackAgentId: ctoAgentId, exclude: [agent(coderAgentId), agent(qaAgentId)] }))
      .toEqual(agent(ctoAgentId));
    expect(selectReviewFallbackParticipant({ stage, fallbackAgentId: null, exclude: [] })).toBeNull();
    expect(selectReviewFallbackParticipant({ stage, fallbackAgentId: " ", exclude: [] })).toBeNull();
    expect(selectReviewFallbackParticipant({ stage, fallbackAgentId: coderAgentId, exclude: [agent(coderAgentId)] })).toBeNull();
    expect(selectReviewFallbackParticipant({ stage, fallbackAgentId: qaAgentId, exclude: [agent(coderAgentId), agent(qaAgentId)] })).toBeNull();
    expect(selectReviewFallbackParticipant({ stage: { type: "approval" }, fallbackAgentId: ctoAgentId, exclude: [] })).toBeNull();
  });
});

describe("review stage with no eligible participant", () => {
  it("refuses with 422 and a code when no fallback reviewer is given (the OSA-586 refusal)", () => {
    expect(() => submit()).toThrow("No eligible review participant is configured for this issue");
    try { approveFirstStage(); } catch (error) {
      expect(error).toMatchObject({ status: 422, details: { code: NO_ELIGIBLE_STAGE_PARTICIPANT_CODE, stageId: twoStagePolicy.stages[1]!.id } });
    }
    expect(() => approveFirstStage()).toThrow("No eligible review participant is configured for this issue");
  });

  it("hands the first submission to the fallback reviewer, marked as a fallback", () => {
    const result = submit(ctoAgentId);
    expect(result.patch).toMatchObject({ status: "in_review", assigneeAgentId: ctoAgentId, assigneeUserId: null });
    expect(result.patch.executionState).toMatchObject({ status: "pending", currentParticipant: agent(ctoAgentId),
      returnAssignee: agent(coderAgentId), reviewFallbackParticipant: true });
    expect(result.reviewerFallback).toEqual({ stageId: soloPolicy.stages[0]!.id, agentId: ctoAgentId });
  });

  it("lets the reviewer's approval advance to the fallback reviewer on the next stage", () => {
    const result = approveFirstStage(ctoAgentId);
    expect(result.decision).toMatchObject({ outcome: "approved", stageId: twoStagePolicy.stages[0]!.id });
    expect(result.patch).toMatchObject({ status: "in_review", assigneeAgentId: ctoAgentId });
    expect(result.patch.executionState).toMatchObject({ currentStageId: twoStagePolicy.stages[1]!.id,
      currentParticipant: agent(ctoAgentId), completedStageIds: [twoStagePolicy.stages[0]!.id], reviewFallbackParticipant: true });
    expect(result.reviewerFallback).toEqual({ stageId: twoStagePolicy.stages[1]!.id, agentId: ctoAgentId });
  });

  it("never falls back to the author or to the approving reviewer itself", () => {
    expect(() => submit(coderAgentId)).toThrow("No eligible review participant");
    expect(() => approveFirstStage(qaAgentId)).toThrow("No eligible review participant");
    expect(() => approveFirstStage(coderAgentId)).toThrow("No eligible review participant");
  });

  it("keeps the fallback reviewer's hold through unrelated updates, and lets it approve", () => {
    const pending = { status: "in_review", assigneeAgentId: ctoAgentId, assigneeUserId: null, executionPolicy: soloPolicy,
      executionState: submit(ctoAgentId).patch.executionState as Record<string, unknown> };
    // The author touching the task does not dissolve the review back to itself.
    const unrelated = applyIssueExecutionPolicyTransition({ issue: pending, policy: soloPolicy, requestedAssigneePatch: {},
      actor: { agentId: coderAgentId } });
    expect(unrelated.patch.executionState).toBeUndefined();
    expect(unrelated.patch.status).toBeUndefined();
    const approved = applyIssueExecutionPolicyTransition({ issue: pending, policy: soloPolicy, requestedStatus: "done",
      requestedAssigneePatch: {}, actor: { agentId: ctoAgentId }, commentBody: "Reviewed as fallback; approved" });
    expect(approved.decision).toMatchObject({ outcome: "approved" });
    expect(approved.patch.executionState).toMatchObject({ status: "completed" });
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer fallback with the company default escalation agent", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("review-fallback-"); db = createDb(database.connectionString); }, 90000);
  afterEach(async () => { await settleMonitoringOwnerNudges(); await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await database?.cleanup(); });

  async function seed(escalationAgentId: string | null) {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values([coderAgentId, qaAgentId, ctoAgentId].map(id => ({ id, companyId, name: id.slice(0, 4),
      role: id === ctoAgentId ? "cto" : "engineer", status: "idle", adapterType: "process", adapterConfig: {} })));
    await db.update(companies).set({ defaultReviewEscalationAgentId: escalationAgentId }).where(eq(companies.id, companyId));
    await db.insert(issues).values({ id: issueId, companyId, title: "OSA-586", status: "in_review", assigneeAgentId: qaAgentId,
      executionPolicy: twoStagePolicy, executionState: firstStagePending().executionState });
    await monitoringService(db).savePolicy(companyId, { mode: "alert_only" }, "owner");
    return { companyId, issueId };
  }
  const input = () => ({ issue: firstStagePending(), policy: twoStagePolicy, requestedStatus: "done", requestedAssigneePatch: {},
    actor: { agentId: qaAgentId }, commentBody: "Approved" });

  it("applies the company default review escalation agent when the plain transition refuses", async () => {
    const f = await seed(ctoAgentId);
    const result = await applyIssueExecutionPolicyTransitionWithReviewerFallback(db, { id: f.issueId, companyId: f.companyId }, input());
    expect(result.reviewerFallback).toEqual({ stageId: twoStagePolicy.stages[1]!.id, agentId: ctoAgentId });
    expect(result.patch).toMatchObject({ assigneeAgentId: ctoAgentId });
  });

  it("keeps the 422 and records an alert when no eligible fallback exists", async () => {
    // The configured escalation agent is the author under review: not eligible.
    const f = await seed(coderAgentId);
    await expect(applyIssueExecutionPolicyTransitionWithReviewerFallback(db, { id: f.issueId, companyId: f.companyId }, input()))
      .rejects.toMatchObject({ status: 422 });
    const alerts = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "monitoring.alert"), sql`${activityLog.details} ->> 'kind' = 'review_without_eligible_participant'`));
    expect(alerts).toHaveLength(1);
    // The escalation agent is the author, so the CTO is woken instead.
    expect(alerts[0]!.details).toMatchObject({ details: { stageId: twoStagePolicy.stages[1]!.id }, nudgeAgentId: ctoAgentId });
  });
});
