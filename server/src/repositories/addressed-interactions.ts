import { and, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";

export function findAddressedInteraction(db: Db, input: {
  companyId: string; issueId: string; agentId: string; interactionId: string;
  excludeTaskOwnerAndCreator?: boolean;
  allowTaskOwnerFromBlockingSource?: boolean;
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
      and (${issues.assigneeAgentId} is null or ${issues.assigneeAgentId} <> ${input.agentId}
        or ${input.allowTaskOwnerFromBlockingSource === true} and exists (
          with recursive blocking_sources(id) as (
            select relation.issue_id from issue_relations relation
            join issues blocker on blocker.id = relation.issue_id and blocker.company_id = relation.company_id
            where relation.company_id = ${input.companyId} and relation.related_issue_id = ${input.issueId}
              and relation.type = 'blocks' and blocker.status not in ('done', 'cancelled')
            union
            select relation.issue_id from issue_relations relation
            join blocking_sources parent on parent.id = relation.related_issue_id
            join issues blocker on blocker.id = relation.issue_id and blocker.company_id = relation.company_id
            where relation.company_id = ${input.companyId} and relation.type = 'blocks'
              and blocker.status not in ('done', 'cancelled')
          )
          select 1 from heartbeat_runs source_run
          join blocking_sources source_scope on source_scope.id = source_run.issue_id
          join issues source_issue on source_issue.id = source_run.issue_id and source_issue.company_id = source_run.company_id
          where source_run.id = ${issueThreadInteractions.sourceRunId}
            and source_run.company_id = ${input.companyId}
            and source_run.agent_id = ${issueThreadInteractions.createdByAgentId}
            and source_issue.assignee_agent_id = ${issueThreadInteractions.createdByAgentId}
            and source_run.status in ('running', 'succeeded')
        )))` : undefined,
  )).limit(1).then((rows) => rows[0] ?? null);
}

export async function hasConsumedAddressedInteractionWake(db: Db, input: {
  companyId: string; issueId: string; agentId: string; interactionId: string;
  excludeRequestId?: string | null;
  phase?: "pending" | "accepted" | "rejected";
}) {
  const phase = input.phase ?? "pending";
  const source = phase === "pending" ? "issue.interaction.created" : `issue.interaction.${phase === "accepted" ? "accept" : "reject"}`;
  const key = phase === "pending" ? `interaction-pending:${input.interactionId}` : `interaction:${input.interactionId}:${phase}`;
  const [receipt] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).leftJoin(heartbeatRuns, and(
    eq(heartbeatRuns.id, agentWakeupRequests.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
  )).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    eq(agentWakeupRequests.idempotencyKey, key),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,interactionId}' = ${input.interactionId}`,
    sql`${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,source}' = ${source}`,
    input.excludeRequestId ? ne(agentWakeupRequests.id, input.excludeRequestId) : undefined,
    ne(agentWakeupRequests.status, "skipped"),
    or(and(eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId)),
      sql`${heartbeatRuns.startedAt} is not null`,
      sql`${heartbeatRuns.status} in ('queued', 'scheduled_retry')`,
      and(eq(agentWakeupRequests.status, "completed"), eq(heartbeatRuns.errorCode, "blocking_disposition_already_forwarded"))),
  )).limit(1);
  return Boolean(receipt);
}

export async function hasAddressedOwnerDispositionRun(db: Db, input: {
  companyId: string; issueId: string; agentId: string; interactionId: string; resolvedRunId: string;
  requireSettledDecision?: boolean;
}) {
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).innerJoin(issues, and(
    eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.assigneeAgentId, input.agentId),
  )).where(and(
    eq(heartbeatRuns.id, input.resolvedRunId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.issueId, input.issueId),
    input.requireSettledDecision ? eq(heartbeatRuns.status, "succeeded") : sql`${heartbeatRuns.status} in ('running', 'succeeded')`,
    sql`${heartbeatRuns.contextSnapshot}->>'interactionId' = ${input.interactionId}`,
    sql`${heartbeatRuns.contextSnapshot}->>'source' = 'issue.interaction.created'`,
    sql`${heartbeatRuns.contextSnapshot}->>'interactionKind' = 'request_confirmation'`,
    sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'interaction_pending'`,
    sql`${heartbeatRuns.contextSnapshot}->>'dependencyBlockedInteraction' = 'true'`,
  )).limit(1);
  return Boolean(run);
}

/** An explicit resume delivered to the original blocker by the deciding run. */
export async function findDeliveredBlockingDispositionHandoff(db: Db, input: {
  companyId: string;
  sourceRunId: string;
  decidingRunId: string;
  decidingAgentId: string;
  resolvedAt: Date;
}) {
  const deliveredRun = alias(heartbeatRuns, "delivered_blocking_disposition_run");
  const [receipt] = await db.select({ commentId: issueComments.id, wakeId: agentWakeupRequests.id })
    .from(heartbeatRuns)
    .innerJoin(issues, and(
      eq(issues.id, heartbeatRuns.issueId),
      eq(issues.companyId, heartbeatRuns.companyId),
      eq(issues.assigneeAgentId, heartbeatRuns.agentId),
    ))
    .innerJoin(issueComments, and(
      eq(issueComments.issueId, issues.id),
      eq(issueComments.companyId, issues.companyId),
      eq(issueComments.authorType, "agent"),
      eq(issueComments.authorAgentId, input.decidingAgentId),
      eq(issueComments.createdByRunId, input.decidingRunId),
      gte(issueComments.createdAt, input.resolvedAt),
      isNull(issueComments.deletedAt),
    ))
    .innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.companyId, issues.companyId),
      eq(agentWakeupRequests.agentId, issues.assigneeAgentId),
      eq(agentWakeupRequests.requestedByActorType, "agent"),
      eq(agentWakeupRequests.requestedByActorId, input.decidingAgentId),
      eq(agentWakeupRequests.reason, "issue_commented"),
      sql`${agentWakeupRequests.payload}->>'commentId' = ${issueComments.id}::text`,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issues.id}::text`,
      sql`${agentWakeupRequests.payload}->'resumeIntent' = 'true'::jsonb`,
      sql`${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,source}' = 'issue.comment'`,
      gte(agentWakeupRequests.requestedAt, input.resolvedAt),
      inArray(agentWakeupRequests.status, ["claimed", "coalesced", "completed"]),
    ))
    .innerJoin(deliveredRun, and(
      eq(deliveredRun.id, agentWakeupRequests.runId),
      eq(deliveredRun.companyId, issues.companyId),
      eq(deliveredRun.agentId, issues.assigneeAgentId),
      eq(deliveredRun.issueId, issues.id),
      inArray(deliveredRun.status, ["running", "succeeded"]),
      isNotNull(deliveredRun.startedAt),
      gte(deliveredRun.startedAt, issueComments.createdAt),
    ))
    .where(and(eq(heartbeatRuns.id, input.sourceRunId), eq(heartbeatRuns.companyId, input.companyId)))
    .limit(1);
  return receipt ?? null;
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
