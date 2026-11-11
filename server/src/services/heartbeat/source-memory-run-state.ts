/** Source snapshot ownership follows the run, not the retry chain. */
export function freshSourceMemoryRetryContext(context: Record<string, unknown>) {
  const { sourceSnapshot: _previousSnapshot, ...fresh } = context;
  return fresh;
}

/** Only a server-owned pending review assignment can bind a review candidate. */
export function sourceReviewCandidateSha(state: {
  status: string; currentStageType: string | null;
  currentParticipant: { agentId?: string | null } | null;
  reviewRequest: { candidateSha?: string } | null;
} | null, agentId: string): string | null {
  if (state?.status !== "pending" || state.currentStageType !== "review" ||
      state.currentParticipant?.agentId !== agentId) return null;
  const sha = state.reviewRequest?.candidateSha;
  return sha && /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}
