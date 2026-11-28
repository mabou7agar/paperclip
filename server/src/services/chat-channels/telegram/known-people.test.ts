import { describe, expect, it } from "vitest";
import {
  linkTelegramKnownPerson,
  normalizeTelegramKnownPeople,
  telegramKnownPersonFor,
  telegramSenderFromRaw,
  telegramSenderMetadata,
} from "./known-people.js";
import { telegramGuidanceCommand } from "./commands.js";

describe("Telegram pre-approved people", () => {
  const setup = (people: unknown) => ({ step: "complete", telegramKnownPeople: people }) as never;

  it("normalizes usernames case-insensitively and accepts user ids", () => {
    expect(normalizeTelegramKnownPeople([
      { username: "@Lead_Dev", paperclipUserId: "u1" },
      { telegramUserId: "123456", paperclipUserId: "u2" },
      { username: "LEAD_DEV", paperclipUserId: "u3" },
    ])).toEqual([
      { telegramUserId: "123456", paperclipUserId: "u2" },
      { username: "lead_dev", paperclipUserId: "u3" },
    ]);
    expect(() => normalizeTelegramKnownPeople([{ paperclipUserId: "u1" }])).toThrow(/username or user id/);
    expect(() => normalizeTelegramKnownPeople([{ username: "ab", paperclipUserId: "u1" }])).toThrow(/username/);
    expect(() => normalizeTelegramKnownPeople([{ telegramUserId: "12a", paperclipUserId: "u1" }])).toThrow(/user id/);
  });

  it("matches by user id first, by username otherwise, and a username with a recorded id only by that id", () => {
    const people = setup([
      { username: "lead_dev", paperclipUserId: "u1" },
      { username: "moved_name", telegramUserId: "111", paperclipUserId: "u2" },
      { telegramUserId: "222", paperclipUserId: "u3" },
    ]);
    expect(telegramKnownPersonFor(people, { id: "999", username: "lead_dev" })).toEqual({ entry: { username: "lead_dev", paperclipUserId: "u1" }, matchedBy: "username" });
    expect(telegramKnownPersonFor(people, { id: "222", username: null })).toMatchObject({ matchedBy: "user_id", entry: { paperclipUserId: "u3" } });
    // Someone else who now holds "moved_name" does not match: the entry recorded user 111.
    expect(telegramKnownPersonFor(people, { id: "333", username: "moved_name" })).toBeNull();
    expect(telegramKnownPersonFor(people, { id: "111", username: "renamed" })).toMatchObject({ matchedBy: "user_id", entry: { paperclipUserId: "u2" } });
  });

  it("reads the sender from the signed update and shows the username row", () => {
    const raw = { from: { id: 4242, username: "Lead_Dev", first_name: "Lea", is_bot: false } };
    expect(telegramSenderFromRaw(raw)).toEqual({ id: "4242", username: "lead_dev" });
    expect(telegramSenderFromRaw({ from: { id: 1, username: "some_bot", is_bot: true } })).toEqual({ id: null, username: null });
    expect(telegramSenderMetadata(raw)).toEqual([{ type: "key_value", label: "Username", value: "@lead_dev" }]);
    expect(telegramSenderMetadata({ from: { id: 1, first_name: "No username" } })).toEqual([]);
  });

  /** Selects in order: existing link, membership, conflicting link, then the setup row for recording the id. */
  function fakeDb(selects: unknown[][]) {
    const inserted: unknown[] = [];
    const updates: unknown[] = [];
    const queue = [...selects];
    const chain = (): unknown => {
      const rows = queue.shift() ?? [];
      const node: Record<string, unknown> = {};
      for (const key of ["from", "where", "for", "limit", "innerJoin", "leftJoin"]) node[key] = () => node;
      node.then = (resolve: (value: unknown) => unknown) => resolve(rows);
      return node;
    };
    const tx = {
      execute: async () => undefined,
      select: () => chain(),
      insert: () => ({ values: (value: unknown) => { inserted.push(value); return { onConflictDoUpdate: async () => undefined }; } }),
      update: () => ({ set: (value: unknown) => { updates.push(value); return { where: async () => undefined }; } }),
    };
    return { db: { ...tx, transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) }, inserted, updates };
  }
  const endpoint = (people: unknown) => ({ id: "endpoint", companyId: "company", connectionId: "connection", provider: "telegram", setup: { step: "complete", telegramKnownPeople: people } });

  it("links a listed username to an active member and records the user id on the entry", async () => {
    const list = [{ username: "lead_dev", paperclipUserId: "u1" }];
    const f = fakeDb([[], [{ userId: "u1", role: "member" }], [], [{ setup: { step: "complete", telegramKnownPeople: list } }]]);
    const linked = await linkTelegramKnownPerson(f.db as never, endpoint(list) as never, { id: "principal", externalId: "4242" }, { from: { id: 4242, username: "Lead_Dev" } });
    expect(linked).toBe("u1");
    expect(f.inserted.filter((row) => (row as { principalId?: unknown }).principalId)).toEqual([expect.objectContaining({ principalId: "principal", paperclipUserId: "u1", status: "linked" })]);
    expect(f.updates.some((value) => JSON.stringify(value).includes('"telegramUserId":"4242"'))).toBe(true);
  });

  it("never links a non-member, a viewer, a removed link or a mismatched sender", async () => {
    const list = [{ username: "lead_dev", paperclipUserId: "u1" }];
    const raw = { from: { id: 4242, username: "lead_dev" } };
    const outsider = fakeDb([[], []]);
    expect(await linkTelegramKnownPerson(outsider.db as never, endpoint(list) as never, { id: "p", externalId: "4242" }, raw)).toBeNull();
    const viewer = fakeDb([[], [{ userId: "u1", role: "viewer" }]]);
    expect(await linkTelegramKnownPerson(viewer.db as never, endpoint(list) as never, { id: "p", externalId: "4242" }, raw)).toBeNull();
    const removed = fakeDb([[{ status: "revoked", userId: "u1" }]]);
    expect(await linkTelegramKnownPerson(removed.db as never, endpoint(list) as never, { id: "p", externalId: "4242" }, raw)).toBeNull();
    const mismatched = fakeDb([]);
    expect(await linkTelegramKnownPerson(mismatched.db as never, endpoint(list) as never, { id: "p", externalId: "999" }, raw)).toBeNull();
    for (const f of [outsider, viewer, removed, mismatched]) expect(f.inserted.filter((row) => (row as { principalId?: unknown }).principalId)).toEqual([]);
  });

  it("keeps /client out of the Telegram guidance replies", () => {
    expect(telegramGuidanceCommand("/client Academy X | 42")).toBeNull();
    expect(telegramGuidanceCommand("/client@osarh_bot")).toBeNull();
    expect(telegramGuidanceCommand("/whatever")).toBe("unknown");
  });
});
