import { and, eq, gt, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
} from "@paperclipai/db";
import type { ChatEndpointSetupState, IssueThreadInteraction } from "@paperclipai/shared";
import { whatsAppThreadId } from "./whatsapp/parse.js";

/**
 * Owner card push delivers pending owner question cards (ask_user_questions and
 * request_confirmation) on ordinary tasks to the owner's Telegram or WhatsApp
 * DM. WhatsApp has no buttons: the card is sent as a numbered text prompt and
 * the owner's numbered reply resolves through the same action ledger.
 *
 * chat_publications and callback actions both need a chat_conversations row
 * bound to the interaction's task. An ordinary chat conversation changes task
 * semantics (assignee lock, chat retries, run milestones, inbound routing), so
 * owner-card conversations use non-positive session generations as their
 * durable marker. Every chat conversation created from provider traffic
 * starts at generation 1, so `ordinaryChatConversation()` excludes only
 * owner-card rows.
 */
export const OWNER_CARD_MAX_SESSION_GENERATION = 0;

export function ordinaryChatConversation() {
  return gt(chatConversations.sessionGeneration, OWNER_CARD_MAX_SESSION_GENERATION);
}

export function isOwnerCardConversation(conversation: { sessionGeneration: number }) {
  return conversation.sessionGeneration <= OWNER_CARD_MAX_SESSION_GENERATION;
}

type OwnerPushDb = Pick<Db, "select" | "insert" | "update">;
type EndpointRow = typeof chatEndpoints.$inferSelect;
type ConversationRow = typeof chatConversations.$inferSelect;

export const OWNER_CARD_PROVIDERS = ["telegram", "whatsapp"] as const;

/** Defaults on for Telegram and WhatsApp; `setup.ownerCardPush = false` switches it off. */
export function ownerCardPushEnabled(endpoint: { provider: string; setup: ChatEndpointSetupState | null | undefined }) {
  return (OWNER_CARD_PROVIDERS as readonly string[]).includes(endpoint.provider) && endpoint.setup?.ownerCardPush !== false;
}

/**
 * Whether a linked principal can be addressed in a private chat. A Telegram
 * private chat id equals the user's id (group ids are negative). A WhatsApp
 * owner must be known by phone number; a hidden-id ("lid:") sender cannot be
 * addressed by number and is never pushed to.
 */
export function ownerCardPrincipalAddressable(provider: string, externalId: string): boolean {
  if (provider === "telegram") return /^[1-9]\d*$/.test(externalId);
  if (provider === "whatsapp") return /^\d{6,20}$/.test(externalId);
  return false;
}

export function isOwnerCardInteraction(interaction: IssueThreadInteraction) {
  return (
    interaction.status === "pending" &&
    (interaction.kind === "ask_user_questions" || interaction.kind === "request_confirmation") &&
    !interaction.addresseeAgentId
  );
}

const ROLE_RANK: Record<string, number> = { owner: 0, admin: 1, operator: 3 };
function roleRank(role: string | null) {
  return role === null ? 2 : ROLE_RANK[role] ?? 4;
}

export type OwnerCardCandidate = {
  endpointId: string;
  userId: string;
  membershipRole: string | null;
  confirmedAt: Date | null;
};

/**
 * Chooses at most one recipient per endpoint. A card addressed to a user goes
 * only to that user. A card addressed generally to the board goes to the
 * linked owner first, then admin, then other non-viewer members; ties go to
 * the earliest confirmed link. The creator of a card never receives it.
 */
export function chooseOwnerCardRecipients<T extends OwnerCardCandidate>(
  candidates: T[],
  interaction: Pick<IssueThreadInteraction, "addresseeUserId" | "createdByUserId">,
): T[] {
  const addressee = interaction.addresseeUserId ?? null;
  const byEndpoint = new Map<string, T>();
  for (const candidate of candidates) {
    if (candidate.membershipRole === "viewer") continue;
    if (addressee && candidate.userId !== addressee) continue;
    if (interaction.createdByUserId && candidate.userId === interaction.createdByUserId) continue;
    const current = byEndpoint.get(candidate.endpointId);
    if (
      !current ||
      roleRank(candidate.membershipRole) < roleRank(current.membershipRole) ||
      (roleRank(candidate.membershipRole) === roleRank(current.membershipRole) &&
        (candidate.confirmedAt?.getTime() ?? Infinity) < (current.confirmedAt?.getTime() ?? Infinity))
    ) {
      byEndpoint.set(candidate.endpointId, candidate);
    }
  }
  return [...byEndpoint.values()];
}

