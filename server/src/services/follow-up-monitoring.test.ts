import { describe, expect, it } from "vitest";
import {
  findOpenRegisterItems, findOwnerDecisionRequest, ownerDecisionInstruction, untrackedFollowUpsInstruction, untrackedRegisterItems,
} from "./follow-up-monitoring.js";

const gapRegister = `# OSA-474 closure and flag-enable gap register

Verification ran on the build machine. Results below.

| ID | Gap | State | Owner |
|----|-----|-------|-------|
| G1 | Arabic lesson player on Safari | NOT TESTED | QA |
| G2 | xAPI statement replay | PARTIAL | Backend |
| G3 | Rewards flag on tenant 8 | BLOCKED | DevOps |
| G4 | Leaderboard pagination | Done | Backend |
| G5 | Offline sync | **Follow-up** | Backend |
| G6 | Rate limit at 50 rps | Disclosed limit | Backend |
| G7 | Certificate PDF fonts | Waived by owner | Design |

The owner decides which items become follow-up tasks and which become waivers.
`;

describe("findOpenRegisterItems", () => {
  it("finds the open rows of a gap register named by its title, and skips done and waived rows", () => {
    const items = findOpenRegisterItems(gapRegister, "OSA-474 closure and flag-enable gap register");
    expect(items.map(item => [item.id, item.state])).toEqual([
      ["G1", "NOT TESTED"], ["G2", "PARTIAL"], ["G3", "BLOCKED"], ["G5", "Follow-up"], ["G6", "Disclosed limit"],
    ]);
  });

  it("reads only the register section under a matching heading", () => {
    const body = `## Summary\n\n| Step | State |\n|---|---|\n| Deploy | Pending |\n\n## Open items\n\n- [ ] G1 retest Safari\n- [x] G2 replay fixed\n- G3 rewards flag — BLOCKED on tenant access\n- Plain note without a state\n\n## Evidence\n\n- Screenshot OPEN in the viewer\n`;
    expect(findOpenRegisterItems(body).map(item => [item.id, item.state])).toEqual([["G1", "unchecked"], ["G3", "BLOCKED"]]);
  });

  it("reports nothing for documents without a register, or whose register is all closed", () => {
    expect(findOpenRegisterItems("# Release notes\n\n| Item | State |\n|---|---|\n| Login | BLOCKED |\n", "Release notes")).toEqual([]);
    expect(findOpenRegisterItems("## Gaps\n\n| ID | State |\n|---|---|\n| G1 | Done |\n| G2 | Waived |\n")).toEqual([]);
    // A long description cell that starts with "Blocked" is not a state cell.
    expect(findOpenRegisterItems("## Follow-ups\n\n| ID | Note |\n|---|---|\n| F1 | Blocked users can no longer sign in after the fix, verified on staging |\n"))
      .toEqual([]);
    // Lower-case words in prose bullets and "Opened" are not states.
    expect(findOpenRegisterItems("## Open items\n\n- the open question was answered\n- Opened the PR\n")).toEqual([]);
    // Registers quoted inside code blocks are examples, not work.
    expect(findOpenRegisterItems("## Notes\n\n```\n## Gaps\n| G1 | BLOCKED |\n```\n")).toEqual([]);
  });

  it("ignores the table header row", () => {
    expect(findOpenRegisterItems("## Gaps\n\n| Open | Pending |\n|---|---|\n| G1 | Done |\n")).toEqual([]);
  });
});

describe("untrackedRegisterItems", () => {
  const items = findOpenRegisterItems(gapRegister, "gap register");
  it("treats the items as tracked when there are at least as many child tasks", () => {
    expect(untrackedRegisterItems(items, ["a", "b", "c", "d", "e"])).toEqual([]);
  });
  it("leaves out items a child task names by id", () => {
    expect(untrackedRegisterItems(items, ["G1: retest Safari", "Follow-up g3 rewards flag"]).map(item => item.id))
      .toEqual(["G2", "G5", "G6"]);
    // G1 inside G10 or G12 is not a match.
    expect(untrackedRegisterItems(items, ["G12 something"]).map(item => item.id)).toEqual(["G1", "G2", "G3", "G5", "G6"]);
  });
  it("reports every item when no child task exists", () => {
    expect(untrackedRegisterItems(items, [])).toHaveLength(5);
  });
});

describe("untrackedFollowUpsInstruction", () => {
  it("lists the items and asks for one task per item or an owner question card", () => {
    const text = untrackedFollowUpsInstruction(findOpenRegisterItems(gapRegister, "gap register"), ['document "Gap register"']);
    expect(text).toContain("5 open items");
    expect(text).toContain("G3 | Rewards flag on tenant 8 | BLOCKED | DevOps (BLOCKED)");
    expect(text).toContain("create one follow-up task");
    expect(text).toContain("owner question card");
  });
});

describe("findOwnerDecisionRequest", () => {
  it("finds a decision handed to the owner", () => {
    expect(findOwnerDecisionRequest(gapRegister)).toBe("The owner decides");
    expect(findOwnerDecisionRequest("Both options are ready for the owner\u2019s decision.")).toBe("for the owner's decision");
    expect(findOwnerDecisionRequest("Parking this, awaiting owner sign-off on the price.")).toBe("awaiting owner");
    expect(findOwnerDecisionRequest("This needs owner approval before the flag is enabled.")).toBe("needs owner approval");
    expect(findOwnerDecisionRequest("Owner to decide between A and B.")).toBe("Owner to decide");
    expect(findOwnerDecisionRequest("Blocked: waiting on the owner for the tenant list.")).toBe("waiting on the owner");
  });

  it("ignores negations, decisions already made, quotes, code and unrelated owners", () => {
    expect(findOwnerDecisionRequest("No owner decision needed; I applied the default.")).toBeNull();
    expect(findOwnerDecisionRequest("This does not need owner approval.")).toBeNull();
    expect(findOwnerDecisionRequest("The owner's decision: ship G1 and waive G2.")).toBeNull();
    expect(findOwnerDecisionRequest("The owner's decision was to waive G2.")).toBeNull();
    expect(findOwnerDecisionRequest("Each merge stays the owner's decision; ask through the PM when a PR is ready.")).toBeNull();
    expect(findOwnerDecisionRequest("> The owner decides which items become tasks.\n\nFiled all five as tasks.")).toBeNull();
    expect(findOwnerDecisionRequest("```\nowner decides\n```")).toBeNull();
    expect(findOwnerDecisionRequest("The code owner reviewed the module; the file owner is the platform team.")).toBeNull();
  });

  it("asks for one card with concrete options, on a follow-up task when closed", () => {
    expect(ownerDecisionInstruction("owner decides", false)).toMatch(/raise one owner question card with concrete options, then wait/);
    expect(ownerDecisionInstruction("owner decides", true)).toContain("on a follow-up task, since this task is closed");
  });
});
