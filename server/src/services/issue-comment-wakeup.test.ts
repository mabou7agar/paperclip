import { describe, expect, it } from "vitest";
import { shouldWakeAssigneeForIssueComment } from "./issue-comment-wakeup.js";

describe("shouldWakeAssigneeForIssueComment", () => {
  it("suppresses explicit resume from the run that currently owns the issue", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-current",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("preserves explicit resume from a completed prior run", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: true,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {
          checkoutRunId: "run-current",
          executionRunId: "run-current",
        },
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(true);
  });

  it("keeps ordinary self-comments inert", () => {
    expect(
      shouldWakeAssigneeForIssueComment({
        selfComment: true,
        resumeRequested: false,
        commentCreatedByRunId: "run-prior",
        issueAtCommentStart: {},
        reopened: false,
        currentStatus: "in_progress",
      }),
    ).toBe(false);
  });

  it("does not wake a closed issue unless the comment reopened it", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      currentStatus: "done",
    };
    expect(
      shouldWakeAssigneeForIssueComment({ ...base, reopened: false }),
    ).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, reopened: true })).toBe(
      true,
    );
  });

  it("does not wake the assignee for an agent's information-only note", () => {
    const base = {
      selfComment: false,
      resumeRequested: false,
      issueAtCommentStart: {},
      reopened: false,
      currentStatus: "blocked",
    };
    expect(shouldWakeAssigneeForIssueComment(base)).toBe(true);
    expect(shouldWakeAssigneeForIssueComment({ ...base, quietAgentComment: true })).toBe(false);
    expect(shouldWakeAssigneeForIssueComment({ ...base, currentStatus: "in_progress", quietAgentComment: true })).toBe(false);
  });

  it("still wakes for a quiet note that reopens the task or asks for a turn", () => {
    const base = {
      selfComment: false,
      issueAtCommentStart: {},
      quietAgentComment: true,
    };
    expect(shouldWakeAssigneeForIssueComment({ ...base, resumeRequested: false, reopened: true, currentStatus: "todo" })).toBe(true);
    expect(shouldWakeAssigneeForIssueComment({ ...base, resumeRequested: true, reopened: false, currentStatus: "in_progress" })).toBe(true);
  });
});
