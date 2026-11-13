/** Source snapshot ownership follows the run, not the retry chain. */
export function freshSourceMemoryRetryContext(context: Record<string, unknown>) {
  const { sourceSnapshot: _previousSnapshot, sourceReferenceUsage: _previousReferenceUsage,
    paperclipSourceReferenceUsage: _previousPromptUsage, ...fresh } = context;
  return fresh;
}

/** Only a server-owned pending review assignment can bind a review candidate. */
export function sourceReviewCandidateSha(state: {
  status: string; currentStageType: string | null;
  currentParticipant: { agentId?: string | null } | null;
  currentStageId?: string | null;
  sourceReviewCapture?: { schema: number; companyId: string; issueId: string; workspaceId: string;
    bindingRevision: number; stageId: string; participantAgentId: string; candidateSha: string } | null;
  reviewRequest: { candidateSha?: string } | null;
} | null, agentId: string, scope?: {
  companyId: string; issueId: string; workspaceId: string | null; bindingRevision: number;
}): string | null {
  if (!state || !sourceReviewAssignedTo(state, agentId)) return null;
  const sha = state.reviewRequest?.candidateSha;
  if (scope) {
    const receipt = state.sourceReviewCapture;
    if (!receipt || receipt.schema !== 1 || receipt.companyId !== scope.companyId || receipt.issueId !== scope.issueId ||
        receipt.workspaceId !== scope.workspaceId || receipt.bindingRevision !== scope.bindingRevision ||
        receipt.stageId !== state.currentStageId || receipt.participantAgentId !== agentId || receipt.candidateSha !== sha) return null;
  }
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

/** Attribution grants no authority; admission still owns task/workspace access.
 * Native and direct-adapter runs need not have a legacy phase-routing profile.
 */
export function sourceMemoryRunIdentity(input: {
  route: { phase: "planning" | "implementation" | "review"; provider: string; model: string } | null;
  workMode: string | null;
  reviewAssigned: boolean;
  recovering: boolean;
  provider: string | null;
  model: string | null;
}): { phase: "planning" | "implementation" | "review" | null; provider: string | null; model: string | null } {
  const phase = input.workMode !== "planning" && input.workMode !== "standard" ? null
    : input.reviewAssigned ? "review" : input.route?.phase ?? (input.workMode === "planning" ? "planning" : "implementation");
  // Recovery cannot attribute an unverified old snapshot to edited live config.
  // Retain the review obligation so missing current evidence still fails closed.
  if (input.recovering) return { phase, provider: null, model: null };
  return { phase, provider: input.route?.provider ?? input.provider, model: input.route?.model ?? input.model };
}

/** Missing capture must hold an assigned reviewer, never downgrade its phase. */
export function sourceReviewAssignedTo(state: {
  status: string; currentStageType: string | null; currentParticipant: { agentId?: string | null } | null;
} | null, agentId: string): boolean {
  return state?.status === "pending" && state.currentStageType === "review" && state.currentParticipant?.agentId === agentId;
}
