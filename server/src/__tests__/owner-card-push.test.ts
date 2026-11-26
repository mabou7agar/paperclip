import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  applyPendingMigrations,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { enqueueIssueInteractionChatPublications } from "../services/chat-interaction-publications.js";
import { getExternalChannelBindingSummary } from "../services/chat-channel-binding.js";
import { resolveInboundConversationBinding } from "../services/chat-channels/inbound/conversation-binding.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_OWNER_CARD_PUSH_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("owner card push to Telegram", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;

  beforeAll(async () => {
    process.env.PAPERCLIP_PUBLIC_URL = "https://paperclip.example";
    if (externalUrl) await applyPendingMigrations(externalUrl);
    else tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-card-push-");
    db = createDb(externalUrl ?? tempDb!.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (previousPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = previousPublicUrl;
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function seed(options: { ownerCardPush?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Owner push ${companyId}`,
      issuePrefix: `OP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", role: "operator", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "Ordinary task", status: "in_progress", priority: "medium", assigneeAgentId: agentId,
    });
    await db.insert(toolApplications).values({
      id: applicationId, companyId, applicationKey: `chat:telegram:${endpointId}`, name: "Telegram", type: "chat", status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: "Telegram channel", uid: `chat-telegram-${endpointId}`,
      connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true,
    });
    // The bot answers a different agent than the one asking: owner push must
    // not depend on the endpoint's assigned agent.
    const botAgentId = randomUUID();
    await db.insert(agents).values({
      id: botAgentId, companyId, name: "Bot agent", role: "operator", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId, provider: "telegram", publicId: randomUUID(),
      assignedAgentId: botAgentId, status: "active", providerAccountId: "bot-1",
      setup: { step: "complete", ...(options.ownerCardPush === undefined ? {} : { ownerCardPush: options.ownerCardPush }) },
      capabilities: {
        threads: false, directMessages: true, nativeStreaming: false, messageEdits: true, messageDeletes: false,
        reactions: true, files: true, cards: true, actions: true, modals: false, slashCommands: true,
        ephemeralMessages: false, proactiveDirectMessages: false,
      },
    });
    const link = async (userId: string, telegramId: string, role: string) => {
      const principalId = randomUUID();
      await db.insert(chatExternalPrincipals).values({
        id: principalId, companyId, provider: "telegram", providerAccountId: "bot-1", externalId: telegramId,
        kind: "user", displayName: `Telegram ${userId}`,
      });
      await db.insert(chatIdentityLinks).values({
        companyId, endpointId, principalId, paperclipUserId: userId, status: "linked", confirmedAt: new Date(),
      });
      await db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role,
      });
    };
    return { companyId, agentId, issueId, endpointId, link };
  }

  async function publicationsFor(companyId: string, interactionId: string) {
    return db.select().from(chatPublications).where(and(
      eq(chatPublications.companyId, companyId),
      eq(sql<string>`${chatPublications.payload}->>'interactionId'`, interactionId),
    ));
  }

  const singleQuestion = {
    kind: "ask_user_questions" as const,
    payload: {
      version: 1 as const,
      questions: [{
        id: "env", prompt: "Which environment?", selectionMode: "single" as const,
        options: [{ id: "staging", label: "Staging" }, { id: "prod", label: "Production" }],
      }],
    },
  };

  it("pushes an agent's board card on an unbound task to the owner's Telegram DM with buttons, reusing one DM conversation per task", async () => {
    const fixture = await seed();
    await fixture.link("owner-user", "424242", "owner");
    const service = issueThreadInteractionService(db);
    const first = await service.create({ id: fixture.issueId, companyId: fixture.companyId }, singleQuestion, { agentId: fixture.agentId });
    const [publication] = await publicationsFor(fixture.companyId, first.id);
    expect(publication).toBeDefined();
    expect(publication.endpointId).toBe(fixture.endpointId);
    expect(publication.payload.card?.actions?.map((action) => action.label)).toEqual(["Staging", "Production"]);
    const tokens = await db.select().from(chatActions).where(eq(chatActions.conversationId, publication.conversationId));
    expect(tokens.filter((token) => token.kind === "question_answer")).toHaveLength(2);

    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, publication.conversationId));
    expect(conversation).toMatchObject({
      issueId: fixture.issueId, isDirectMessage: true, externalConversationId: "telegram:424242",
      externalThreadId: "telegram:424242", sessionGeneration: -1, state: "active",
    });

    const second = await service.create({ id: fixture.issueId, companyId: fixture.companyId }, {
      kind: "request_confirmation", payload: { version: 1, prompt: "Deploy now?" },
    }, { agentId: fixture.agentId });
    const [secondPublication] = await publicationsFor(fixture.companyId, second.id);
    expect(secondPublication.conversationId).toBe(conversation.id);
    expect(secondPublication.payload.card?.actions?.map((action) => action.label)).toEqual(["Accept", "Reject"]);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.issueId, fixture.issueId))).toHaveLength(1);

    // The owner-card DM never makes the task look chat-bound, and never
    // captures the owner's ordinary messages to the bot.
    expect(await getExternalChannelBindingSummary(db, fixture.companyId, fixture.issueId)).toBeNull();
    const inbound = await resolveInboundConversationBinding(db, {
      endpoint: { id: fixture.endpointId, companyId: fixture.companyId },
      thread: { id: "telegram:424242", channelId: "telegram:424242" },
      isLinear: () => true,
    });
    expect(inbound.latestConversation).toBeNull();
  });

  it("resumes the agent as an ordinary card answer after the card was pushed to Telegram", async () => {
    // Regression (26 Nov 2026): every answer to a pushed card was flagged as an
    // external-chat continuation, whose run then failed at setup with
    // reviewed_chat_execution_binding_not_authorized, so the agent never resumed.
    const fixture = await seed();
    await fixture.link("owner-user", "434343", "owner");
    const service = issueThreadInteractionService(db);
    const card = await service.create({ id: fixture.issueId, companyId: fixture.companyId }, singleQuestion, { agentId: fixture.agentId });
    expect(await publicationsFor(fixture.companyId, card.id)).not.toHaveLength(0);
    await service.answerQuestions({ id: fixture.issueId, companyId: fixture.companyId }, card.id, {
      answers: [{ questionId: "env", optionIds: ["staging"] }],
    }, { userId: "owner-user" });
    const wakeup = vi.fn().mockResolvedValue(null);
    await questionResponseDeliveryService(db, { heartbeat: { wakeup } as never, steer: vi.fn() }).deliver(card.id);
    expect(wakeup).toHaveBeenCalledWith(fixture.agentId, expect.objectContaining({
      payload: expect.objectContaining({ interactionId: card.id, externalChatContinuation: false }),
    }));
  });

  it("formats cards Telegram cannot answer with one tap as text with the task link", async () => {
    const fixture = await seed();
    await fixture.link("owner-user", "515151", "owner");
    const interaction = await issueThreadInteractionService(db).create({ id: fixture.issueId, companyId: fixture.companyId }, {
      kind: "ask_user_questions",
      payload: {
        version: 1, title: "Two decisions",
        questions: [
          { id: "a", prompt: "First?", selectionMode: "single", options: [{ id: "x", label: "X" }] },
          { id: "b", prompt: "Second?", selectionMode: "multi", options: [{ id: "y", label: "Y" }, { id: "z", label: "Z" }] },
        ],
      },
    }, { agentId: fixture.agentId });
    const [publication] = await publicationsFor(fixture.companyId, interaction.id);
    expect(publication.payload.card?.title).toBe("Two decisions");
    expect(publication.payload.card?.body).toContain("1. First?\n- X");
    expect(publication.payload.card?.body).toContain("2. Second?\n(choose one or more)\n- Y\n- Z");
    expect(publication.payload.card?.body).toContain(`Answer in Paperclip: https://paperclip.example/issues/${fixture.issueId}`);
    expect(publication.payload.card?.actions).toEqual([expect.objectContaining({ type: "link" })]);
  });

  it("sends nothing when the endpoint opts out or nobody linked Telegram", async () => {
    const optedOut = await seed({ ownerCardPush: false });
    await optedOut.link("owner-user", "616161", "owner");
    const a = await issueThreadInteractionService(db).create({ id: optedOut.issueId, companyId: optedOut.companyId }, singleQuestion, { agentId: optedOut.agentId });
    expect(await publicationsFor(optedOut.companyId, a.id)).toEqual([]);
    expect(await db.select().from(chatConversations).where(eq(chatConversations.issueId, optedOut.issueId))).toEqual([]);

    const unlinked = await seed();
    const b = await issueThreadInteractionService(db).create({ id: unlinked.issueId, companyId: unlinked.companyId }, singleQuestion, { agentId: unlinked.agentId });
    expect(await publicationsFor(unlinked.companyId, b.id)).toEqual([]);
  });

  it("chooses the addressee, else the owner, and skips cards addressed to agents", async () => {
    const fixture = await seed();
    await fixture.link("admin-user", "717171", "admin");
    await fixture.link("owner-user", "818181", "owner");
    const created = await issueThreadInteractionService(db).create({ id: fixture.issueId, companyId: fixture.companyId }, singleQuestion, { agentId: fixture.agentId });
    const [boardPublication] = await publicationsFor(fixture.companyId, created.id);
    const [boardConversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, boardPublication.conversationId));
    expect(boardConversation.externalThreadId).toBe("telegram:818181");

    const addressed = { ...created, id: randomUUID(), addresseeUserId: "admin-user" } as IssueThreadInteraction;
    const [addressedPublication] = await enqueueIssueInteractionChatPublications(db, addressed);
    const [addressedConversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, addressedPublication.conversationId));
    expect(addressedConversation.externalThreadId).toBe("telegram:717171");

    const toAgent = { ...created, id: randomUUID(), addresseeAgentId: fixture.agentId } as IssueThreadInteraction;
    expect(await enqueueIssueInteractionChatPublications(db, toAgent)).toEqual([]);
    const toUnlinked = { ...created, id: randomUUID(), addresseeUserId: "someone-else" } as IssueThreadInteraction;
    expect(await enqueueIssueInteractionChatPublications(db, toUnlinked)).toEqual([]);
  });

  it("reopens a DM quarantined after a failed send for the next card only", async () => {
    const fixture = await seed();
    await fixture.link("owner-user", "919191", "owner");
    const first = await issueThreadInteractionService(db).create({ id: fixture.issueId, companyId: fixture.companyId }, singleQuestion, { agentId: fixture.agentId });
    const [publication] = await publicationsFor(fixture.companyId, first.id);
    // What the publication worker records when Telegram refuses the DM
    // because the owner never pressed /start.
    await db.update(chatConversations).set({ state: "unavailable" }).where(eq(chatConversations.id, publication.conversationId));
    await db.update(chatPublications).set({ state: "cancelled", redactedError: "Forbidden: bot can't initiate conversation with a user" }).where(eq(chatPublications.id, publication.id));

    const again = await enqueueIssueInteractionChatPublications(db, first);
    expect(again).toEqual([]);
    const next = { ...first, id: randomUUID() } as IssueThreadInteraction;
    const [nextPublication] = await enqueueIssueInteractionChatPublications(db, next);
    expect(nextPublication.conversationId).toBe(publication.conversationId);
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, publication.conversationId));
    expect(conversation.state).toBe("active");
  });
});
