import { and, eq, isNull, ne, notInArray, or } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";

export const ISSUE_UNBLOCK_REQUESTED_WAKE_REASON = "issue_unblock_requested";

export function issueUnblockWakeKey(input: { issueId: string; blockedTransitionAt: Date | string }) {
  return `issue-unblock:${input.issueId}:${new Date(input.blockedTransitionAt).toISOString()}`;
}

/** The idempotency key of the wake request that created a run, if any. */
export async function readRunWakeIdempotencyKey(db: Db, input: { companyId: string; runId: string }): Promise<string | null> {
  const [row] = await db.select({ idempotencyKey: agentWakeupRequests.idempotencyKey })
    .from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, and(eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
      eq(agentWakeupRequests.companyId, heartbeatRuns.companyId)))
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
  return row?.idempotencyKey ?? null;
}

/**
 * A blocked task names who must act to unblock it (`unblockDescriptor.owner`),
 * and that agent is woken on the task (`issue_unblock_requested`). The owner
 * is usually not the task's assignee, so the ordinary ownership check cancelled
 * its run as `issue_assignee_changed` and the hand-off reached nobody.
 *
 * The wake context alone never qualifies. The task must be blocked now, name
 * this agent as its unblock owner, and the wake must carry the key of that
 * exact blocked transition, which is delivered once. The owner acts on the
 * request; it does not take ownership of the task.
 */
export async function verifyUnblockOwnerWake(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  contextSnapshot: Record<string, unknown> | null | undefined;
  idempotencyKey: string | null | undefined;
}): Promise<boolean> {
  if (input.contextSnapshot?.wakeReason !== ISSUE_UNBLOCK_REQUESTED_WAKE_REASON || !input.idempotencyKey) return false;
  const [issue] = await db.select({ status: issues.status, blockedTransitionAt: issues.blockedTransitionAt,
    unblockDescriptor: issues.unblockDescriptor })
    .from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).limit(1);
  if (!issue || issue.status !== "blocked" || !issue.blockedTransitionAt) return false;
  const owner = issue.unblockDescriptor?.owner;
  if (!owner || owner === "board" || !("agentId" in owner) || owner.agentId !== input.agentId) return false;
  return input.idempotencyKey === issueUnblockWakeKey({ issueId: input.issueId, blockedTransitionAt: issue.blockedTransitionAt });
}

/**
 * Whether `agentId` is assigned the parent or a sibling of `issue`. An agent
 * blocking its own task may name such an agent as the unblock owner, so a
 * hand-off inside one piece of work reaches the agent it is for. Agents
 * outside that family still cannot be named by another agent.
 */
export async function isFamilyTaskAssignee(db: Db, input: {
  companyId: string;
  issue: { id: string; parentId: string | null };
  agentId: string;
}): Promise<boolean> {
  if (!input.issue.parentId) return false;
  const [row] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId),
    eq(issues.assigneeAgentId, input.agentId),
    ne(issues.id, input.issue.id),
    isNull(issues.hiddenAt),
    notInArray(issues.status, ["cancelled"]),
    or(eq(issues.id, input.issue.parentId), eq(issues.parentId, input.issue.parentId)),
  )).limit(1);
  return Boolean(row);
}
