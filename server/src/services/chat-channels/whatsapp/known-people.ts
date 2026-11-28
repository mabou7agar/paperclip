import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatEndpoints } from "@paperclipai/db";
import type { ChatEndpointSetupState } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import { notifyChatCompanyAuthorityChange } from "../../chat-run-milestone-notifications.js";
import { normalizeWhatsAppUsername } from "../../whatsapp/parse.js";
import { KNOWN_PEOPLE_MAX, activeNonViewerMembers, linkPreapprovedPerson, type KnownPeopleDb } from "../known-people.js";
import type { EndpointRecord, EndpointRow } from "../runtime-types.js";

/**
 * Pre-approved people for a WhatsApp channel: phone number and/or WhatsApp
 * username -> Paperclip user. When an unlinked sender matches, the first
 * message creates a normal identity link to that user (shared rules in
 * ../known-people.ts) and is processed as that user. It lets a team move from
 * another WhatsApp setup without each person confirming a link first.
 *
 * Matching order: the sender's number (which the sidecar also fills in for a
 * hidden id it resolved from a pre-approved number), then the sender's
 * username. A username only counts when WhatsApp itself asserted it (the
 * sidecar's `fromUsername`, from the group stanza or WhatsApp's answer to a
 * username lookup), never from the display name. A sender known only by
 * hidden id and without a username never matches. Stored in the endpoint's
 * setup JSON (no table, no migration).
 */
export const WHATSAPP_KNOWN_PEOPLE_MAX = KNOWN_PEOPLE_MAX;

export interface WhatsAppKnownPerson {
  /** E.164 digits, no "+". */
  phone?: string;
  /** WhatsApp username, lowercase, no "@". */
  username?: string;
  paperclipUserId: string;
}

type SetupWithKnownPeople = ChatEndpointSetupState & { whatsAppKnownPeople?: unknown };

/** Digits-only numbers, lowercase usernames, de-duplicated (last entry for a number or username wins), bounded. */
export function normalizeWhatsAppKnownPeople(input: Array<{ phone?: string; username?: string; paperclipUserId: string }>): WhatsAppKnownPerson[] {
  if (input.length > WHATSAPP_KNOWN_PEOPLE_MAX) throw unprocessable(`At most ${WHATSAPP_KNOWN_PEOPLE_MAX} people can be pre-approved`);
  const people: WhatsAppKnownPerson[] = [];
  for (const entry of input) {
    const rawPhone = entry.phone === undefined || entry.phone === null ? "" : String(entry.phone);
    const phone = rawPhone.replace(/\D+/g, "");
    if (rawPhone && (phone.length < 6 || phone.length > 15)) throw unprocessable(`Invalid WhatsApp number: ${rawPhone.slice(0, 32)}`);
    const hasUsername = entry.username !== undefined && entry.username !== null && String(entry.username).trim() !== "";
    const username = hasUsername ? normalizeWhatsAppUsername(entry.username) : null;
    if (hasUsername && !username) throw unprocessable(`Invalid WhatsApp username: ${String(entry.username).slice(0, 40)}`);
    if (!phone && !username) throw unprocessable("Each pre-approved person needs a WhatsApp number or username");
    const userId = String(entry.paperclipUserId ?? "").trim();
    if (!userId || userId.length > 128) throw unprocessable("Each pre-approved number needs a Paperclip user");
    for (let index = people.length - 1; index >= 0; index--)
      if ((phone && people[index]!.phone === phone) || (username && people[index]!.username === username)) people.splice(index, 1);
    people.push({ ...(phone ? { phone } : {}), ...(username ? { username } : {}), paperclipUserId: userId });
  }
  return people;
}

/** The stored list, ignoring malformed entries. */
export function whatsAppKnownPeople(setup: ChatEndpointSetupState | null | undefined): WhatsAppKnownPerson[] {
  const raw = (setup as SetupWithKnownPeople | null | undefined)?.whatsAppKnownPeople;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { phone, username, paperclipUserId } = entry as Record<string, unknown>;
    const validPhone = typeof phone === "string" && /^\d{6,15}$/.test(phone) ? phone : null;
    const validUsername = typeof username === "string" && normalizeWhatsAppUsername(username) === username ? username : null;
    if ((!validPhone && !validUsername) || typeof paperclipUserId !== "string" || !paperclipUserId) return [];
    return [{ ...(validPhone ? { phone: validPhone } : {}), ...(validUsername ? { username: validUsername } : {}), paperclipUserId }];
  });
}

/**
 * The entry for a sender: by number first (the principal id is the number), then
 * by the username WhatsApp asserted. A hidden-id ("lid:") sender without a
 * username never matches.
 */
