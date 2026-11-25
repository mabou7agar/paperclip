import { and, eq } from "drizzle-orm";
import { agents, companies, type Db } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { applyIssueExecutionPolicyTransition, NO_ELIGIBLE_STAGE_PARTICIPANT_CODE, parseIssueExecutionState } from "./issue-execution-policy.js";

/** An agent in one of these states cannot take a review handed to it. */
const NON_INVOKABLE_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];

async function readEscalationAgentStatus(db: Db, companyId: string, policy: Pick<IssueExecutionPolicy, "reviewEscalationAgentId"> | null | undefined) {
  const agentId = policy?.reviewEscalationAgentId?.trim();
  if (!agentId) return null;
  const [agent] = await db.select({ status: agents.status }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).limit(1);
  return { found: Boolean(agent), invokable: Boolean(agent) && !NON_INVOKABLE_AGENT_STATUSES.includes(agent!.status) };
}

/**
 * Whether the policy's review escalation agent can take a capped review now:
 * it exists in this company and is not paused, terminated or awaiting
 * approval. When it cannot, the review goes to the responsible human.
 */
export async function isReviewEscalationAgentAvailable(db: Db, companyId: string,
  policy: Pick<IssueExecutionPolicy, "reviewEscalationAgentId"> | null | undefined): Promise<boolean> {
  return (await readEscalationAgentStatus(db, companyId, policy))?.invokable === true;
}

/**
 * The agent that receives a capped review on this task before the human, or
 * null when the review goes straight to the human. Every caller that can
 * record a reviewer's decision resolves it here:
 * - the task's `reviewEscalationAgentId` when it names an agent;
 * - no agent when the task sets it to null explicitly;
 * - otherwise the company's `defaultReviewEscalationAgentId`;
 * and only when that agent exists in the company and can run now.
 */
export async function resolveReviewEscalationAgentId(db: Db, companyId: string,
  policy: Pick<IssueExecutionPolicy, "reviewEscalationAgentId" | "reviewGuard"> | null | undefined): Promise<string | null> {
  if (!policy || policy.reviewGuard) return null;
  let agentId = policy.reviewEscalationAgentId;
  if (agentId === undefined) {
    const [company] = await db.select({ agentId: companies.defaultReviewEscalationAgentId }).from(companies)
      .where(eq(companies.id, companyId)).limit(1);
    agentId = company?.agentId ?? null;
  }
  if (!agentId) return null;
  return await isReviewEscalationAgentAvailable(db, companyId, { reviewEscalationAgentId: agentId }) ? agentId : null;
}

/** Refuse saving a policy whose review escalation agent is not a usable agent of this company. */
export async function assertReviewEscalationAgent(db: Db, companyId: string,
  policy: Pick<IssueExecutionPolicy, "reviewEscalationAgentId"> | null | undefined): Promise<void> {
  const state = await readEscalationAgentStatus(db, companyId, policy);
  if (!state) return;
  if (!state.found) {
    throw unprocessable("Review escalation agent must be an agent of the task's company", { code: "review_escalation_agent_not_found" });
  }
  if (!state.invokable) {
    throw unprocessable("Review escalation agent is paused, terminated or awaiting approval", { code: "review_escalation_agent_unavailable" });
  }
}

/** The company's default review escalation agent when it exists and can run now. */
export async function resolveFallbackReviewerAgentId(db: Db, companyId: string): Promise<string | null> {
  const [company] = await db.select({ agentId: companies.defaultReviewEscalationAgentId }).from(companies)
    .where(eq(companies.id, companyId)).limit(1);
  const agentId = company?.agentId ?? null;
  if (!agentId) return null;
  return await isReviewEscalationAgentAvailable(db, companyId, { reviewEscalationAgentId: agentId }) ? agentId : null;
}

type TransitionInput = Parameters<typeof applyIssueExecutionPolicyTransition>[0];

function noEligibleStageParticipant(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 422 &&
    (error.details as { code?: unknown } | undefined)?.code === NO_ELIGIBLE_STAGE_PARTICIPANT_CODE;
}

export const REVIEW_WITHOUT_ELIGIBLE_PARTICIPANT_INSTRUCTION =
  "A review on this task cannot proceed: no stage participant is eligible (each is the author or the acting reviewer) and no " +
  "company review escalation agent can take it. Add an eligible reviewer to the stage, or set the company's default review " +
  "escalation agent, then hand the task back to review.";

/**
 * Apply an execution-policy transition, falling back to the company's default
 * review escalation agent when a review stage has no eligible participant
 * (OSA-586: the reviewer's approval was refused with 422 although an
 * escalation agent was configured). The fallback is only computed after the
 * plain transition refuses, so ordinary updates pay nothing. When no eligible
 * fallback exists the refusal is kept, and an alert-only monitoring alert is
 * recorded so the stuck review does not go unnoticed.
 */
export async function applyIssueExecutionPolicyTransitionWithReviewerFallback(db: Db,
  issue: { id: string; companyId: string; assigneeAgentId?: string | null }, input: TransitionInput) {
  try {
    return applyIssueExecutionPolicyTransition(input);
  } catch (error) {
    if (!noEligibleStageParticipant(error)) throw error;
    const fallbackReviewerAgentId = await resolveFallbackReviewerAgentId(db, issue.companyId).catch((err) => {
      logger.warn({ err, issueId: issue.id }, "failed to resolve the fallback reviewer");
      return null;
    });
    if (fallbackReviewerAgentId) {
      try {
        return applyIssueExecutionPolicyTransition({ ...input, fallbackReviewerAgentId });
      } catch (retryError) {
        if (!noEligibleStageParticipant(retryError)) throw retryError;
      }
    }
    // Wake neither the author under review nor the reviewer who was refused.
    const author = parseIssueExecutionState(input.issue.executionState)?.returnAssignee?.agentId ?? input.issue.assigneeAgentId;
    await reportReviewWithoutEligibleParticipant(db, issue, error, [author, input.actor.agentId]).catch((err) =>
      logger.warn({ err, issueId: issue.id }, "failed to report a review without an eligible participant"));
    throw error;
  }
}

async function reportReviewWithoutEligibleParticipant(db: Db, issue: { id: string; companyId: string; assigneeAgentId?: string | null },
  error: HttpError, exclude: readonly (string | null | undefined)[]) {
  const [{ monitoringService }, { resolveFollowUpNudgeAgent }] = await Promise.all([
    import("./monitoring.js"), import("./follow-up-monitoring.js"),
  ]);
  const details = (error.details ?? {}) as { stageId?: string; stageType?: string };
  await monitoringService(db).observe({
    companyId: issue.companyId, issueId: issue.id, kind: "review_without_eligible_participant",
    fingerprint: JSON.stringify(["review_without_eligible_participant", details.stageId ?? null]),
    // The task's own assignee is the author or the stuck reviewer: wake the escalation path instead.
    nudgeAgentId: await resolveFollowUpNudgeAgent(db, issue.companyId, null, { exclude }),
    nudgeInstruction: REVIEW_WITHOUT_ELIGIBLE_PARTICIPANT_INSTRUCTION,
    details: { stageId: details.stageId ?? null, stageType: details.stageType ?? null, message: error.message },
  });
}
