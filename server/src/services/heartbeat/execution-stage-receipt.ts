import { agentWakeupRequests } from "@paperclipai/db";
import { sql } from "drizzle-orm";

/** A saved request for the current participant, not a general recovery wake.
 * Eligibility here only selects an obligation; canonical release still owns
 * process cleanup, pauses, budgets, access, and execution admission. */
export const currentExecutionStageReceiptSql = sql<boolean>`exists (
  select 1 from issues stage_issue
  where stage_issue.company_id = ${agentWakeupRequests.companyId}
    and stage_issue.id::text = ${agentWakeupRequests.payload}->>'issueId'
    and stage_issue.status = 'in_review' and stage_issue.execution_run_id is null
    -- Once admission records a hold, the existing execution-wait owner takes
    -- over. Do not repeatedly re-promote its same stage around that owner.
    and coalesce(${agentWakeupRequests.payload}->'executionWait', 'null'::jsonb) = 'null'::jsonb
    and exists (select 1 from agents stage_agent
      where stage_agent.id = ${agentWakeupRequests.agentId}
        and stage_agent.company_id = ${agentWakeupRequests.companyId}
        and stage_agent.status not in ('paused', 'terminated', 'pending_approval'))
    and stage_issue.execution_state->>'status' = 'pending'
    and stage_issue.execution_state->>'currentStageId' = ${agentWakeupRequests.payload}#>>'{executionStage,stageId}'
    and stage_issue.execution_state#>>'{currentParticipant,agentId}' = ${agentWakeupRequests.agentId}::text
    and ((${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,wakeReason}' = 'execution_review_requested'
        and stage_issue.execution_state->>'currentStageType' = 'review')
      or (${agentWakeupRequests.payload}#>>'{_paperclipWakeContext,wakeReason}' = 'execution_approval_requested'
        and stage_issue.execution_state->>'currentStageType' = 'approval'))
)`;