export function whatsAppKnownPersonFor(
  setup: ChatEndpointSetupState | null | undefined,
  externalId: string,
  username?: string | null,
): WhatsAppKnownPerson | null {
  const people = whatsAppKnownPeople(setup);
  if (/^\d{6,20}$/.test(externalId)) {
    const byPhone = people.find((entry) => entry.phone === externalId);
    if (byPhone) return byPhone;
  }
  const name = username ? normalizeWhatsAppUsername(username) : null;
  return name ? people.find((entry) => entry.username === name) ?? null : null;
}

/** The username the sidecar asserted on a signed event, or null. */
export function whatsAppUsernameFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  return normalizeWhatsAppUsername((raw as { fromUsername?: unknown }).fromUsername);
}

/**
 * Inbound pass: link the sender to the pre-approved user, if the list names the
 * sender's number or WhatsApp-asserted username, the user is an active
 * non-viewer member right now, and no admin removed a link for this sender.
 * Returns the linked user id, or null.
 */
export async function linkWhatsAppKnownPerson(
  db: KnownPeopleDb,
  endpoint: EndpointRow,
  principal: { id: string; externalId: string },
  raw?: unknown,
): Promise<string | null> {
  if (endpoint.provider !== "whatsapp") return null;
  const username = whatsAppUsernameFromRaw(raw);
  const entry = whatsAppKnownPersonFor(endpoint.setup, principal.externalId, username);
  if (!entry) return null;
  const matchedBy = entry.phone && entry.phone === principal.externalId ? "phone" : "username";
  return linkPreapprovedPerson(db, endpoint, principal, entry.paperclipUserId, { source: "whatsapp_known_people", matchedBy });
}

export function createWhatsAppKnownPeople(db: Db, options: {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  /**
   * Hand the numbers and usernames to the sidecar so hidden-id senders resolve
   * to them, and turn on group delivery (client groups); best effort.
   */
  syncPhones?: (accountId: string, phones: string[], extra: { usernames: string[]; groups: boolean }) => Promise<unknown>;
}) {
  /** Best effort: a channel that is not linked yet syncs when it links. */
  async function sync(endpoint: { publicId: string }, people: WhatsAppKnownPerson[]) {
    if (!options.syncPhones) return false;
    try {
      await options.syncPhones(
        endpoint.publicId,
        people.flatMap((p) => (p.phone ? [p.phone] : [])),
        { usernames: people.flatMap((p) => (p.username ? [p.username] : [])), groups: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  async function whatsAppEndpoint(endpointId: string) {
    const record = await options.endpointRecord(endpointId);
    if (!record || record.endpoint.provider !== "whatsapp") throw notFound("WhatsApp channel not found");
    if (record.endpoint.status === "archived") throw conflict("This WhatsApp channel was removed", { code: "chat_endpoint_archived" });
    return record.endpoint;
  }

  async function list(endpointId: string) {
    const endpoint = await whatsAppEndpoint(endpointId);
    return { people: whatsAppKnownPeople(endpoint.setup) };
  }

  /** Replace the list. Every user must be an active, non-viewer member of the channel's company. */
  async function replace(endpointId: string, input: { people: Array<{ phone?: string; username?: string; paperclipUserId: string }> }, actorUserId: string | null) {
    const endpoint = await whatsAppEndpoint(endpointId);
    const people = normalizeWhatsAppKnownPeople(input.people);
    const members = await activeNonViewerMembers(db, endpoint.companyId, [...new Set(people.map((p) => p.paperclipUserId))]);
    const refused = people.filter((p) => !members.has(p.paperclipUserId));
    if (refused.length)
      throw unprocessable("Every pre-approved number must belong to an active member of this company", {
        code: "whatsapp_known_people_not_members",
        phones: refused.map((p) => (p.phone ? `+${p.phone}` : `@${p.username}`)),
      });
    await db.transaction(async (tx) => {
      const [current] = await tx.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id)).for("update");
      if (!current) throw notFound("WhatsApp channel not found");
      await tx
        .update(chatEndpoints)
        .set({ setup: { ...current.setup, whatsAppKnownPeople: people } as ChatEndpointSetupState, updatedAt: new Date() })
        .where(eq(chatEndpoints.id, endpoint.id));
      if (people.length) await notifyChatCompanyAuthorityChange(tx, { companyId: endpoint.companyId });
    });
    await logActivity(db, {
      companyId: endpoint.companyId,
      actorType: "user",
      actorId: actorUserId ?? "board",
      action: "chat_endpoint.whatsapp_known_people_updated",
      entityType: "tool_connection",
      entityId: endpoint.connectionId,
      details: { endpointId: endpoint.id, count: people.length },
    });
    const synced = await sync(endpoint, people);
    return { people, synced };
  }

  /** After a number links: give the sidecar the stored list. */
  async function syncStored(endpointId: string) {
    const endpoint = await whatsAppEndpoint(endpointId);
    return sync(endpoint, whatsAppKnownPeople(endpoint.setup));
  }

  return { list, replace, syncStored };
}
