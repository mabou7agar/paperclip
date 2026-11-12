import { executionWorkspaces, heartbeatRuns, nativeRunFinalizations, type issues } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { SourceReviewCaptureUnavailable } from "./source-review-capture-error.js";
import { authorizeSourceCitation } from "./source-citation-authorization.js";
import { prepareSourceMemory } from "./source-memory.js";
import { workspaceRuntimeLeaseHeldByRun } from "./workspace-runtime-leases.js";
import type { Db } from "@paperclipai/db";
import type { WorkspaceSourceInspection } from "@paperclipai/shared";
import { inspectWorkspaceRecoverySource, WorkspaceSourceInspectionLimit,
  type WorkspaceRecoverySourceIdentity } from "./workspace-recovery-source.js";
import { SystemRecoveryFailure, workspaceSourceVerificationFailureSchema } from "./system-recovery-state.js";

export const MAX_INSPECTED_WORKSPACE_SOURCES = 8;

export async function inspectWorkspaceSource(db: Db, input: WorkspaceRecoverySourceIdentity): Promise<WorkspaceSourceInspection> {
  const base = { schema: "paperclip.workspace-source-inspection.v1" as const, actionId: input.actionId,
    runId: input.runId, observedAt: new Date().toISOString(), scope: "recorded_source_identity" as const };
  try {
    await inspectWorkspaceRecoverySource(db, input, { maximumSources: MAX_INSPECTED_WORKSPACE_SOURCES });
    return { ...base, status: "verified" };
  } catch (error) {
    if (error instanceof WorkspaceSourceInspectionLimit) return { ...base, status: "not_inspected", reason: "source_limit" };
    if (!(error instanceof SystemRecoveryFailure)) throw error;
    const detail = workspaceSourceVerificationFailureSchema.safeParse(error.sourceVerification);
    return { ...base, status: "blocked", failureCode: error.code,
      ...(detail.success ? { sourceVerification: detail.data } : {}) };
  }
}

// The source-inspection owner also owns the narrowly approved local review
// revision capture. Recovery/source inspection above retains its existing API.
type Task = typeof issues.$inferSelect;
/** Only a native status committer holding the coordinator may supply this. */
export type NativeSourceReviewOwner = { runId: string; agentId: string; leaseOwner: string };
export function sourceReviewCaptureHold(reason: string): never {
  throw new SourceReviewCaptureUnavailable(reason);
}

/** Workspace-owner extension. The caller holds the issue row and native
 * coordinator (when applicable); all ownership rows remain locked through commit.
 * No path, revision, lease token or scope is accepted from provider prose. */
export async function captureWorkspaceReviewCandidate(db: Db, task: Task, owner: {
  agentId: string; runId: string; native?: NativeSourceReviewOwner;
}) {
  if (!task.executionWorkspaceId) sourceReviewCaptureHold("workspace_unbound");
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, task.companyId), eq(executionWorkspaces.id, task.executionWorkspaceId))).for("update");
  if (!workspace || workspace.status !== "active" || !workspace.projectId || workspace.projectId !== task.projectId ||
      !workspace.cwd || !workspace.repoUrl) sourceReviewCaptureHold("workspace_unbound");
  if (workspace.providerType !== "git_worktree" || workspace.mode !== "isolated_workspace" || readRemoteWorkspaceAuthority(workspace.metadata)) {
    sourceReviewCaptureHold("workspace_not_local_worktree");
  }
  if (!workspace.branchName) sourceReviewCaptureHold("branch_unverifiable");
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, task.companyId),
    eq(heartbeatRuns.id, owner.runId), eq(heartbeatRuns.agentId, owner.agentId))).for("update");
  if (!run || task.assigneeAgentId !== owner.agentId || task.executionRunId !== run.id ||
      (run.runtimeMode === "native" ? run.nativeIssueId !== task.id : run.issueId !== task.id && run.contextSnapshot?.issueId !== task.id)) {
    sourceReviewCaptureHold("writer_binding_mismatch");
  }
  if (run.runtimeMode === "native") {
    if (!owner.native || owner.native.runId !== run.id) sourceReviewCaptureHold("native_lease_missing");
    const [lease] = await db.select({ runId: nativeRunFinalizations.runId, resultId: nativeRunFinalizations.resultId,
      live: sql<boolean>`${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp()` }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, task.companyId), eq(nativeRunFinalizations.issueId, task.id),
      eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.leaseOwner, owner.native.leaseOwner))).for("update");
    if (!lease?.live || (run.status !== "running" && !(run.status === "succeeded" && lease.resultId))) sourceReviewCaptureHold("native_lease_mismatch");
  } else if (run.status !== "running" || !run.controllerLeaseExpiresAt || run.controllerLeaseExpiresAt <= new Date()) {
    sourceReviewCaptureHold("writer_lease_expired");
  }
  if (!await workspaceRuntimeLeaseHeldByRun(db, { companyId: task.companyId, workspaceId: workspace.id,
    issueId: task.id, runId: run.id, agentId: owner.agentId })) sourceReviewCaptureHold("workspace_writer_lease_mismatch");
  const authorize = () => authorizeSourceCitation(db, { type: "agent", source: "agent_jwt", companyId: task.companyId,
    agentId: owner.agentId, runId: run.id, onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId,
  }, { companyId: task.companyId, issueId: task.id, workspaceId: workspace.id, admission: true });
  const before = await authorize().catch(() => sourceReviewCaptureHold("source_access_denied"));
  let evidence;
  try {
    evidence = await prepareSourceMemory({ companyId: task.companyId, projectId: task.projectId, issueId: task.id,
      runId: run.id, phase: "review", provider: "server", model: "no-provider-capture", cwd: workspace.cwd,
      repoUrl: workspace.repoUrl, remoteAuthority: false }, "capture");
  } catch { sourceReviewCaptureHold("source_unverifiable"); }
  if (!evidence || evidence.ref !== `refs/heads/${workspace.branchName}` || !/^[a-f0-9]{40}$/.test(evidence.revision)) {
    sourceReviewCaptureHold("source_unverifiable");
  }
  const after = await authorize().catch(() => sourceReviewCaptureHold("source_access_denied"));
  if (JSON.stringify(after) !== JSON.stringify(before)) sourceReviewCaptureHold("source_binding_changed");
  return { candidateSha: evidence.revision, workspaceId: workspace.id, projectId: workspace.projectId,
    repositoryId: before.repositoryId, writerRunId: run.id, bindingRevision: task.workspaceBindingRevision };
}
