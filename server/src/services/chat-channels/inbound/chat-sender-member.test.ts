import { describe, expect, it } from "vitest";
import { chatSenderMemberRows } from "./authorization.js";

function fakeDb(rows: unknown[]) {
  const chain = { from: () => chain, leftJoin: () => chain, where: () => chain, limit: async () => rows };
  return { select: () => chain } as never;
}

describe("chatSenderMemberRows", () => {
  it("shows the member name and company role of a linked sender", async () => {
    await expect(chatSenderMemberRows(fakeDb([{ name: "Sara (Support)", role: "operator" }]), "c1", "u1")).resolves.toEqual([
      { type: "key_value", label: "Paperclip member", value: "Sara (Support)" },
      { type: "key_value", label: "Company role", value: "operator" },
    ]);
  });

  it("shows nothing for guests or unknown members", async () => {
    await expect(chatSenderMemberRows(fakeDb([{ name: "x", role: null }]), "c1", null)).resolves.toEqual([]);
    await expect(chatSenderMemberRows(fakeDb([]), "c1", "u1")).resolves.toEqual([]);
  });

  it("omits the role when the person has no membership in the company", async () => {
    await expect(chatSenderMemberRows(fakeDb([{ name: "Ali", role: null }]), "c1", "u1")).resolves.toEqual([
      { type: "key_value", label: "Paperclip member", value: "Ali" },
    ]);
  });
});
