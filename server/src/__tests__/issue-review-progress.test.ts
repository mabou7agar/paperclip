import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { updateIssueSchema, type IssueExecutionPolicy, type IssueExecutionState, type IssueReviewAssessment } from "@paperclipai/shared";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../services/issue-execution-policy.js";
import { buildExecutionPolicy } from "../../../ui/src/lib/issue-execution-policy.js";

const worker = randomUUID(), reviewer = randomUUID(), stage = randomUUID(), participant = randomUUID();
const policy: IssueExecutionPolicy = {
  mode: "normal", commentRequired: true, reviewGuard: { mode: "progress", maxStalledRounds: 3 },
  stages: [{ id: stage, type: "review", approvalsNeeded: 1, participants: [{ id: participant, type: "agent", agentId: reviewer }] }],
};
function initial(): IssueExecutionState {
  return { status: "pending", currentStageId: stage, currentStageIndex: 0, currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewer }, returnAssignee: { type: "agent", agentId: worker },
    reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
}
function assessment(state: IssueExecutionState, changes: Partial<IssueReviewAssessment> = {}): IssueReviewAssessment {
  return { baselineDecisionId: state.lastDecisionId, candidateRef: "candidate-A", evidenceRefs: ["sha256:evidence-A"],
    openFindingIds: [], requiredGateIds: [], resolvedFindingIds: [], passedGateIds: [], ...changes };
}
function decide(state: IssueExecutionState, reviewAssessment?: IssueReviewAssessment, options: {
  actor?: { agentId?: string; userId?: string }; selectedPolicy?: IssueExecutionPolicy; status?: string;
} = {}) {
  return applyIssueExecutionPolicyTransition({ issue: { status: "in_review", assigneeAgentId: reviewer,
    responsibleUserId: "owner", executionState: state, executionPolicy: policy },
    previousPolicy: policy, policy: options.selectedPolicy ?? policy, requestedStatus: options.status ?? "in_progress",
    requestedAssigneePatch: {}, actor: options.actor ?? { agentId: reviewer },
    commentBody: "Reviewed the exact candidate and cited evidence", reviewAssessment });
}
function next(state: IssueExecutionState, a?: IssueReviewAssessment) {
  const result = decide(state, a);
  const decidedState = parseIssueExecutionState({ ...(result.patch.executionState as object), lastDecisionId: randomUUID() })!;
  if (result.patch.status !== "in_progress") return { result, state: decidedState };
  const resubmitted = applyIssueExecutionPolicyTransition({
    issue: { status: "in_progress", assigneeAgentId: worker, responsibleUserId: "owner", executionPolicy: policy, executionState: decidedState },
    policy, previousPolicy: policy, requestedStatus: "done", requestedAssigneePatch: {}, actor: { agentId: worker },
  });
  expect(resubmitted.patch.assigneeAgentId).toBe(reviewer);
  return { result, state: parseIssueExecutionState(resubmitted.patch.executionState)! };
}

