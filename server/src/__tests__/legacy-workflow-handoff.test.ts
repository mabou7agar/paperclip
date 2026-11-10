import { describe, expect, it } from "vitest";
import { assertLegacyRunTaskOwnership, isLegacyRunSelfHandoff } from "../legacy-run-task-ownership.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

const worker = "11111111-1111-4111-8111-111111111111", reviewer = "22222222-2222-4222-8222-222222222222";
const issue = { id: "33333333-3333-4333-8333-333333333333", companyId: "44444444-4444-4444-8444-444444444444",
  status: "in_progress", assigneeAgentId: worker, assigneeUserId: null };
const run = { id: "55555555-5555-4555-8555-555555555555", companyId: issue.companyId, agentId: worker,
  runtimeMode: "legacy", status: "running", contextSnapshot: { issueId: issue.id } };
const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer }] }] })!;
const transition = applyIssueExecutionPolicyTransition({ issue, policy, requestedStatus: "done", requestedAssigneePatch: {},
  actor: { agentId: worker }, commentBody: "Ready for review" });
const input = { actor: { type: "agent", source: "agent_jwt", agentId: worker, runId: run.id }, issue, run,
  targetAgentId: reviewer, targetUserId: null, workflowControlledAssignment: transition.workflowControlledAssignment,
  explicitAssignee: false, status: transition.patch.status, executionState: transition.patch.executionState };

describe("legacy workflow handoff authority", () => {
  it("recognizes a real server-derived native stage transition", () => {
    expect(isLegacyRunSelfHandoff(input)).toBe(true);
  });
  it.each([
    { explicitAssignee: true }, { workflowControlledAssignment: false }, { status: "done" }, { executionState: null },
    { targetAgentId: worker }, { run: { ...run, runtimeMode: "native" } }, { run: { ...run, status: "queued" } },
    { actor: { ...input.actor, type: "board" } }, { actor: { ...input.actor, source: "agent_key" } },
    { run: { ...run, contextSnapshot: { issueId: reviewer } } }, { run: { ...run, companyId: reviewer } },
  ])("keeps non-self or caller-selected transfers outside the exception: %j", change => {
    expect(isLegacyRunSelfHandoff({ ...input, ...change })).toBe(false);
  });
  it("retains human self-handoff behavior", () => {
    expect(isLegacyRunSelfHandoff({ ...input, targetAgentId: null, targetUserId: "human", explicitAssignee: true })).toBe(true);
  });
  it("revokes the old owner's task writes while allowing the current native participant", () => {
    const handedOff = { ...issue, assigneeAgentId: reviewer, executionState: transition.patch.executionState };
    expect(() => assertLegacyRunTaskOwnership({ ...run, resultJson: { legacyWorkflowHandoffIssueId: issue.id } }, handedOff, worker)).toThrow(expect.objectContaining({
      status: 403, details: { code: "issue_handed_off", issueId: issue.id },
    }));
    expect(() => assertLegacyRunTaskOwnership({ ...run, agentId: reviewer }, handedOff, reviewer)).not.toThrow();
    // A compatible older review may retain the original assignee column.
    expect(() => assertLegacyRunTaskOwnership(run, { ...handedOff, assigneeAgentId: worker }, reviewer)).not.toThrow();
  });
  it("preserves a same-task mention or manager run that never handed off ownership", () => {
    expect(() => assertLegacyRunTaskOwnership(run, { ...issue, assigneeAgentId: reviewer }, worker)).not.toThrow();
  });
  it("keeps cross-task management and native Runner authority unchanged", () => {
    expect(() => assertLegacyRunTaskOwnership({ ...run, contextSnapshot: { issueId: reviewer } },
      { ...issue, assigneeAgentId: reviewer }, worker)).not.toThrow();
    expect(() => assertLegacyRunTaskOwnership({ ...run, runtimeMode: "native" },
      { ...issue, assigneeAgentId: reviewer }, worker)).not.toThrow();
  });
});
