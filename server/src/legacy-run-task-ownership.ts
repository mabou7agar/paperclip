import { forbidden } from "./errors.js";
import { parseIssueExecutionState } from "./services/issue-execution-policy.js";

/** The native workflow may hand off a legacy caller after its final write. */
export function isLegacyRunSelfHandoff(input: {
  actor: { type: string; source?: string; agentId?: string; runId?: string | null };
  issue: { id: string; companyId: string; assigneeAgentId: string | null };
  run: { id: string; agentId: string; companyId: string; runtimeMode: string; status?: string;
    contextSnapshot?: Record<string, unknown> | null } | null;
  targetAgentId: string | null;
  targetUserId: string | null;
  workflowControlledAssignment?: boolean;
  explicitAssignee: boolean;
  status?: unknown;
  executionState?: unknown;
}) {
  const { actor, issue, run } = input;
  if (actor.type !== "agent" || actor.source !== "agent_jwt" ||
      actor.agentId !== issue.assigneeAgentId || run?.runtimeMode !== "legacy" ||
      run.id !== actor.runId || run.agentId !== actor.agentId ||
      run.companyId !== issue.companyId || run.contextSnapshot?.issueId !== issue.id) return false;
  // Preserve the existing return-to-human behavior.
  if (input.targetAgentId === null && typeof input.targetUserId === "string") return true;
  const state = parseIssueExecutionState(input.executionState);
  return input.workflowControlledAssignment === true && !input.explicitAssignee && run.status === "running" &&
    typeof input.targetAgentId === "string" && input.targetAgentId !== actor.agentId &&
    input.targetUserId === null && input.status === "in_review" && state?.status === "pending" &&
    state.currentParticipant?.type === "agent" && state.currentParticipant.agentId === input.targetAgentId;
}

export function assertLegacyRunTaskOwnership(
  run: {
    companyId: string;
    runtimeMode: string;
    resultJson?: Record<string, unknown> | null;
    contextSnapshot?: Record<string, unknown> | null;
  } | null | undefined,
  issue: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    executionState?: unknown;
  },
  actorAgentId?: string,
) {
  if (run?.runtimeMode !== "legacy" || run.companyId !== issue.companyId ||
      run.contextSnapshot?.issueId !== issue.id) return;
  const humanHandoff = issue.assigneeAgentId === null && Boolean(issue.assigneeUserId);
  const state = parseIssueExecutionState(issue.executionState);
  const currentParticipant = state?.status === "pending" && state.currentParticipant?.type === "agent"
    ? state.currentParticipant.agentId : null;
  const handedOffIssue = run.resultJson?.legacyWorkflowHandoffIssueId;
  const agentHandoff = Boolean(handedOffIssue === issue.id && actorAgentId && issue.assigneeAgentId &&
    issue.assigneeAgentId !== actorAgentId && currentParticipant !== actorAgentId);
  if (humanHandoff || agentHandoff) {
    throw forbidden(humanHandoff
      ? "This task is assigned to a human; the outgoing run can no longer change it"
      : "This task was handed to another agent; the outgoing run can no longer change it", {
      code: "issue_handed_off",
      issueId: issue.id,
    });
  }
}
