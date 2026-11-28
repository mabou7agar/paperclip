import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatIdentityLinks, companyMemberships } from "@paperclipai/db";
import { logActivity } from "../activity-log.js";
import { notifyChatCompanyAuthorityChange } from "../chat-run-milestone-notifications.js";
import type { EndpointRow } from "./runtime-types.js";

/**
 * Pre-approved people, shared by WhatsApp (number or username) and Telegram
 * (username or user id). When an unlinked sender matches an entry, the first
 * message creates a normal identity link to the entry's Paperclip user (shown
 * in the channel's People list and removable there) and is processed as that
 * user. The rules are the same for every provider:
 *  - only active, non-viewer members of the channel's company are linked;
 *  - a link an admin removed (revoked) is never recreated from the list;
 *  - a sender already linked to another user is left alone;
 *  - every link made this way is recorded as `chat_identity_link.preapproved`.
 * Each provider decides what "matches" means; nothing here reads display names.
 */
export const KNOWN_PEOPLE_MAX = 500;

export type KnownPeopleDb = Pick<Db, "select" | "update" | "insert" | "execute" | "transaction">;

/** Active, non-viewer members among the given users. */
export async function activeNonViewerMembers(db: Pick<Db, "select">, companyId: string, userIds: string[]) {
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
 * Link the sender's principal to `paperclipUserId` under the rules above.
 * Returns the linked user id, or null when nothing was linked.
 */
export async function linkPreapprovedPerson(
  db: KnownPeopleDb,
  endpoint: EndpointRow,
  principal: { id: string },
  paperclipUserId: string,
  audit: { source: string; matchedBy: string },
): Promise<string | null> {
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
    if (!(await activeNonViewerMembers(tx, endpoint.companyId, [paperclipUserId])).has(paperclipUserId)) return null;
    const [elsewhere] = await tx
      .select({ id: chatIdentityLinks.id })
      .from(chatIdentityLinks)
      .where(
        and(
          eq(chatIdentityLinks.companyId, endpoint.companyId),
          eq(chatIdentityLinks.principalId, principal.id),
          eq(chatIdentityLinks.status, "linked"),
          ne(chatIdentityLinks.paperclipUserId, paperclipUserId),
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
        paperclipUserId,
        status: "linked",
        confirmedAt: now,
      })
      .onConflictDoUpdate({
        target: [chatIdentityLinks.endpointId, chatIdentityLinks.principalId],
        set: { paperclipUserId, status: "linked", confirmationTokenHash: null, expiresAt: null, confirmedAt: now, updatedAt: now },
      });
    return paperclipUserId;
  });
  if (linked === paperclipUserId) {
    await logActivity(db as Db, {
      companyId: endpoint.companyId,
      actorType: "system",
      actorId: audit.source,
      action: "chat_identity_link.preapproved",
      entityType: "tool_connection",
      entityId: endpoint.connectionId,
      details: { endpointId: endpoint.id, principalId: principal.id, paperclipUserId, source: audit.source, matchedBy: audit.matchedBy },
    }).catch(() => undefined);
  }
  return linked;
}