export type OwnerCardRecipient = OwnerCardCandidate & {
  endpoint: EndpointRow;
  principal: typeof chatExternalPrincipals.$inferSelect;
};

/** Confirmed Telegram links of active non-viewer members on active, opted-in endpoints. */
export async function resolveOwnerCardRecipients(
  db: OwnerPushDb,
  interaction: IssueThreadInteraction,
  options: { excludeEndpointIds?: Iterable<string> } = {},
): Promise<OwnerCardRecipient[]> {
  if (!isOwnerCardInteraction(interaction)) return [];
  const excluded = new Set(options.excludeEndpointIds ?? []);
  const rows = await db
    .select({
      endpoint: chatEndpoints,
      principal: chatExternalPrincipals,
      userId: chatIdentityLinks.paperclipUserId,
      confirmedAt: chatIdentityLinks.confirmedAt,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(chatIdentityLinks)
    .innerJoin(
      chatEndpoints,
      and(
        eq(chatEndpoints.companyId, chatIdentityLinks.companyId),
        eq(chatEndpoints.id, chatIdentityLinks.endpointId),
      ),
    )
    .innerJoin(
      chatExternalPrincipals,
      and(
        eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId),
        eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
        eq(chatExternalPrincipals.provider, chatEndpoints.provider),
        sql`${chatExternalPrincipals.providerAccountId} = coalesce(${chatEndpoints.providerAccountId}, '')`,
      ),
    )
    .innerJoin(
      companyMemberships,
      and(
        eq(companyMemberships.companyId, chatIdentityLinks.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, chatIdentityLinks.paperclipUserId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .where(
      and(
        eq(chatIdentityLinks.companyId, interaction.companyId),
        eq(chatIdentityLinks.status, "linked"),
        isNotNull(chatIdentityLinks.paperclipUserId),
        isNull(chatIdentityLinks.revokedAt),
        inArray(chatEndpoints.provider, [...OWNER_CARD_PROVIDERS]),
        eq(chatEndpoints.status, "active"),
        eq(chatEndpoints.allowDirectMessages, true),
        eq(chatExternalPrincipals.kind, "user"),
        eq(chatExternalPrincipals.isBot, false),
        sql`coalesce(${companyMemberships.membershipRole}, '') <> 'viewer'`,
        ...(interaction.addresseeUserId
          ? [eq(chatIdentityLinks.paperclipUserId, interaction.addresseeUserId)]
          : []),
      ),
    );
  const candidates = rows
    .filter(
      (row) =>
        row.userId !== null &&
        !excluded.has(row.endpoint.id) &&
        ownerCardPushEnabled(row.endpoint) &&
        ownerCardPrincipalAddressable(row.endpoint.provider, row.principal.externalId),
    )
    .map((row) => ({
      endpointId: row.endpoint.id,
      userId: row.userId!,
      membershipRole: row.membershipRole,
      confirmedAt: row.confirmedAt,
      endpoint: row.endpoint,
      principal: row.principal,
    }));
  return chooseOwnerCardRecipients(candidates, interaction);
}

export function ownerCardThreadId(
  externalUserId: string,
  endpoint: { provider: string; publicId: string } = { provider: "telegram", publicId: "" },
) {
  if (endpoint.provider === "whatsapp")
    return whatsAppThreadId({ accountId: endpoint.publicId, jid: `${externalUserId}@s.whatsapp.net` });
  return `telegram:${externalUserId}`;
}

/**
 * One DM conversation per (endpoint, Telegram user, task), reused by every
 * later owner card on the same task. A conversation quarantined after a failed
 * send (for example, the owner has not started the bot) is reopened for the
 * next card only; each card is still attempted exactly once.
 */
export async function getOrCreateOwnerCardConversation(
  db: OwnerPushDb,
  input: { recipient: OwnerCardRecipient; issueId: string },
): Promise<ConversationRow> {
  const { endpoint, principal } = input.recipient;
  const threadId = ownerCardThreadId(principal.externalId, endpoint);
  const findExisting = () =>
    db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.externalConversationId, threadId),
          eq(chatConversations.externalThreadId, threadId),
          eq(chatConversations.issueId, input.issueId),
          lte(chatConversations.sessionGeneration, OWNER_CARD_MAX_SESSION_GENERATION),
        ),
      )
      .then((rows) => rows[0] ?? null);
  const reopen = async (conversation: ConversationRow) => {
    if (conversation.state === "active" || conversation.state === "waiting") return conversation;
    const [reopened] = await db
      .update(chatConversations)
      .set({ state: "active", updatedAt: new Date() })
      .where(and(eq(chatConversations.id, conversation.id), ne(chatConversations.state, "endpoint_removed")))
      .returning();
    return reopened ?? conversation;
  };
  const existing = await findExisting();
  if (existing) return reopen(existing);

  const lowest = await db
    .select({ value: sql<number | null>`min(${chatConversations.sessionGeneration})` })
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.endpointId, endpoint.id),
        eq(chatConversations.externalConversationId, threadId),
        eq(chatConversations.externalThreadId, threadId),
        lte(chatConversations.sessionGeneration, OWNER_CARD_MAX_SESSION_GENERATION),
      ),
    )
    .then((rows) => (rows[0]?.value == null ? null : Number(rows[0].value)));
  const sessionGeneration = (lowest ?? OWNER_CARD_MAX_SESSION_GENERATION) - 1;
  const [created] = await db
    .insert(chatConversations)
    .values({
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      resourceId: null,
      issueId: input.issueId,
      externalConversationId: threadId,
      externalThreadId: threadId,
      sessionGeneration,
      externalLabel: principal.displayName ?? (endpoint.provider === "whatsapp"
        ? principal.handle ?? "WhatsApp direct message"
        : principal.handle ? `@${principal.handle.replace(/^@/, "")}` : "Telegram direct message"),
      providerUrl: null,
      isDirectMessage: true,
      communicationGuidance: null,
      state: "active",
      lastActivityAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const raced = await findExisting();
  if (!raced) throw new Error("Could not create the owner card conversation");
  return reopen(raced);
}

/**
 * Text form of a card Telegram cannot answer with one tap: every question and
 * its options, then where to answer.
 */
export function ownerCardFallbackText(
  interaction: IssueThreadInteraction,
  taskUrl: string | null,
): { title: string; body: string } {
  const answerLine = taskUrl ? `Answer in Paperclip: ${taskUrl}` : "Answer in Paperclip.";
  if (interaction.kind === "ask_user_questions") {
    const { payload } = interaction;
    const title = payload.title ?? interaction.title ?? "Input needed";
    const sections: string[] = [];
    if (interaction.summary?.trim()) sections.push(interaction.summary.trim());
    const numbered = payload.questions.length > 1;
    payload.questions.forEach((question, index) => {
      const lines = [`${numbered ? `${index + 1}. ` : ""}${question.prompt}`];
      if (question.helpText?.trim()) lines.push(question.helpText.trim());
      if (question.selectionMode === "multi") lines.push("(choose one or more)");
      for (const option of question.options) {
        if (option.freeText) continue;
        lines.push(`- ${option.label}${option.description ? `: ${option.description}` : ""}`);
      }
      if (question.allowOther || question.options.some((option) => option.freeText)) {
        lines.push("- Other (write your own answer)");
      }
      sections.push(lines.join("\n"));
    });
    sections.push(answerLine);
    return { title, body: sections.join("\n\n") };
  }
  if (interaction.kind === "request_confirmation") {
    const { payload } = interaction;
    const sections = [interaction.summary?.trim(), payload.detailsMarkdown?.trim()].filter(
      (value): value is string => Boolean(value),
    );
    const accept = payload.acceptLabel ?? "Accept";
    const reject = payload.rejectLabel ?? "Reject";
    sections.push(
      `- ${accept}\n- ${reject}${payload.rejectRequiresReason ? " (with a reason)" : ""}`,
    );
    sections.push(answerLine);
    return { title: payload.prompt, body: sections.join("\n\n") };
  }
  return { title: interaction.title ?? "Input needed", body: answerLine };
}
