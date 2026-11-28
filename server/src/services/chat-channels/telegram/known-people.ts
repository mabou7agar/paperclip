import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatEndpoints } from "@paperclipai/db";
import type { ChatEndpointSetupState } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import { notifyChatCompanyAuthorityChange } from "../../chat-run-milestone-notifications.js";
import { KNOWN_PEOPLE_MAX, activeNonViewerMembers, linkPreapprovedPerson, type KnownPeopleDb } from "../known-people.js";
import type { EndpointRecord, EndpointRow } from "../runtime-types.js";

/**
 * Pre-approved people for a Telegram channel: Telegram username and/or numeric
 * user id -> Paperclip user, with the same rules as WhatsApp's list (shared in
 * ../known-people.ts). Telegram principals are keyed by the numeric user id;
 * the username comes from the signed Telegram update (`from.username`) and is
 * matched case-insensitively. A username can change hands, so the first match
 * records the user id on the entry and from then on only that id matches.
 * Stored in the endpoint's setup JSON (no table, no migration).
 */
export interface TelegramKnownPerson {
  /** Lowercase, no "@". */
  username?: string;
  /** Numeric Telegram user id. */
  telegramUserId?: string;
  paperclipUserId: string;
}

type SetupWithKnownPeople = ChatEndpointSetupState & { telegramKnownPeople?: unknown };

const TELEGRAM_USERNAME = /^[a-z][a-z0-9_]{4,31}$/;
const TELEGRAM_USER_ID = /^\d{1,20}$/;

export function normalizeTelegramUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^@/, "").toLowerCase();
  return TELEGRAM_USERNAME.test(name) ? name : null;
}

export function normalizeTelegramKnownPeople(input: Array<{ username?: string; telegramUserId?: string; paperclipUserId: string }>): TelegramKnownPerson[] {
  if (input.length > KNOWN_PEOPLE_MAX) throw unprocessable(`At most ${KNOWN_PEOPLE_MAX} people can be pre-approved`);
  const people: TelegramKnownPerson[] = [];
  for (const entry of input) {
    const hasUsername = typeof entry.username === "string" && entry.username.trim() !== "";
    const username = hasUsername ? normalizeTelegramUsername(entry.username) : null;
    if (hasUsername && !username) throw unprocessable(`Invalid Telegram username: ${String(entry.username).slice(0, 40)}`);
    const id = typeof entry.telegramUserId === "string" ? entry.telegramUserId.trim() : "";
    if (id && !TELEGRAM_USER_ID.test(id)) throw unprocessable(`Invalid Telegram user id: ${id.slice(0, 24)}`);
    if (!username && !id) throw unprocessable("Each pre-approved person needs a Telegram username or user id");
    const userId = String(entry.paperclipUserId ?? "").trim();
    if (!userId || userId.length > 128) throw unprocessable("Each pre-approved person needs a Paperclip user");
    for (let index = people.length - 1; index >= 0; index--)
      if ((username && people[index]!.username === username) || (id && people[index]!.telegramUserId === id)) people.splice(index, 1);
    people.push({ ...(username ? { username } : {}), ...(id ? { telegramUserId: id } : {}), paperclipUserId: userId });
  }
  return people;
}

export function telegramKnownPeople(setup: ChatEndpointSetupState | null | undefined): TelegramKnownPerson[] {
  const raw = (setup as SetupWithKnownPeople | null | undefined)?.telegramKnownPeople;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { username, telegramUserId, paperclipUserId } = entry as Record<string, unknown>;
    const validUsername = typeof username === "string" && TELEGRAM_USERNAME.test(username) ? username : null;
    const validId = typeof telegramUserId === "string" && TELEGRAM_USER_ID.test(telegramUserId) ? telegramUserId : null;
    if ((!validUsername && !validId) || typeof paperclipUserId !== "string" || !paperclipUserId) return [];
    return [{ ...(validUsername ? { username: validUsername } : {}), ...(validId ? { telegramUserId: validId } : {}), paperclipUserId }];
  });
}

/** The sender of a Telegram update (message or command): numeric id and username. */
export function telegramSenderFromRaw(raw: unknown): { id: string | null; username: string | null } {
  const from = raw && typeof raw === "object" ? (raw as { from?: unknown }).from : null;
  if (!from || typeof from !== "object") return { id: null, username: null };
  const { id, username, is_bot: isBot } = from as { id?: unknown; username?: unknown; is_bot?: unknown };
  if (isBot === true) return { id: null, username: null };
  return {
    id: typeof id === "number" || (typeof id === "string" && TELEGRAM_USER_ID.test(id)) ? String(id) : null,
    username: normalizeTelegramUsername(username),
  };
}

/**
 * The entry for a sender: by user id first, then by username, but a username
 * entry that already recorded a user id only matches that id.
 */
