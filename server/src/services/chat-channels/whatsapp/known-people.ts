import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatEndpoints, chatIdentityLinks, companyMemberships } from "@paperclipai/db";
import type { ChatEndpointSetupState } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import { notifyChatCompanyAuthorityChange } from "../../chat-run-milestone-notifications.js";
import type { EndpointRecord, EndpointRow } from "../runtime-types.js";

/**
 * Pre-approved people for a WhatsApp channel: phone number -> Paperclip user.
 * When an unlinked sender's number matches, the first message creates a
 * normal identity link to that user (shown in the channel's People list and
 * removable there) and is processed as that user. It lets a team move from
 * another WhatsApp setup without each person confirming a link first.
 *
 * Only numbers match: a sender WhatsApp knows only by hidden id ("lid:...")
 * never does. A link an admin removed (revoked) is never recreated from the
 * list; remove the number from the list as well, or link the person again by
 * hand. Stored in the endpoint's setup JSON (no table, no migration).
 */
export const WHATSAPP_KNOWN_PEOPLE_MAX = 500;

export interface WhatsAppKnownPerson {
  /** E.164 digits, no "+". */
  phone: string;
  paperclipUserId: string;
}

type SetupWithKnownPeople = ChatEndpointSetupState & { whatsAppKnownPeople?: unknown };

/** Digits-only, de-duplicated (last entry for a number wins), bounded. */
export function normalizeWhatsAppKnownPeople(input: Array<{ phone: string; paperclipUserId: string }>): WhatsAppKnownPerson[] {
  if (input.length > WHATSAPP_KNOWN_PEOPLE_MAX) throw unprocessable(`At most ${WHATSAPP_KNOWN_PEOPLE_MAX} people can be pre-approved`);
  const byPhone = new Map<string, WhatsAppKnownPerson>();
  for (const entry of input) {
    const phone = String(entry.phone ?? "").replace(/\D+/g, "");
    if (phone.length < 6 || phone.length > 15) throw unprocessable(`Invalid WhatsApp number: ${String(entry.phone).slice(0, 32)}`);
    const userId = String(entry.paperclipUserId ?? "").trim();
    if (!userId || userId.length > 128) throw unprocessable("Each pre-approved number needs a Paperclip user");
    byPhone.delete(phone);
    byPhone.set(phone, { phone, paperclipUserId: userId });
  }
  return [...byPhone.values()];
}

/** The stored list, ignoring malformed entries. */
export function whatsAppKnownPeople(setup: ChatEndpointSetupState | null | undefined): WhatsAppKnownPerson[] {
  const raw = (setup as SetupWithKnownPeople | null | undefined)?.whatsAppKnownPeople;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { phone, paperclipUserId } = entry as Record<string, unknown>;
    return typeof phone === "string" && /^\d{6,15}$/.test(phone) && typeof paperclipUserId === "string" && paperclipUserId
      ? [{ phone, paperclipUserId }]
      : [];
  });
}

/** The entry for a sender's principal id; a hidden-id ("lid:") sender never matches. */
export function whatsAppKnownPersonFor(
  setup: ChatEndpointSetupState | null | undefined,
  externalId: string,
): WhatsAppKnownPerson | null {
  if (!/^\d{6,20}$/.test(externalId)) return null;
  return whatsAppKnownPeople(setup).find((entry) => entry.phone === externalId) ?? null;
}

type DbLike = Pick<Db, "select" | "update" | "insert" | "execute" | "transaction">;

async function activeMember(db: Pick<Db, "select">, companyId: string, userIds: string[]) {
  if (!userIds.length) return new Set<string>();
  const rows = await db
    .select({ userId: companyMemberships.principalId, role: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        inArray(companyMemberships.principalId, userIds),
      ),
    );
  // Viewers are read-only on external chat, so a link for them would act for no one.
  return new Set(rows.filter((row) => row.role !== "viewer").map((row) => row.userId));
}

/**
 * Inbound pass: link the sender to the pre-approved user, if the list names
 * the sender's number, the user is an active non-viewer member right now, and
 * no admin removed a link for this sender. Returns the linked user id, or null.
 */
export async function linkWhatsAppKnownPerson(
  db: DbLike,
  endpoint: EndpointRow,
  principal: { id: string; externalId: string },
): Promise<string | null> {
  if (endpoint.provider !== "whatsapp") return null;
  const entry = whatsAppKnownPersonFor(endpoint.setup, principal.externalId);
  if (!entry) return null;
  const linked = await db.transaction(async (tx) => {
    // Same identity key link confirmation and authorization use.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`chat-identity:${endpoint.companyId}:${principal.id}`}, 0))`);
    const [existing] = await tx
      .select({ status: chatIdentityLinks.status, userId: chatIdentityLinks.paperclipUserId })
      .from(chatIdentityLinks)
      .where(and(eq(chatIdentityLinks.endpointId, endpoint.id), eq(chatIdentityLinks.principalId, principal.id)))
      .for("update");
    if (existing?.status === "linked") return existing.userId;
    if (existing?.status === "revoked") return null;
    if (!(await activeMember(tx, endpoint.companyId, [entry.paperclipUserId])).has(entry.paperclipUserId)) return null;
    const [elsewhere] = await tx
      .select({ id: chatIdentityLinks.id })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.companyId, endpoint.companyId),
          eq(chatIdentityLinks.principalId, principal.id),
          eq(chatIdentityLinks.status, "linked"),
          ne(chatIdentityLinks.paperclipUserId, entry.paperclipUserId),
        ),
      )
      .limit(1);
    if (elsewhere) return null;
    const now = new Date();
    await notifyChatCompanyAuthorityChange(tx, { companyId: endpoint.companyId });
    await tx
      .insert(chatIdentityLinks)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        principalId: principal.id,
        paperclipUserId: entry.paperclipUserId,
        status: "linked",
        confirmedAt: now,
      })
      .onConflictDoUpdate({
        target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId],
        set: { paperclipUserId: entry.paperclipUserId, status: "linked", confirmationTokenHash: null, expiresAt: null, confirmedAt: now, updatedAt: now },
      });
    return entry.paperclipUserId;
  });
  if (linked === entry.paperclipUserId) {
    await logActivity(db as Db, {
      companyId: endpoint.companyId,
      actorType: "system",
      actorId: "whatsapp_known_people",
      action: "chat_identity_link.preapproved",
      entityType: "tool_connection",
      entityId: endpoint.connectionId,
      details: { endpointId: endpoint.id, principalId: principal.id, paperclipUserId: entry.paperclipUserId, source: "whatsapp_known_people" },
    }).catch(() => undefined);
  }
  return linked;
}

export function createWhatsAppKnownPeople(db: Db, options: { endpointRecord: (endpointId: string) => Promise<EndpointRecord | null> }) {
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
  async function replace(endpointId: string, input: { people: Array<{ phone: string; paperclipUserId: string }> }, actorUserId: string | null) {
    const endpoint = await whatsAppEndpoint(endpointId);
    const people = normalizeWhatsAppKnownPeople(input.people);
    const members = await activeMember(db, endpoint.companyId, [...new Set(people.map((p) => p.paperclipUserId))]);
    const refused = people.filter((p) => !members.has(p.paperclipUserId));
    if (refused.length)
      throw unprocessable("Every pre-approved number must belong to an active member of this company", {
        code: "whatsapp_known_people_not_members",
        phones: refused.map((p) => `+${p.phone}`),
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
    return { people };
  }

  return { list, replace };
}
