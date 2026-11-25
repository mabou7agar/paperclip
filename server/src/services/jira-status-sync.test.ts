import { describe, expect, it } from "vitest";
import {
  chooseJiraTransition,
  findJiraKeys,
  jiraBackoffMs,
  jiraSyncDecision,
  jiraSyncIdempotencyKey,
  parseJiraIssueStatus,
  parseJiraTransitions,
  type JiraTransition,
} from "./jira-status-sync.js";
import { builtInSystemIntegrationFor } from "./tool-access-policy.js";

const t = (id: string, toName: string, toCategory: JiraTransition["toCategory"]): JiraTransition => ({ id, name: toName, toName, toCategory });
const SCRUM = [t("11", "To Do", "new"), t("21", "In Progress", "indeterminate"), t("31", "In Review", "indeterminate"), t("41", "Done", "done")];
const SIMPLE = [t("1", "Open", "new"), t("2", "Doing", "indeterminate"), t("3", "Closed", "done")];

describe("findJiraKeys", () => {
  it("only matches learned project keys", () => {
    expect(findJiraKeys("Fix OS-1906 and AT-28; see G13, S1-S7, OSA-123 and os-5", ["OS", "AT"])).toEqual(["OS-1906", "AT-28"]);
  });
  it("matches browse URLs of the learned site and de-duplicates", () => {
    const text = "See https://osarh.atlassian.net/browse/QA-7 and OS-1 again OS-1, other https://evil.example/browse/ZZ-9";
    expect(findJiraKeys(text, ["OS"], ["osarh.atlassian.net"])).toEqual(["QA-7", "OS-1"]);
  });
  it("prefers the longer key and rejects embedded tokens", () => {
    expect(findJiraKeys("OSX-4 XOS-5 OS-6a OS-7", ["OS", "OSX"])).toEqual(["OSX-4", "OS-7"]);
  });
  it("returns nothing without keys or text", () => {
    expect(findJiraKeys("OS-1", [])).toEqual([]);
    expect(findJiraKeys(null, ["OS"])).toEqual([]);
  });
});

describe("chooseJiraTransition", () => {
  const current = (name: string, category: JiraTransition["toCategory"]) => ({ name, category });
  it("matches synonyms case-insensitively", () => {
    expect(chooseJiraTransition({ paperclipStatus: "in_progress", current: current("To Do", "new"), transitions: SCRUM }))
      .toMatchObject({ kind: "transition", transition: { id: "21" } });
    expect(chooseJiraTransition({ paperclipStatus: "done", current: current("Open", "new"), transitions: SIMPLE }))
      .toMatchObject({ kind: "transition", transition: { id: "3" } });
  });
  it("falls back to status category", () => {
    const custom = [t("5", "Backlog", "new"), t("6", "Working on it", "indeterminate"), t("7", "Shipped", "done")];
    expect(chooseJiraTransition({ paperclipStatus: "in_progress", current: current("Backlog", "new"), transitions: custom }))
      .toMatchObject({ kind: "transition", transition: { id: "6" } });
    expect(chooseJiraTransition({ paperclipStatus: "done", current: current("Backlog", "new"), transitions: custom }))
      .toMatchObject({ kind: "transition", transition: { id: "7" } });
  });
  it("uses an In Progress-like status for review when no review status exists", () => {
    expect(chooseJiraTransition({ paperclipStatus: "in_review", current: current("Open", "new"), transitions: SIMPLE }))
      .toMatchObject({ kind: "transition", transition: { id: "2" } });
  });
  it("does nothing when the issue is already there", () => {
    expect(chooseJiraTransition({ paperclipStatus: "in_progress", current: current("In Progress", "indeterminate"), transitions: SCRUM }))
      .toEqual({ kind: "already", statusName: "In Progress" });
  });
  it("comments instead of transitioning for blocked without a blocked status", () => {
    expect(chooseJiraTransition({ paperclipStatus: "blocked", current: current("In Progress", "indeterminate"), transitions: SCRUM, blockedReason: "waiting on PAP-2" }))
      .toEqual({ kind: "comment_only", comment: "Blocked in Paperclip: waiting on PAP-2" });
    expect(chooseJiraTransition({ paperclipStatus: "blocked", current: current("To Do", "new"), transitions: [...SCRUM, t("51", "Blocked", "indeterminate")] }))
      .toMatchObject({ kind: "transition", transition: { id: "51" } });
  });
  it("closes as done with a comment when cancelled has no own status", () => {
    expect(chooseJiraTransition({ paperclipStatus: "cancelled", current: current("To Do", "new"), transitions: SCRUM }))
      .toEqual({ kind: "transition", transition: SCRUM[3], comment: "Cancelled in Paperclip (not delivered)." });
    expect(chooseJiraTransition({ paperclipStatus: "cancelled", current: current("To Do", "new"), transitions: [...SCRUM, t("61", "Won't Do", "done")] }))
      .toMatchObject({ kind: "transition", transition: { id: "61" } });
  });
  it("reports no transition rather than guessing", () => {
    expect(chooseJiraTransition({ paperclipStatus: "done", current: current("To Do", "new"), transitions: [t("21", "In Progress", "indeterminate")] }))
      .toEqual({ kind: "none", reason: "no transition to done from To Do" });
  });
});