export function telegramKnownPersonFor(
  setup: ChatEndpointSetupState | null | undefined,
  sender: { id: string | null; username: string | null },
): { entry: TelegramKnownPerson; matchedBy: "user_id" | "username" } | null {
  const people = telegramKnownPeople(setup);
  if (sender.id) {
    const byId = people.find((entry) => entry.telegramUserId === sender.id);
    if (byId) return { entry: byId, matchedBy: "user_id" };
  }
  if (sender.username) {
    const byName = people.find((entry) => entry.username === sender.username && !entry.telegramUserId);
    if (byName) return { entry: byName, matchedBy: "username" };
  }
  return null;
}

/** Sender rows for a Telegram inbound message: the username, when the sender has one. */
export function telegramSenderMetadata(raw: unknown): Array<{ type: "key_value"; label: string; value: string }> {
  const { username } = telegramSenderFromRaw(raw);
  return username ? [{ type: "key_value", label: "Username", value: `@${username}` }] : [];
}

/**
 * Inbound pass for Telegram, like WhatsApp's: link the sender to the listed
 * user. On a username match the user id is recorded on the entry so a later
 * holder of the same username cannot match.
 */
export async function linkTelegramKnownPerson(
  db: KnownPeopleDb,
  endpoint: EndpointRow,
  principal: { id: string; externalId: string },
  raw?: unknown,
): Promise<string | null> {
  if (endpoint.provider !== "telegram") return null;
  const sender = telegramSenderFromRaw(raw);
  // The principal id is the numeric user id; never trust a raw id that disagrees with it.
  if (sender.id && sender.id !== principal.externalId) return null;
  const found = telegramKnownPersonFor(endpoint.setup, { id: principal.externalId, username: sender.username });
  if (!found) return null;
  const linked = await linkPreapprovedPerson(db, endpoint, principal, found.entry.paperclipUserId, { source: "telegram_known_people", matchedBy: found.matchedBy });
  if (linked === found.entry.paperclipUserId && found.matchedBy === "username" && TELEGRAM_USER_ID.test(principal.externalId)) {
    await recordTelegramUserId(db, endpoint.id, found.entry.username!, principal.externalId).catch(() => undefined);
  }
  return linked;
}

async function recordTelegramUserId(db: KnownPeopleDb, endpointId: string, username: string, telegramUserId: string) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)).for("update");
    if (!current) return;
    const people = telegramKnownPeople(current.setup).map((entry) =>
      entry.username === username && !entry.telegramUserId ? { ...entry, telegramUserId } : entry,
    );
    await tx
      .update(chatEndpoints)
      .set({ setup: { ...current.setup, telegramKnownPeople: people } as ChatEndpointSetupState, updatedAt: new Date() })
      .where(eq(chatEndpoints.id, endpointId));
  });
}

export function createTelegramKnownPeople(db: Db, options: { endpointRecord: (endpointId: string) => Promise<EndpointRecord | null> }) {
  async function telegramEndpoint(endpointId: string) {
    const record = await options.endpointRecord(endpointId);
    if (!record || record.endpoint.provider !== "telegram") throw notFound("Telegram channel not found");
    if (record.endpoint.status === "archived") throw conflict("This Telegram channel was removed", { code: "chat_endpoint_archived" });
    return record.endpoint;
  }

  async function list(endpointId: string) {
    const endpoint = await telegramEndpoint(endpointId);
    return { people: telegramKnownPeople(endpoint.setup) };
  }

  /** Replace the list. Every user must be an active, non-viewer member of the channel's company. */
  async function replace(
    endpointId: string,
    input: { people: Array<{ username?: string; telegramUserId?: string; paperclipUserId: string }> },
    actorUserId: string | null,
  ) {
    const endpoint = await telegramEndpoint(endpointId);
    const people = normalizeTelegramKnownPeople(input.people);
    const members = await activeNonViewerMembers(db, endpoint.companyId, [...new Set(people.map((p) => p.paperclipUserId))]);
    const refused = people.filter((p) => !members.has(p.paperclipUserId));
    if (refused.length)
      throw unprocessable("Every pre-approved person must be an active member of this company", {
        code: "telegram_known_people_not_members",
        people: refused.map((p) => (p.username ? `@${p.username}` : p.telegramUserId)),
      });
    await db.transaction(async (tx) => {
      const [current] = await tx.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)).for("update");
      if (!current) throw notFound("Telegram channel not found");
      await tx
        .update(chatEndpoints)
        .set({ setup: { ...current.setup, telegramKnownPeople: people } as ChatEndpointSetupState, updatedAt: new Date() })
        .where(eq(chatEndpoints.id, endpoint.id));
      if (people.length) await notifyChatCompanyAuthorityChange(tx, { companyId: endpoint.companyId });
    });
    await logActivity(db, {
      companyId: endpoint.companyId,
      actorType: "user",
      actorId: actorUserId ?? "board",
      action: "chat_endpoint.telegram_known_people_updated",
      entityType: "tool_connection",
      entityId: endpoint.connectionId,
      details: { endpointId: endpoint.id, count: people.length },
    });
    return { people };
  }

  return { list, replace };
}
