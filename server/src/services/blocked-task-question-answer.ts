import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import { issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

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
 * answered by someone else. Each answer wakes the assignee once (the delivery
 * wake is idempotent per question), and the turn runs in the same restricted
 * mode as a comment on a blocked task. It does not satisfy the dependency.
 */
export async function isAnsweredQuestionForBlockedTask(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; contextSnapshot: Record<string, unknown> | null | undefined },
): Promise<boolean> {
  const context = input.contextSnapshot ?? {};
  if (!isAnsweredQuestionWakeContext(context)) return false;
  const interactionId = typeof context.interactionId === "string" ? context.interactionId : null;
  if (!interactionId || !isUuidLike(interactionId)) return false;
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
