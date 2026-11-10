import { isDeepStrictEqual } from "node:util";
import type { IssueExecutionPolicy, IssueExecutionState, IssueReviewAssessment, IssueReviewProgressState } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { issueExecutionStateSchema } from "@paperclipai/shared";

/** Pure reviewer-attestation accounting; never executes validation or wakes work. */
export function assessReviewProgress(input: {
  state: IssueExecutionState;
  stageId: string;
  assessment?: IssueReviewAssessment;
  humanDecision: boolean;
}): IssueReviewProgressState {
  const previous = input.state.reviewProgress?.stageId === input.stageId ? input.state.reviewProgress : null;
  const assessment = input.assessment;
  const priorStalls = previous?.stalledRounds ?? input.state.changesRequestedCount ?? 0;
  const result: IssueReviewProgressState = previous ? { ...previous } : {
    stageId: input.stageId, stalledRounds: priorStalls, openFindingIds: [], requiredGateIds: [],
    creditedFindingIds: [], creditedGateIds: [], lastAssessment: null,
  };
  let verifiedProgress = false;
  if (assessment) {
    if (assessment.baselineDecisionId !== input.state.lastDecisionId) {
      throw unprocessable("Review assessment must reference the current decision", { code: "review_progress_stale_baseline" });
    }
    const resolved = assessment.resolvedFindingIds;
    const passed = assessment.passedGateIds;
    if (resolved.some(id => !result.openFindingIds.includes(id) || result.creditedFindingIds.includes(id)) ||
        passed.some(id => !result.requiredGateIds.includes(id) || result.creditedGateIds.includes(id))) {
      throw unprocessable("Progress must resolve a previously recorded finding or required gate exactly once", { code: "review_progress_unverified_reference" });
    }
    if (assessment.openFindingIds.some(id => resolved.includes(id) || result.creditedFindingIds.includes(id)) ||
        assessment.requiredGateIds.some(id => passed.includes(id) || result.creditedGateIds.includes(id))) {
      throw unprocessable("A resolved finding or passed gate cannot be reopened under the same identifier", { code: "review_progress_reused_reference" });
    }
    verifiedProgress = resolved.length + passed.length > 0;
    if (verifiedProgress && previous?.lastAssessment &&
        assessment.candidateRef === previous.lastAssessment.candidateRef &&
        assessment.evidenceRefs.every(ref => previous.lastAssessment!.evidenceRefs.includes(ref))) {
      throw unprocessable("Verified progress requires new candidate or validation evidence", { code: "review_progress_unchanged_evidence" });
    }
    result.creditedFindingIds = [...result.creditedFindingIds, ...resolved];
    result.creditedGateIds = [...result.creditedGateIds, ...passed];
    // Omitting an unresolved item never resolves it or earns credit.
    result.openFindingIds = [...new Set([...result.openFindingIds.filter(id => !resolved.includes(id)), ...assessment.openFindingIds])];
    result.requiredGateIds = [...new Set([...result.requiredGateIds.filter(id => !passed.includes(id)), ...assessment.requiredGateIds])];
    if ([result.creditedFindingIds, result.creditedGateIds, result.openFindingIds, result.requiredGateIds].some(ids => ids.length > 200)) {
      throw unprocessable("Review progress history is full; ask the owner to re-scope without resetting history", { code: "review_progress_history_full" });
    }
    result.lastAssessment = assessment;
  }
  result.stalledRounds = input.humanDecision || verifiedProgress ? 0 : priorStalls + 1;
  return result;
}

/** Used by every create producer before workspaces or task rows are allocated. */
export function assertCanCreateProgressReview(policy: IssueExecutionPolicy | Record<string, unknown> | null | undefined, actorAgentId?: string | null, allowConfiguration = false) {
  if (policy?.reviewGuard && (!allowConfiguration || actorAgentId)) {
    throw unprocessable("Only the board may configure progress review governance", { code: "review_progress_policy_protected" });
  }
}

/** Validate the effective persisted attribution, not caller-supplied or stale ownership. */
export function assertReviewProgressOwner(input: {
  policy: IssueExecutionPolicy | Record<string, unknown> | null | undefined;
  responsibleUserId?: string | null; createdByUserId?: string | null; status?: string;
}) {
  if (input.status !== "cancelled" && input.policy?.reviewGuard &&
      !input.responsibleUserId?.trim() && !input.createdByUserId?.trim()) {
    throw unprocessable("Progress-enabled reviews require a responsible human or human creator for escalation", { code: "review_progress_owner_required" });
  }
}

export function assertCanChangeProgressReview(input: {
  before: IssueExecutionPolicy | null; after: IssueExecutionPolicy | null; actorAgentId?: string | null; allowConfiguration?: boolean;
}) {
  if (!(input.before?.reviewGuard || input.after?.reviewGuard)) return;
  const governance = (policy: IssueExecutionPolicy | null) => ({ guard: policy?.reviewGuard, max: policy?.maxReviewRounds, stages: policy?.stages });
  if (!isDeepStrictEqual(governance(input.before), governance(input.after)) && (!input.allowConfiguration || input.actorAgentId)) {
    throw unprocessable("Only the board may change progress review governance", { code: "review_progress_policy_protected" });
  }
}

export interface ReviewProgressSnapshot {
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionPolicy: Record<string, unknown> | null;
  executionState: Record<string, unknown> | null;
  responsibleUserId?: string | null;
  createdByUserId?: string | null;
}

/** Any review-state producer must fence changes; monitor-only writes can retain current review state. */
export function assertReviewProgressStateWrite(input: {
  enabled: boolean; before: unknown; after: unknown; fenced: boolean;
}) {
  if (!input.enabled || input.fenced) return;
  const reviewFields = (state: unknown) => {
    if (state == null) return null;
    const parsed = issueExecutionStateSchema.safeParse(state);
    if (!parsed.success) throw conflict("Read the current review before changing its state", { code: "review_progress_snapshot_required" });
    const { monitor: _monitor, ...fields } = parsed.data;
    return fields;
  };
  if (!isDeepStrictEqual(reviewFields(input.before), reviewFields(input.after))) {
    throw conflict("Review state changes require their original snapshot", { code: "review_progress_snapshot_required" });
  }
}

/** Preserve unsupported saved review state rather than restarting its counters. */
export function assertReviewProgressStateShape(enabled: boolean, state: unknown, status?: string) {
  if (enabled && status !== "cancelled" && state != null && !issueExecutionStateSchema.safeParse(state).success) {
    throw unprocessable("Saved progress review state is unsupported; preserve it and ask the owner to re-scope", { code: "review_progress_state_invalid" });
  }
}
