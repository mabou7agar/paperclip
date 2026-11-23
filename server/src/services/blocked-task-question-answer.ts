import { and, eq, isNotNull, ne, notInArray, or } from "drizzle-orm";
import { issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

/** The key of the single wake the question-response delivery issues per answered question. */
export function answeredQuestionWakeKey(interactionId: string) {
  return `question-response:${interactionId}`;
}

/**
 * Waiting statuses in which a continuation is normally refused as "not in
 * progress", but an answer may still run its restricted turn. `in_progress`
 * and `in_review` already pass that check.
 */
export const ANSWERABLE_WAITING_TASK_STATUSES = ["blocked", "todo"];
/** A finished task, or one the board parked in the backlog, never receives the answer this way. */
const NEVER_ANSWERABLE_TASK_STATUSES = ["backlog", "done", "cancelled"];

/** The wake the question-response delivery sends to the task assignee. */
export function isAnsweredQuestionWakeContext(context: Record<string, unknown>): boolean {
  return context.source === "issue.interaction.respond" &&
    context.wakeReason === "issue_commented" &&
    context.mutation === "interaction" &&
    context.interactionKind === "ask_user_questions" &&
    context.interactionStatus === "answered" &&
    !context.retryReason;
}

/**
 * A task that waits on unresolved blockers stays idle for automatic wakes and
 * scheduled retries. An answer to a question its own assignee asked is
 * different: it is the input the assignee was waiting for, and often the
 * input a blocking child needs relayed. Dropping that wake leaves the answer
 * unread until a person passes it on by hand.
 *
 * The wake context alone never qualifies. This reads server-owned rows: an
 * answered question on this task, asked by the task's current assignee and
 * answered by someone else, on a task that is not finished and not parked in
 * `backlog` by the board. Each answer wakes the assignee once: the
 * wake must carry the delivery's own key, and the turn runs in the same restricted
 * mode as a comment on a blocked task. It does not satisfy the dependency.
 */
export async function isAnsweredQuestionForBlockedTask(
  db: Db,
  input: {
    companyId: string; issueId: string; agentId: string;
    contextSnapshot: Record<string, unknown> | null | undefined;
    /** The idempotency key of the wake request behind this run. */
    idempotencyKey: string | null | undefined;
  },
): Promise<boolean> {
  const context = input.contextSnapshot ?? {};
  if (!isAnsweredQuestionWakeContext(context)) return false;
  const interactionId = typeof context.interactionId === "string" ? context.interactionId : null;
  if (!interactionId || !isUuidLike(interactionId)) return false;
  // A question stays answered forever. Only the delivery's own wake, which is
  // issued once per question, may pass; a later wake carrying the same context does not.
  if (input.idempotencyKey !== answeredQuestionWakeKey(interactionId)) return false;
  const rows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issues.id, issueThreadInteractions.issueId),
      eq(issues.companyId, issueThreadInteractions.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.kind, "ask_user_questions"),
      eq(issueThreadInteractions.status, "answered"),
      isNotNull(issueThreadInteractions.resolvedAt),
      eq(issueThreadInteractions.createdByAgentId, input.agentId),
      eq(issues.assigneeAgentId, input.agentId),
      notInArray(issues.status, NEVER_ANSWERABLE_TASK_STATUSES),
      // A blocked-task exception cannot be manufactured by its own worker.
      or(
        isNotNull(issueThreadInteractions.resolvedByUserId),
        and(
          isNotNull(issueThreadInteractions.resolvedByAgentId),
          ne(issueThreadInteractions.resolvedByAgentId, input.agentId),
        ),
      ),
    ))
    .limit(1);
  return rows.length > 0;
}