describe("verified-progress review governance", () => {
  it("permits more than three total rounds only for previously registered findings or required gates", () => {
    let state = initial();
    state = next(state, assessment(state, { openFindingIds: ["F1", "F2", "F3"], requiredGateIds: ["security"] })).state;
    for (const [index, id] of ["F1", "F2", "F3"].entries()) {
      const r = next(state, assessment(state, { candidateRef: `candidate-${index}`, resolvedFindingIds: [id] }));
      expect(r.result.patch.assigneeAgentId).toBe(worker);
      expect(r.result.decision?.body).toContain('"reviewer":{"type":"agent"');
      state = r.state;
    }
    const gate = next(state, assessment(state, { candidateRef: "candidate-2", evidenceRefs: ["security-receipt"], passedGateIds: ["security"] }));
    expect(gate.result.patch.assigneeAgentId).toBe(worker);
    expect(gate.state).toMatchObject({ changesRequestedCount: 5, reviewProgress: { stalledRounds: 0, creditedFindingIds: ["F1", "F2", "F3"], creditedGateIds: ["security"] } });
  });

  it("new commits, comments, evidence hashes or omitted findings do not count as progress", () => {
    let state = initial();
    for (let i = 0; i < 3; i++) {
      const r = next(state, assessment(state, { candidateRef: `commit-${i}`, evidenceRefs: [`new-log-${i}`] }));
      state = r.state;
      if (i < 2) expect(r.result.patch.assigneeAgentId).toBe(worker);
      else expect(r.result.patch.assigneeUserId).toBe("owner");
    }
    expect(state.reviewProgress?.stalledRounds).toBe(3);
  });

  it("rejects unknown, already credited, reopened, stale and unchanged-evidence assertions", () => {
    let state = next(initial(), assessment(initial(), { openFindingIds: ["F1", "F2"] })).state;
    expect(() => decide(state, assessment(state, { resolvedFindingIds: ["invented"] }))).toThrow(/previously recorded/);
    expect(() => decide(state, assessment(state, { baselineDecisionId: randomUUID() }))).toThrow(/current decision/);
    expect(() => decide(state, assessment(state, { resolvedFindingIds: ["F1"] }))).toThrow(/new candidate or validation evidence/);
    state = next(state, assessment(state, { candidateRef: "candidate-B", resolvedFindingIds: ["F1"] })).state;
    expect(() => decide(state, assessment(state, { candidateRef: "candidate-C", resolvedFindingIds: ["F1"] }))).toThrow(/previously recorded/);
    expect(() => decide(state, assessment(state, { openFindingIds: ["F1"] }))).toThrow(/reopened/);
    state = next(state, assessment(state)).state;
    expect(state.reviewProgress?.openFindingIds).toEqual(["F2"]);
  });

  it("requires the active reviewer and prevents worker governance edits or standalone attestations", () => {
    const state = initial();
    expect(() => decide(state, assessment(state), { actor: { agentId: worker } })).toThrow(/current reviewer's/);
    expect(() => decide(state, assessment(state), { status: "in_review" })).toThrow(/current reviewer's/);
    expect(() => decide(state, undefined, { selectedPolicy: { ...policy, reviewGuard: { mode: "progress", maxStalledRounds: 10 } } })).toThrow(/Only the board/);
    expect(() => decide(state, undefined, { selectedPolicy: { ...policy, reviewGuard: undefined } })).toThrow(/Only the board/);
    expect(() => decide(state, undefined, { selectedPolicy: { ...policy, stages: [{ ...policy.stages[0], id: randomUUID() }] } })).toThrow(/Only the board/);
  });

  it("keeps explicit hard bounds even when the review verifies progress", () => {
    const state = next(initial(), assessment(initial(), { openFindingIds: ["F1"] })).state;
    const strict = { ...policy, maxReviewRounds: 1 };
    const result = applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", executionState: state, executionPolicy: strict },
      policy: strict, previousPolicy: strict, requestedStatus: "in_progress", requestedAssigneePatch: {}, actor: { agentId: reviewer },
      commentBody: "Verified F1 fix", reviewAssessment: assessment(state, { candidateRef: "candidate-B", resolvedFindingIds: ["F1"] }) });
    expect(result.patch.assigneeUserId).toBe("owner");
    expect(result.patch.executionState).toMatchObject({ reviewEscalated: true, reviewProgress: { stalledRounds: 0 } });
  });

  it("keeps existing attempts and a sticky owner hold when configuration changes", () => {
    const state = { ...initial(), changesRequestedCount: 2 };
    const result = next(state);
    expect(result.result.patch.assigneeUserId).toBe("owner");
    const held = result.result.patch.executionState as IssueExecutionState;
    const raised = { ...policy, reviewGuard: { mode: "progress" as const, maxStalledRounds: 10 } };
    const kept = applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", assigneeUserId: "owner", executionState: held, executionPolicy: policy },
      policy: raised, previousPolicy: policy, requestedAssigneePatch: {}, actor: { userId: "another-owner" } });
    expect(kept.patch).toEqual({});
    expect(() => applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", assigneeUserId: "owner", executionState: held, executionPolicy: raised },
      policy: raised, previousPolicy: raised, requestedStatus: "in_progress", requestedAssigneePatch: {}, actor: { agentId: worker } })).toThrow(/escalated reviewer/);
    const released = applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", assigneeUserId: "owner", executionState: held, executionPolicy: raised },
      policy: raised, previousPolicy: raised, requestedStatus: "in_progress", requestedAssigneePatch: {}, actor: { userId: "owner" }, commentBody: "One explicit human continuation" });
    expect(released.patch.executionState).toMatchObject({ reviewEscalated: false, changesRequestedCount: 0, reviewProgress: { stalledRounds: 0 } });
  });

  it("does not mistake five useful rounds for an owner hold after replacing a human participant", () => {
    const oldPolicy: IssueExecutionPolicy = { ...policy, stages: [{ ...policy.stages[0], participants: [{ id: participant, type: "user", userId: "old-reviewer" }] }] };
    const replacement: IssueExecutionPolicy = { ...oldPolicy, stages: [{ ...oldPolicy.stages[0], participants: [{ id: randomUUID(), type: "user", userId: "new-reviewer" }] }] };
    const state = { ...initial(), currentParticipant: { type: "user" as const, userId: "old-reviewer" }, changesRequestedCount: 5,
      reviewProgress: { stageId: stage, stalledRounds: 0, openFindingIds: [], requiredGateIds: [], creditedFindingIds: ["F1"], creditedGateIds: [], lastAssessment: null } };
    const result = applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", assigneeUserId: "old-reviewer", executionPolicy: oldPolicy, executionState: state },
      policy: replacement, previousPolicy: oldPolicy, requestedAssigneePatch: {}, actor: { userId: "owner" } });
    expect(result.patch.assigneeUserId).toBe("new-reviewer");
    expect(result.patch.executionState).not.toHaveProperty("reviewEscalated");
  });

  it("preserves legacy cap-raising behavior without progress opt-in", () => {
    const oldPolicy = { ...policy, reviewGuard: undefined };
    const raised = { ...oldPolicy, maxReviewRounds: 5 };
    const state = { ...initial(), currentParticipant: { type: "user" as const, userId: "owner" }, changesRequestedCount: 3 };
    const result = applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", assigneeUserId: "owner", executionPolicy: oldPolicy, executionState: state },
      policy: raised, previousPolicy: oldPolicy, requestedAssigneePatch: {}, actor: { userId: "owner-configurer" } });
    expect(result.patch.assigneeAgentId).toBe(reviewer);
  });

  it("owner approval clears a hold before the next human stage and permits its participant replacement", () => {
    const secondId = randomUUID();
    const chain: IssueExecutionPolicy = { ...policy, stages: [...policy.stages, { id: secondId, type: "approval", approvalsNeeded: 1,
      participants: [{ id: randomUUID(), type: "user", userId: "second-reviewer" }] }] };
    const held = { ...initial(), reviewEscalated: true, currentParticipant: { type: "user" as const, userId: "owner" }, changesRequestedCount: 3 };
    const approved = applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", assigneeUserId: "owner", executionPolicy: chain, executionState: held },
      policy: chain, previousPolicy: chain, requestedStatus: "done", requestedAssigneePatch: {}, actor: { userId: "owner" }, commentBody: "Owner approves this stage" });
    expect(approved.patch.assigneeUserId).toBe("second-reviewer");
    expect(approved.patch.executionState).not.toHaveProperty("reviewEscalated");
    const replacement = { ...chain, stages: [chain.stages[0], { ...chain.stages[1], participants: [{ id: randomUUID(), type: "user" as const, userId: "replacement" }] }] };
    const replaced = applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", assigneeUserId: "second-reviewer", executionPolicy: chain, executionState: approved.patch.executionState as IssueExecutionState },
      policy: replacement, previousPolicy: chain, requestedAssigneePatch: {}, actor: { userId: "owner" } });
    expect(replaced.patch.assigneeUserId).toBe("replacement");
  });

  it("fails closed without an escalation owner and forbids clearing a held stage through policy edits", () => {
    expect(() => applyIssueExecutionPolicyTransition({ issue: { status: "in_review", executionPolicy: policy, executionState: initial() },
      policy, previousPolicy: policy, requestedStatus: "in_progress", requestedAssigneePatch: {}, actor: { agentId: reviewer }, commentBody: "Review" }))
      .toThrow(/responsible human/);
    const held = { ...initial(), reviewEscalated: true, currentParticipant: { type: "user" as const, userId: "owner" } };
    expect(() => applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", executionPolicy: policy, executionState: held },
      policy: null, previousPolicy: policy, requestedAssigneePatch: {}, actor: { userId: "owner" } })).toThrow(/owner review hold/);
  });

  it("keeps existing fixed-limit behavior absent opt-in and retains guard config through editor/monitor cleanup", () => {
    const original = { ...policy, reviewGuard: undefined };
    let state = initial();
    for (let i = 0; i < 3; i++) {
      const result = applyIssueExecutionPolicyTransition({ issue: { status: "in_review", responsibleUserId: "owner", executionState: state },
        policy: original, previousPolicy: original, requestedStatus: "in_progress", requestedAssigneePatch: {}, actor: { agentId: reviewer }, commentBody: "Same finding" });
      state = { ...(result.patch.executionState as IssueExecutionState), status: "pending", lastDecisionId: randomUUID() };
      if (i === 2) expect(result.patch.assigneeUserId).toBe("owner");
    }
    const edited = buildExecutionPolicy({ existingPolicy: policy, reviewerValues: [], approverValues: [] });
    expect(normalizeIssueExecutionPolicy(edited)?.reviewGuard).toEqual(policy.reviewGuard);
    expect(updateIssueSchema.safeParse({ status: "in_progress", comment: "Verified", reviewAssessment: assessment(initial()) }).success).toBe(true);
    expect(updateIssueSchema.safeParse({ reviewAssessment: { ...assessment(initial()), resolvedFindingIds: ["F1", "F1"] } }).success).toBe(false);
    const oversized = { ...assessment(initial()), evidenceRefs: Array.from({ length: 20 }, (_, i) => `${i}${"汉".repeat(499)}`) };
    expect(updateIssueSchema.safeParse({ reviewAssessment: oversized }).success).toBe(false);
  });
});