describe("jiraSyncDecision", () => {
  const now = new Date("2026-11-25T10:00:00Z");
  it("skips a link already synced for this status change, even if Jira moved since", () => {
    expect(jiraSyncDecision({ lastSyncedStatus: "in_progress", lastSyncedStatusVersion: 3, lastJiraStatus: "Done" }, { status: "in_progress", statusVersion: 3 }, now)).toBe("synced");
  });
  it("syncs a new status change", () => {
    expect(jiraSyncDecision({ lastSyncedStatus: "in_progress", lastSyncedStatusVersion: 3, lastSyncedAt: "x" }, { status: "done", statusVersion: 4 }, now)).toBe("sync");
  });
  it("takes a not-started task as baseline on a new link", () => {
    expect(jiraSyncDecision({}, { status: "todo", statusVersion: 1 }, now)).toBe("baseline");
    expect(jiraSyncDecision({}, { status: "in_progress", statusVersion: 1 }, now)).toBe("sync");
  });
  it("backs off only for the change that failed", () => {
    const meta = { lastSyncedStatus: "todo", lastSyncedStatusVersion: 1, lastSyncedAt: "x", attemptKey: "2:in_progress", nextAttemptAt: "2026-11-25T10:05:00Z" };
    expect(jiraSyncDecision(meta, { status: "in_progress", statusVersion: 2 }, now)).toBe("backoff");
    expect(jiraSyncDecision(meta, { status: "done", statusVersion: 3 }, now)).toBe("sync");
    expect(jiraSyncDecision(meta, { status: "in_progress", statusVersion: 2 }, new Date("2026-11-25T10:06:00Z"))).toBe("sync");
  });
  it("builds stable keys and growing backoff", () => {
    expect(jiraSyncIdempotencyKey("L1", { status: "done", statusVersion: 7 })).toBe("jira-status:L1:7:done");
    expect([1, 2, 3, 4, 5, 9].map(jiraBackoffMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000]);
  });
});

describe("Jira result parsing", () => {
  it("reads transitions and status from MCP text content", () => {
    const transitions = { content: JSON.stringify({ transitions: [{ id: "21", name: "Start", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } }] }) };
    expect(parseJiraTransitions(transitions)).toEqual([{ id: "21", name: "Start", toName: "In Progress", toCategory: "indeterminate" }]);
    const issue = { content: "", data: { structuredContent: { fields: { status: { name: "To Do", statusCategory: { key: "new" } } } } } };
    expect(parseJiraIssueStatus(issue)).toEqual({ name: "To Do", category: "new" });
  });
});

describe("built-in system integration policy", () => {
  const base = { actorType: "system", actorId: "jira_status_sync", agentId: null, heartbeatRunId: null, gatewayId: null,
    connectionId: "c1", upstreamToolName: "transitionJiraIssue", riskLevel: "write" };
  it("allows only the sync's own tools at read or write risk", () => {
    expect(builtInSystemIntegrationFor(base)).toBe("jira_status_sync");
    expect(builtInSystemIntegrationFor({ ...base, upstreamToolName: "deleteJiraIssue" })).toBeNull();
    expect(builtInSystemIntegrationFor({ ...base, riskLevel: "destructive" })).toBeNull();
  });
  it("rejects any other principal", () => {
    expect(builtInSystemIntegrationFor({ ...base, actorType: "agent" })).toBeNull();
    expect(builtInSystemIntegrationFor({ ...base, actorId: "other" })).toBeNull();
    expect(builtInSystemIntegrationFor({ ...base, actorId: "toString" })).toBeNull();
    expect(builtInSystemIntegrationFor({ ...base, agentId: "a1" })).toBeNull();
    expect(builtInSystemIntegrationFor({ ...base, gatewayId: "g1" })).toBeNull();
    expect(builtInSystemIntegrationFor(base, { gatewayTokenId: "t1" })).toBeNull();
    expect(builtInSystemIntegrationFor({ ...base, connectionId: null })).toBeNull();
  });
});
