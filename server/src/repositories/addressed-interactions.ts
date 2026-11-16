import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, issues, issueThreadInteractions, type Db } from "@paperclipai/db";

export function findAddressedInteraction(db: Db, input: {
  companyId: string; issueId: string; agentId: string; interactionId: string;
  excludeTaskOwnerAndCreator?: boolean;
}) {
  return db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.id, input.interactionId),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
    input.excludeTaskOwnerAndCreator ? or(isNull(issueThreadInteractions.createdByAgentId),
      ne(issueThreadInteractions.createdByAgentId, input.agentId)) : undefined,
    input.excludeTaskOwnerAndCreator ? sql`exists (select 1 from ${issues}
      where ${issues.id} = ${input.issueId} and ${issues.companyId} = ${input.companyId}
      and (${issues.assigneeAgentId} is null or ${issues.assigneeAgentId} <> ${input.agentId}))` : undefined,
  )).limit(1).then((rows) => rows[0] ?? null);
}

export const pendingAddressedInteractionReceiptSql = sql<boolean>`exists (
  select 1 from issue_thread_interactions attention
  join issues attention_issue on attention_issue.id = attention.issue_id
    and attention_issue.company_id = attention.company_id
  where attention.company_id = ${agentWakeupRequests}.company_id
    and attention.issue_id::text = ${agentWakeupRequests}.payload->>'issueId'
    and attention.id::text = ${agentWakeupRequests}.payload#>>'{_paperclipWakeContext,interactionId}'
    and attention.addressee_agent_id = ${agentWakeupRequests}.agent_id
    and attention.addressee_user_id is null and attention.status = 'pending'
    and attention.kind in ('ask_user_questions', 'request_confirmation')
    and attention.kind = ${agentWakeupRequests}.payload#>>'{_paperclipWakeContext,interactionKind}'
    and attention_issue.status not in ('done', 'cancelled')
    and ${agentWakeupRequests}.payload#>>'{_paperclipWakeContext,wakeReason}' = 'interaction_pending'
    and ${agentWakeupRequests}.payload#>>'{_paperclipWakeContext,source}' = 'issue.interaction.created'
    and coalesce(${agentWakeupRequests}.payload->'executionWait', 'null'::jsonb) = 'null'::jsonb
)`;
