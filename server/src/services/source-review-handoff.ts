import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { IssueExecutionState } from "@paperclipai/shared";
import { sourceMemoryRepositoryId, sourceMemoryBindingEnabled, sourceMemoryProjectBindingEnabled } from "./source-memory.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";

import { captureWorkspaceReviewCandidate, sourceReviewCaptureHold, type NativeSourceReviewOwner } from "./workspace-source-inspection.js";

type Task = typeof issues.$inferSelect;
type Capture = NonNullable<IssueExecutionState["sourceReviewCapture"]>;
/** A latent configured gate is exposed to native arbitration, never persisted here. */
export function configuredSourceReviewTransition(task: Task, requestedStatus: string, agentId: string) {
  if (parseIssueExecutionState(task.executionState)?.status === "pending") return null;
  const policy = normalizeIssueExecutionPolicy(task.executionPolicy);
  if (!policy?.stages.some(stage => stage.type === "review") || task.assigneeAgentId !== agentId) return null;
  const transition = applyIssueExecutionPolicyTransition({ issue: task, policy,
    requestedStatus, requestedAssigneePatch: {}, actor: { agentId, userId: null } });
  const state = parseIssueExecutionState(transition.patch.executionState);
  return state?.status === "pending" && state.currentStageType === "review" ? transition.patch : null;
}

/** Generic hook inside the issue's existing status/state transaction. The opt-in
 * only narrows behavior. Capture receipt and event are committed with the stage. */
export async function prepareSourceReviewHandoff(db: Db, input: {
  task: Task; patch: Partial<Task>; agentId?: string | null; runId?: string | null; nativeOwner?: NativeSourceReviewOwner; requestedCandidate?: string | null;
}) {
  const { task, patch } = input;
  if (!process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG || !["in_review", "done"].includes(patch.status ?? "")) return null;
  const [workspace] = task.executionWorkspaceId ? await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, task.companyId), eq(executionWorkspaces.id, task.executionWorkspaceId))) : [];
  if (!await sourceMemoryProjectBindingEnabled(task).catch(() => sourceReviewCaptureHold("configuration_unverifiable"))) return null;
  let nextPatch = patch;
  if (input.nativeOwner && patch.executionState === undefined && input.agentId) {
    const transition = configuredSourceReviewTransition(task, patch.status!, input.agentId);
    if (transition) nextPatch = { ...patch, ...transition };
  }
  const state = parseIssueExecutionState(nextPatch.executionState ?? task.executionState);
  if (state?.status !== "pending" || state.currentStageType !== "review") return null;
  const policy = normalizeIssueExecutionPolicy(nextPatch.executionPolicy ?? task.executionPolicy);
  const stage = policy?.stages.find(stage => stage.id === state.currentStageId && stage.type === "review");
  const participant = state.currentParticipant;
  if (!stage || participant?.type !== "agent" || !participant.agentId || !stage.participants.some(p => p.agentId === participant.agentId)) {
    sourceReviewCaptureHold("stage_participant_mismatch");
  }
  if (!workspace?.repoUrl || !await sourceMemoryBindingEnabled({ companyId: task.companyId, projectId: task.projectId,
    repoUrl: workspace.repoUrl }).catch(() => sourceReviewCaptureHold("configuration_unverifiable"))) sourceReviewCaptureHold("workspace_unbound");
  const constraint = input.nativeOwner ? input.requestedCandidate ?? null
    : input.requestedCandidate === undefined ? state.reviewRequest?.candidateSha : input.requestedCandidate;
  const previous = parseIssueExecutionState(task.executionState);
  const receipt = previous?.sourceReviewCapture;
  // Only the persisted receipt may deduplicate. An input receipt is never authority.
  const sameReview = receipt?.stageId === stage.id && receipt.participantAgentId === participant.agentId;
  const advancingReview = previous?.currentStageType === "review" && previous.currentStageId === receipt?.stageId &&
    previous.currentParticipant?.agentId === receipt?.participantAgentId &&
    typeof previous.currentStageIndex === "number" && state.currentStageIndex === previous.currentStageIndex + 1 &&
    state.completedStageIds.includes(previous.currentStageId!) && state.lastDecisionOutcome === "approved";
  if (previous?.status === "pending" && receipt && (sameReview || advancingReview) && receipt.companyId === task.companyId && receipt.issueId === task.id &&
      receipt.workspaceId === task.executionWorkspaceId && receipt.bindingRevision === task.workspaceBindingRevision &&
      receipt.projectId === task.projectId && receipt.repositoryId === sourceMemoryRepositoryId(workspace!.repoUrl!)) {
    if (constraint && constraint !== receipt.candidateSha) sourceReviewCaptureHold("explicit_candidate_mismatch");
    const carried = { ...receipt, stageId: stage.id, participantAgentId: participant.agentId };
    return { patch: { ...nextPatch, executionState: { ...state, sourceReviewCapture: carried,
      reviewRequest: { instructions: state.reviewRequest?.instructions ?? "Review the frozen source candidate.", candidateSha: receipt.candidateSha } } }, event: null };
  }
  if (previous?.status === "pending" && previous.currentStageType === "review") sourceReviewCaptureHold("frozen_review_receipt_mismatch");
  if (!input.agentId || !input.runId) sourceReviewCaptureHold("writer_missing");
  const captured = await captureWorkspaceReviewCandidate(db, task, { agentId: input.agentId, runId: input.runId, native: input.nativeOwner });
  if (constraint && constraint !== captured.candidateSha) sourceReviewCaptureHold("explicit_candidate_mismatch");
  const eventKey = createHash("sha256").update(JSON.stringify([task.id, stage.id, captured.candidateSha])).digest("hex");
  const capture: Capture = { schema: 1, companyId: task.companyId, issueId: task.id, ...captured,
    stageId: stage.id, participantAgentId: participant.agentId, eventKey };
  return { patch: { ...nextPatch, executionState: { ...state, sourceReviewCapture: capture,
    reviewRequest: { instructions: state.reviewRequest?.instructions ?? "Review the frozen source candidate.", candidateSha: captured.candidateSha } } }, event: capture };
}

/** Native arbitration advertises a latent gate; only the locked handoff may
 * authorize/capture/persist it. This read never grants execution authority. */
export async function hasConfiguredSourceReviewGate(db: Db, input: { companyId: string; issueId: string; runId: string }) {
  if (!process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG) return false;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!task || !run || run.runtimeMode !== "native" || run.nativeIssueId !== task.id || task.executionRunId !== run.id ||
      task.assigneeAgentId !== run.agentId) return false;
  if (!await sourceMemoryProjectBindingEnabled(task).catch(() => sourceReviewCaptureHold("configuration_unverifiable"))) return false;
  return Boolean(configuredSourceReviewTransition(task, "done", run.agentId));
}
