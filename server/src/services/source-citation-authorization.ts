import { and, eq } from "drizzle-orm";
import { executionWorkspaces, projectWorkspaces, heartbeatRuns, type Db } from "@paperclipai/db";
import type { AuthorizationActor } from "./authorization.js";
import { assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { sourceMemoryRepositoryId } from "./source-memory.js";
import { SourceCitationError, type CitationBinding } from "./source-citation-consumer.js";

/** Uses current task access, not an earlier admission decision or a submitted scope. */
export async function authorizeSourceCitation(db: Db, actor: AuthorizationActor, input: {
  companyId: string; issueId: string; workspaceId: string; admission?: boolean;
}): Promise<CitationBinding> {
  const selected = await assertTaskWorkspaceExecutionAccess(db, actor, input.companyId, {
    issueId: input.issueId, workspaceId: input.workspaceId,
  });
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
  const sourceId = selected.workspace?.projectWorkspaceId;
  const [source] = sourceId ? await db.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.id, sourceId), eq(projectWorkspaces.companyId, input.companyId))) : [];
  if (!workspace || !source?.repoUrl || !workspace.repoUrl || !source.projectId ||
      workspace.projectWorkspaceId !== source.id || workspace.projectId !== source.projectId ||
      sourceMemoryRepositoryId(source.repoUrl) !== sourceMemoryRepositoryId(workspace.repoUrl)) {
    throw new SourceCitationError("repository_denied");
  }
  // Admission checks scope before the reader runs. Only the server admission path
  // may then persist its resolved HEAD; result consumption always requires it.
  if (input.admission) return { companyId: input.companyId, projectId: source.projectId,
    repositoryId: sourceMemoryRepositoryId(source.repoUrl), frozenSha: "" };
  const runId = actor.type === "agent" ? actor.runId : null;
  const [run] = runId ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, input.companyId))) : [];
  const snapshot = run?.contextSnapshot?.sourceSnapshot as { workspaceId?: string; revision?: string } | undefined;
  if (!run || run.issueId !== input.issueId || snapshot?.workspaceId !== input.workspaceId || !snapshot.revision || !/^[a-f0-9]{40}$/.test(snapshot.revision)) throw new SourceCitationError("task_snapshot_unavailable");
  return { companyId: input.companyId, projectId: source.projectId,
    repositoryId: sourceMemoryRepositoryId(source.repoUrl), frozenSha: snapshot.revision };
}
