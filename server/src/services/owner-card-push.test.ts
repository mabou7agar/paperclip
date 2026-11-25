import { describe, expect, it } from "vitest";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import {
  chooseOwnerCardRecipients,
  isOwnerCardInteraction,
  ownerCardFallbackText,
  ownerCardPushEnabled,
} from "./owner-card-push.js";

const at = (iso: string) => new Date(iso);

describe("owner card addressee", () => {
  const candidates = [
    { endpointId: "e1", userId: "operator", membershipRole: "operator", confirmedAt: at("2026-01-01") },
    { endpointId: "e1", userId: "admin", membershipRole: "admin", confirmedAt: at("2026-01-02") },
    { endpointId: "e1", userId: "owner-late", membershipRole: "owner", confirmedAt: at("2026-03-01") },
    { endpointId: "e1", userId: "owner", membershipRole: "owner", confirmedAt: at("2026-02-01") },
    { endpointId: "e1", userId: "viewer", membershipRole: "viewer", confirmedAt: at("2025-01-01") },
    { endpointId: "e2", userId: "admin", membershipRole: "admin", confirmedAt: at("2026-01-02") },
  ];

  it("sends a board card to the earliest linked owner on each endpoint", () => {
    const chosen = chooseOwnerCardRecipients(candidates, { addresseeUserId: null, createdByUserId: null });
    expect(chosen.map((c) => [c.endpointId, c.userId])).toEqual([["e1", "owner"], ["e2", "admin"]]);
  });

  it("sends an addressed card only to the addressee", () => {
    const chosen = chooseOwnerCardRecipients(candidates, { addresseeUserId: "admin", createdByUserId: null });
    expect(chosen.map((c) => [c.endpointId, c.userId])).toEqual([["e1", "admin"], ["e2", "admin"]]);
    expect(chooseOwnerCardRecipients(candidates, { addresseeUserId: "nobody", createdByUserId: null })).toEqual([]);
  });

  it("never sends to a viewer or to the card's creator", () => {
    expect(chooseOwnerCardRecipients(candidates, { addresseeUserId: "viewer", createdByUserId: null })).toEqual([]);
    const chosen = chooseOwnerCardRecipients(candidates, { addresseeUserId: null, createdByUserId: "owner" });
    expect(chosen.find((c) => c.endpointId === "e1")?.userId).toBe("owner-late");
  });

  it("treats only pending human-addressed questions and confirmations as owner cards", () => {
    const base = { status: "pending", addresseeAgentId: null } as const;
    expect(isOwnerCardInteraction({ ...base, kind: "ask_user_questions" } as IssueThreadInteraction)).toBe(true);
    expect(isOwnerCardInteraction({ ...base, kind: "request_confirmation" } as IssueThreadInteraction)).toBe(true);
    expect(isOwnerCardInteraction({ ...base, kind: "suggest_tasks" } as IssueThreadInteraction)).toBe(false);
    expect(isOwnerCardInteraction({ ...base, kind: "ask_user_questions", addresseeAgentId: "a" } as unknown as IssueThreadInteraction)).toBe(false);
    expect(isOwnerCardInteraction({ ...base, kind: "ask_user_questions", status: "answered" } as unknown as IssueThreadInteraction)).toBe(false);
  });
});

describe("owner card push opt-out", () => {
  it("defaults on for Telegram and can be switched off in endpoint setup", () => {
    expect(ownerCardPushEnabled({ provider: "telegram", setup: { step: "complete" } })).toBe(true);
    expect(ownerCardPushEnabled({ provider: "telegram", setup: { step: "complete", ownerCardPush: true } })).toBe(true);
    expect(ownerCardPushEnabled({ provider: "telegram", setup: { step: "complete", ownerCardPush: false } })).toBe(false);
    expect(ownerCardPushEnabled({ provider: "slack", setup: { step: "complete" } })).toBe(false);
  });
});

describe("owner card fallback text", () => {
  it("lists every question and option with the console link", () => {
    const interaction = {
      kind: "ask_user_questions",
      status: "pending",
      summary: "Two choices block the release.",
      payload: {
        version: 1,
        title: "Release decisions",
        questions: [
          {
            id: "q1",
            prompt: "Which regions?",
            selectionMode: "multi",
            options: [
              { id: "eu", label: "EU" },
              { id: "us", label: "US", description: "after legal review" },
            ],
          },
          {
            id: "q2",
            prompt: "Release name?",
            helpText: "Shown to customers.",
            selectionMode: "single",
            allowOther: true,
            options: [
              { id: "a", label: "Aurora" },
              { id: "other", label: "Type a name", freeText: true },
            ],
          },
        ],
      },
    } as unknown as IssueThreadInteraction;
    const text = ownerCardFallbackText(interaction, "https://paperclip.example/issues/abc");
    expect(text.title).toBe("Release decisions");
    expect(text.body).toBe(
      [
        "Two choices block the release.",
        "1. Which regions?\n(choose one or more)\n- EU\n- US: after legal review",
        "2. Release name?\nShown to customers.\n- Aurora\n- Other (write your own answer)",
        "Answer in Paperclip: https://paperclip.example/issues/abc",
      ].join("\n\n"),
    );
  });

  it("shows a reject-with-reason confirmation's choices", () => {
    const interaction = {
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Ship the migration?", rejectRequiresReason: true, acceptLabel: "Ship" },
    } as unknown as IssueThreadInteraction;
    expect(ownerCardFallbackText(interaction, null)).toEqual({
      title: "Ship the migration?",
      body: "- Ship\n- Reject (with a reason)\n\nAnswer in Paperclip.",
    });
  });
});
