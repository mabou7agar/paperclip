/** Source snapshot ownership follows the run, not the retry chain. */
export function freshSourceMemoryRetryContext(context: Record<string, unknown>) {
  const { sourceSnapshot: _previousSnapshot, ...fresh } = context;
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
  if (state?.status !== "pending" || state.currentStageType !== "review" ||
      state.currentParticipant?.agentId !== agentId) return null;
  const sha = state.reviewRequest?.candidateSha;
  if (scope) {
    const receipt = state.sourceReviewCapture;
    if (!receipt || receipt.schema !== 1 || receipt.companyId !== scope.companyId || receipt.issueId !== scope.issueId ||
        receipt.workspaceId !== scope.workspaceId || receipt.bindingRevision !== scope.bindingRevision ||
        receipt.stageId !== state.currentStageId || receipt.participantAgentId !== agentId || receipt.candidateSha !== sha) return null;
  }
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}
