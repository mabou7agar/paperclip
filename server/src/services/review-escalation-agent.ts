import { and, eq } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

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
