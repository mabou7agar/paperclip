/**
 * Wake the assignees waiting on a task that was just parked as `blocked`
 * (`issue_blocker_parked`), whoever parked it.
 *
 * A dependent hears about a blocker when every blocker is done
 * (`issue_blockers_resolved`) or when one stalls on a recovery action that
 * needs the board (`issue_blocker_stalled`). A worker that finishes its part,
 * leaves a hand-off comment and blocks its own task triggers neither: the
 * agent it is waiting for is the one behind the dependency gate, and nothing
 * tells it. OSA delivery, 2026-11-22: a waiting assignee sat idle for two and
 * a half hours until a person relayed the hand-off.
 *
 * Each agent-assigned task the parked one `blocks` is woken once per blocked
 * transition. The key names the transition time, so repeating the update never
 * wakes twice and a later re-block wakes again. The wake runs in the same
 * restricted mode as a comment on a blocked task: the dependency is still
 * unresolved, so the assignee may read the hand-off, answer, re-plan or
 * escalate, but the task is not checked out.
 */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentWakeupRequests, issueRelations, issues, type Db } from "@paperclipai/db";

export const ISSUE_BLOCKER_PARKED_WAKE_REASON = "issue_blocker_parked";
export const ISSUE_BLOCKER_PARKED_WAKE_SOURCE = "issue.blocker_parked";

/** Waiters that may be woken: not finished, and not parked in the backlog by the board. */
const WAKEABLE_WAITER_STATUSES = ["todo", "in_progress", "in_review", "blocked"];
/** A wake row with one of these statuses was delivered or is still pending. */
const DELIVERED_OR_PENDING_WAKE_STATUSES = ["queued", "deferred_issue_execution", "claimed", "coalesced", "completed"];
const MAX_WAITERS_PER_TRANSITION = 50;

export type IssueBlockerParkedWakeContext = {
  blockerIssueId: string;
  blockerIssueIdentifier: string | null;
  blockerIssueStatus: "blocked";
  blockedTransitionAt: string;
};

export type BlockerParkedWakeup = {
  agentId: string;
  wakeup: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    contextSnapshot: Record<string, unknown>;
    allowRunCoalescing: false;
  };
};

export function issueBlockerParkedWakeKey(input: { waiterIssueId: string; blockerIssueId: string; blockedTransitionAt: Date | string }) {
  return [ISSUE_BLOCKER_PARKED_WAKE_REASON, input.waiterIssueId, input.blockerIssueId,
    new Date(input.blockedTransitionAt).toISOString()].join(":");
}

async function readParkedBlocker(db: Db, input: { companyId: string; blockerIssueId: string }) {
  const [blocker] = await db.select({ id: issues.id, identifier: issues.identifier, status: issues.status,
    blockedTransitionAt: issues.blockedTransitionAt, assigneeAgentId: issues.assigneeAgentId })
    .from(issues).where(and(eq(issues.id, input.blockerIssueId), eq(issues.companyId, input.companyId))).limit(1);
  return blocker && blocker.status === "blocked" && blocker.blockedTransitionAt ? { ...blocker, blockedTransitionAt: blocker.blockedTransitionAt } : null;
}

/**
 * The wakes owed for the current blocked transition of `blockerIssueId`: one
 * per waiting task that has not been told about this transition yet. A waiter
 * held by the parked task's own assignee is skipped: that agent already knows
 * the task's state.
 */
export async function listBlockerParkedWakeups(db: Db, input: { companyId: string; blockerIssueId: string }): Promise<BlockerParkedWakeup[]> {
  const blocker = await readParkedBlocker(db, input);
  if (!blocker) return [];
  const waiters = await db.select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issueRelations)
    .innerJoin(issues, and(eq(issues.id, issueRelations.relatedIssueId), eq(issues.companyId, issueRelations.companyId)))
    .where(and(
      eq(issueRelations.companyId, input.companyId),
      eq(issueRelations.type, "blocks"),
      eq(issueRelations.issueId, blocker.id),
      ne(issues.id, blocker.id),
      inArray(issues.status, WAKEABLE_WAITER_STATUSES),
      isNull(issues.hiddenAt),
      isNull(issues.conversationAgentId),
      sql`${issues.assigneeAgentId} is not null`,
      blocker.assigneeAgentId ? ne(issues.assigneeAgentId, blocker.assigneeAgentId) : undefined,
    ))
    .orderBy(issues.id).limit(MAX_WAITERS_PER_TRANSITION);

  const wakeups: BlockerParkedWakeup[] = [];
  for (const waiter of waiters) {
    const idempotencyKey = issueBlockerParkedWakeKey({ waiterIssueId: waiter.id, blockerIssueId: blocker.id,
      blockedTransitionAt: blocker.blockedTransitionAt });
    const [existing] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        inArray(agentWakeupRequests.status, DELIVERED_OR_PENDING_WAKE_STATUSES))).limit(1);
    if (existing) continue;
    const blockerParked: IssueBlockerParkedWakeContext = {
      blockerIssueId: blocker.id, blockerIssueIdentifier: blocker.identifier, blockerIssueStatus: "blocked",
      blockedTransitionAt: blocker.blockedTransitionAt.toISOString(),
    };
    wakeups.push({ agentId: waiter.assigneeAgentId!, wakeup: {
      source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKER_PARKED_WAKE_REASON,
      payload: { issueId: waiter.id, blockerParked }, idempotencyKey,
      contextSnapshot: { issueId: waiter.id, taskId: waiter.id, wakeReason: ISSUE_BLOCKER_PARKED_WAKE_REASON,
        source: ISSUE_BLOCKER_PARKED_WAKE_SOURCE, blockerParked },
      // One transition per run: coalescing would keep only the last context.
      allowRunCoalescing: false,
    } });
  }
  return wakeups;
}

/**
 * Whether a wake's `issue_blocker_parked` context is real, so it may run past
 * the waiter's unresolved blockers. The reason string alone is not trusted:
 * the named task must block this one, be parked as `blocked` right now, and
 * the wake must carry the key of that exact transition, which is delivered at
 * most once. A scheduled retry carries no such key and stays suppressed.
 */
export async function verifyBlockerParkedWake(db: Db, input: {
  companyId: string;
  issueId: string;
  contextSnapshot: Record<string, unknown> | null | undefined;
  idempotencyKey: string | null | undefined;
}): Promise<boolean> {
  const context = input.contextSnapshot;
  if (!context || context.wakeReason !== ISSUE_BLOCKER_PARKED_WAKE_REASON || context.source !== ISSUE_BLOCKER_PARKED_WAKE_SOURCE) return false;
  const parked = context.blockerParked as Partial<IssueBlockerParkedWakeContext> | undefined;
  const blockerIssueId = typeof parked?.blockerIssueId === "string" ? parked.blockerIssueId : null;
  if (!blockerIssueId || blockerIssueId === input.issueId || !input.idempotencyKey) return false;
  const blocker = await readParkedBlocker(db, { companyId: input.companyId, blockerIssueId });
  if (!blocker) return false;
  if (input.idempotencyKey !== issueBlockerParkedWakeKey({ waiterIssueId: input.issueId, blockerIssueId,
    blockedTransitionAt: blocker.blockedTransitionAt })) return false;
  const [edge] = await db.select({ id: issueRelations.id }).from(issueRelations)
    .where(and(eq(issueRelations.companyId, input.companyId), eq(issueRelations.type, "blocks"),
      eq(issueRelations.issueId, blockerIssueId), eq(issueRelations.relatedIssueId, input.issueId))).limit(1);
  return Boolean(edge);
}
