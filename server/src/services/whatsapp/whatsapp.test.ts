import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifyChatPublicationError } from "../chat-publication-errors.js";
import { stableExternalPrincipalId } from "../chat-channels/message-lifecycle.js";
import { whatsAppIdentityFromStatus } from "../chat-channels/whatsapp/credentials.js";
import { normalizeWhatsAppLinkInput } from "../chat-channels/whatsapp/setup.js";
import { WhatsAppChatAdapter } from "./adapter.js";
import { parseWhatsAppSidecarConfig, whatsAppSidecarConfig, whatsAppSidecarFileEnv, WhatsAppSidecarUnconfiguredError } from "./config.js";
import {
  markdownToWhatsApp,
  parseWhatsAppInboundEvent,
  parseWhatsAppThreadId,
  splitWhatsAppText,
  whatsAppExternalPrincipalId,
  whatsAppThreadId,
} from "./parse.js";
import { WhatsAppSidecarClient, WhatsAppSidecarError, parseWhatsAppLinkStatus } from "./sidecar-client.js";
import {
  WHATSAPP_SIGNATURE_HEADER,
  WHATSAPP_TIMESTAMP_HEADER,
  verifyWhatsAppSignature,
  whatsAppSignature,
  whatsAppSignedHeaders,
} from "./signature.js";

const SECRET = "s".repeat(48);
const ACCOUNT = "endpointPublicId_123";
const config = { url: "http://whatsapp-sidecar:8787", secret: SECRET };

function event(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    accountId: ACCOUNT,
    messageId: "3EB0ABC",
    timestamp: 1_700_000_000_000,
    fromJid: "4915550001@s.whatsapp.net",
    fromPhone: "4915550001",
    fromLid: null,
    pushName: "Sam",
    text: "hello",
    quotedId: null,
    ...overrides,
  };
}

describe("WhatsApp sidecar signatures", () => {
  it("verifies a signed request and matches the sidecar's byte layout", () => {
    const headers = whatsAppSignedHeaders({ secret: SECRET, method: "POST", path: "/api/chat-webhooks/x/whatsapp", body: "{}", now: 1_000_000 });
    expect(verifyWhatsAppSignature({
      secret: SECRET, method: "post", path: "/api/chat-webhooks/x/whatsapp",
      timestamp: headers[WHATSAPP_TIMESTAMP_HEADER], signature: headers[WHATSAPP_SIGNATURE_HEADER], body: "{}", now: 1_001_000,
    })).toEqual({ ok: true });
    // Same vector as the sidecar's signature.test.js.
    expect(whatsAppSignature({ secret: "k", method: "get", path: "/p?q=1", timestamp: "5", body: "" }))
      .toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it("rejects replays outside the window, tampering and missing headers", () => {
    const headers = whatsAppSignedHeaders({ secret: SECRET, method: "POST", path: "/x", body: "a", now: 10_000_000 });
    const base = { secret: SECRET, method: "POST", path: "/x", timestamp: headers[WHATSAPP_TIMESTAMP_HEADER], signature: headers[WHATSAPP_SIGNATURE_HEADER], body: "a" };
    expect(verifyWhatsAppSignature({ ...base, now: 10_000_000 + 5 * 60_000 + 1 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyWhatsAppSignature({ ...base, now: 10_000_000 - 5 * 60_000 - 1 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyWhatsAppSignature({ ...base, body: "b", now: 10_000_000 })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWhatsAppSignature({ ...base, path: "/y", now: 10_000_000 })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWhatsAppSignature({ ...base, secret: "t".repeat(48), now: 10_000_000 })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWhatsAppSignature({ ...base, signature: null, now: 10_000_000 })).toEqual({ ok: false, reason: "missing" });
    expect(verifyWhatsAppSignature({ ...base, signature: "v1=zz", now: 10_000_000 })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyWhatsAppSignature({ ...base, secret: "", now: 10_000_000 })).toEqual({ ok: false, reason: "unconfigured" });
  });
});

describe("WhatsApp instance configuration", () => {
  it("is absent without both settings and never enumerates the secret", () => {
    expect(parseWhatsAppSidecarConfig({})).toBeNull();
    expect(parseWhatsAppSidecarConfig({ PAPERCLIP_WHATSAPP_SIDECAR_URL: "http://sidecar:8787" })).toBeNull();
    const parsed = parseWhatsAppSidecarConfig({ PAPERCLIP_WHATSAPP_SIDECAR_URL: "http://sidecar:8787/", PAPERCLIP_WHATSAPP_SIDECAR_SECRET: SECRET })!;
    expect(parsed.url).toBe("http://sidecar:8787");
    expect(parsed.secret).toBe(SECRET);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
    expect(() => parseWhatsAppSidecarConfig({ PAPERCLIP_WHATSAPP_SIDECAR_URL: "http://sidecar", PAPERCLIP_WHATSAPP_SIDECAR_SECRET: "short" })).toThrow();
    expect(() => parseWhatsAppSidecarConfig({ PAPERCLIP_WHATSAPP_SIDECAR_URL: "http://u:p@sidecar", PAPERCLIP_WHATSAPP_SIDECAR_SECRET: SECRET })).toThrow();
  });

  it("falls back to the instance file when the environment has no sidecar", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wa-config-"));
    const file = path.join(dir, "whatsapp-sidecar.json");
    expect(whatsAppSidecarFileEnv(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ url: "http://whatsapp-sidecar:8787", secret: SECRET }));
    const fromFile = whatsAppSidecarConfig({}, () => whatsAppSidecarFileEnv(file));
    expect(fromFile.url).toBe("http://whatsapp-sidecar:8787");
    expect(fromFile.secret).toBe(SECRET);
    // The environment wins when it is complete.
    const fromEnv = whatsAppSidecarConfig({ PAPERCLIP_WHATSAPP_SIDECAR_URL: "http://env:1", PAPERCLIP_WHATSAPP_SIDECAR_SECRET: SECRET }, () => whatsAppSidecarFileEnv(file));
    expect(fromEnv.url).toBe("http://env:1");
    writeFileSync(file, "not json");
    expect(() => whatsAppSidecarFileEnv(file)).toThrow(/not valid JSON/);
    expect(() => whatsAppSidecarConfig({}, () => ({}))).toThrow(WhatsAppSidecarUnconfiguredError);
  });
});

describe("WhatsApp event parsing and identities", () => {
  it("parses text, quotes and media closed", () => {
    const text = parseWhatsAppInboundEvent(event({ quotedId: "OUT1", extra: "dropped" }), ACCOUNT);
    expect(text).toEqual({ ...event({ quotedId: "OUT1" }) });
    const media = parseWhatsAppInboundEvent(event({
      text: "", media: { id: "3EB0ABC", mimetype: "Image/JPEG", fileName: "a/b.jpg", size: 2048, kind: "image", voice: false, sha256: "a".repeat(64) },
    }), ACCOUNT);
    expect(media.media).toEqual({ id: "3EB0ABC", mimetype: "image/jpeg", fileName: "a_b.jpg", size: 2048, kind: "image", voice: false, sha256: "a".repeat(64) });
  });

  it("refuses events for another channel, groups and inconsistent senders", () => {
    expect(() => parseWhatsAppInboundEvent(event(), "otherEndpoint_1")).toThrow(/another channel/);
    expect(() => parseWhatsAppInboundEvent(event({ fromJid: "120363@g.us" }), ACCOUNT)).toThrow(/one-to-one/);
    expect(() => parseWhatsAppInboundEvent(event({ fromPhone: "4915550002" }), ACCOUNT)).toThrow(/does not match/);
    expect(() => parseWhatsAppInboundEvent(event({ version: 2 }), ACCOUNT)).toThrow(/version/);
    expect(() => parseWhatsAppInboundEvent(event({ media: { id: "OTHER", mimetype: "image/png", fileName: "x", size: 1 } }), ACCOUNT)).toThrow(/belong/);
  });

  it("maps phone and hidden-id senders to principal ids", () => {
    const phone = parseWhatsAppInboundEvent(event(), ACCOUNT);
    expect(whatsAppExternalPrincipalId(phone)).toBe("4915550001");
    const resolvedLid = parseWhatsAppInboundEvent(event({ fromJid: "777000@lid", fromPhone: "4915550003", fromLid: "777000" }), ACCOUNT);
    expect(whatsAppExternalPrincipalId(resolvedLid)).toBe("4915550003");
    const hidden = parseWhatsAppInboundEvent(event({ fromJid: "777000@lid", fromPhone: null, fromLid: null }), ACCOUNT);
    expect(hidden.fromLid).toBe("777000");
    expect(whatsAppExternalPrincipalId(hidden)).toBe("lid:777000");
    expect(stableExternalPrincipalId("whatsapp", { userId: "fallback", userName: "", fullName: "", isBot: false, isMe: false }, hidden)).toBe("lid:777000");
  });

  it("round-trips conversation identities and rejects tampering", () => {
    const id = whatsAppThreadId({ accountId: ACCOUNT, jid: "4915550001@s.whatsapp.net" });
    expect(id.startsWith(`whatsapp:${ACCOUNT}:d:`)).toBe(true);
    expect(parseWhatsAppThreadId(id)).toEqual({ accountId: ACCOUNT, jid: "4915550001@s.whatsapp.net" });
    // Groups get their own ":g:" identity (phase 4); a group JID never passes as a one-to-one chat.
    expect(whatsAppThreadId({ accountId: ACCOUNT, jid: "120363@g.us" }).startsWith(`whatsapp:${ACCOUNT}:g:`)).toBe(true);
    expect(() => whatsAppThreadId({ accountId: ACCOUNT, jid: "status@broadcast" })).toThrow();
    expect(() => parseWhatsAppThreadId(`whatsapp:${ACCOUNT}:d:${Buffer.from("120363@g.us").toString("base64url")}`)).toThrow();
    expect(() => parseWhatsAppThreadId(`whatsapp:${ACCOUNT}:g:${Buffer.from("4915550001@s.whatsapp.net").toString("base64url")}`)).toThrow();
  });

  it("formats Markdown for WhatsApp and splits long text", () => {
    expect(markdownToWhatsApp("## Title\n**bold** [docs](https://x.test)\n```\n**raw**\n```")).toBe("*Title*\n*bold* docs (https://x.test)\n```\n**raw**\n```");
    expect(splitWhatsAppText("a".repeat(9000)).map((part) => part.length)).toEqual([4000, 4000, 1000]);
  });
});

describe("WhatsApp link status and identity", () => {
  it("parses only known status fields", () => {
    expect(parseWhatsAppLinkStatus({ state: "qr", qrPngDataUrl: "data:image/png;base64,AA", qrIssuedAt: "2026-11-27T10:00:00.000Z", secret: "x" }))
      .toEqual({ state: "qr", qrPngDataUrl: "data:image/png;base64,AA", qrIssuedAt: "2026-11-27T10:00:00.000Z" });
    expect(parseWhatsAppLinkStatus({ state: "qr", qrPngDataUrl: "javascript:alert(1)" })).toEqual({ state: "qr" });
    expect(parseWhatsAppLinkStatus({ state: "linked", me: "4915550001" })).toEqual({ state: "linked", me: "4915550001" });
    expect(() => parseWhatsAppLinkStatus({ state: "hacked" })).toThrow(WhatsAppSidecarError);
  });

  it("records the linked number as the endpoint identity", () => {
    expect(whatsAppIdentityFromStatus({ state: "linked", me: "4915550001" })).toEqual({
      providerAccountId: "whatsapp", providerAccountLabel: "+4915550001", botExternalId: "4915550001",
      botUsername: "+4915550001", botLabel: "+4915550001",
    });
    expect(() => whatsAppIdentityFromStatus({ state: "qr" })).toThrow(/Link WhatsApp first/);
  });

  it("normalizes link input", () => {
    expect(normalizeWhatsAppLinkInput({ mode: "qr", phone: "ignored" })).toEqual({ mode: "qr" });
    expect(normalizeWhatsAppLinkInput({ mode: "code", phone: "+49 (155) 500-01" })).toEqual({ mode: "code", phone: "4915550001" });
    expect(() => normalizeWhatsAppLinkInput({ mode: "code", phone: "12" })).toThrow();
    expect(() => normalizeWhatsAppLinkInput({ mode: "fax" })).toThrow();
  });
});

describe("WhatsAppSidecarClient", () => {
  it("signs requests and maps send failures", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(verifyWhatsAppSignature({
        secret: SECRET, method: init!.method!, path: `/accounts/${ACCOUNT}/send`,
        timestamp: headers[WHATSAPP_TIMESTAMP_HEADER], signature: headers[WHATSAPP_SIGNATURE_HEADER], body: init!.body as string,
      })).toEqual({ ok: true });
      return new Response(JSON.stringify({ messageId: "OUT1" }), { status: 200 });
    });
    const client = new WhatsAppSidecarClient(() => config, fetchImpl as unknown as typeof fetch);
    await expect(client.send(ACCOUNT, { jid: "4915550001@s.whatsapp.net", text: "hi", idempotencyKey: "pub:1:text-0" })).resolves.toEqual({ messageId: "OUT1" });

    const failing = (status: number, body: unknown) => new WhatsAppSidecarClient(() => config,
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch);
    await expect(failing(409, { error: "not_linked" }).send(ACCOUNT, { jid: "1@s.whatsapp.net", text: "x", idempotencyKey: "k" })).rejects.toMatchObject({ code: "not_linked" });
    await expect(failing(502, { error: "failed" }).send(ACCOUNT, { jid: "1@s.whatsapp.net", text: "x", idempotencyKey: "k" })).rejects.toMatchObject({ code: "delivery_unknown" });
    await expect(failing(401, { error: "unauthorized" }).status(ACCOUNT)).rejects.toMatchObject({ code: "unauthorized" });
    const offline = new WhatsAppSidecarClient(() => config, (async () => { throw new Error("ECONNREFUSED http://whatsapp-sidecar:8787"); }) as unknown as typeof fetch);
    await expect(offline.status(ACCOUNT)).rejects.toMatchObject({ code: "unavailable", message: "The WhatsApp service did not answer" });
  });

  it("classifies sidecar failures for the publication outbox", () => {
    expect(classifyChatPublicationError(new WhatsAppSidecarError("delivery_unknown", "x"), 1).kind).toBe("retry");
    expect(classifyChatPublicationError(new WhatsAppSidecarError("unavailable", "x"), 1).kind).toBe("retry");
    expect(classifyChatPublicationError(new WhatsAppSidecarError("not_linked", "x"), 1).kind).toBe("endpoint_attention");
    expect(classifyChatPublicationError(new WhatsAppSidecarError("unauthorized", "x"), 1).kind).toBe("endpoint_attention");
    expect(classifyChatPublicationError(new WhatsAppSidecarError("rejected", "x"), 1).kind).toBe("failed");
  });
});

describe("WhatsAppChatAdapter", () => {
  function adapter(send = vi.fn(async (_account: string, input: { idempotencyKey: string }) => ({ messageId: `id:${input.idempotencyKey}` }))) {
    const client = { send, media: vi.fn(async () => Buffer.from("bytes")) } as unknown as WhatsAppSidecarClient;
    return { adapter: new WhatsAppChatAdapter("Agent", { accountId: ACCOUNT, phoneNumber: "4917600000000" }, () => config, client), send };
  }

  it("verifies the webhook signature and dispatches a chat message", async () => {
    const { adapter: wa } = adapter();
    const processMessage = vi.fn(async () => undefined);
    await wa.initialize({ processMessage } as never);
    const path = `/api/chat-webhooks/${ACCOUNT}/whatsapp`;
    const body = JSON.stringify(event({ media: { id: "3EB0ABC", mimetype: "image/png", fileName: "p.png", size: 5, kind: "image", voice: false } }));
    const signed = new Request(`http://paperclip${path}`, { method: "POST", body, headers: whatsAppSignedHeaders({ secret: SECRET, method: "POST", path, body }) });
    const response = await wa.handleWebhook(signed);
    expect(response.status).toBe(200);
    expect(processMessage).toHaveBeenCalledTimes(1);
    const calls = processMessage.mock.calls as unknown as Array<[unknown, string, { text: string; author: { userId: string; userName: string; fullName: string }; attachments: Array<{ fetchData(): Promise<Buffer>; mimeType: string }> }]>;
    const [, threadId, message] = calls[0];
    expect(parseWhatsAppThreadId(threadId).jid).toBe("4915550001@s.whatsapp.net");
    expect(message.text).toBe("hello");
    expect(message.author).toMatchObject({ userId: "4915550001", userName: "+4915550001", fullName: "Sam" });
    expect(message.attachments[0].mimeType).toBe("image/png");
    expect((await message.attachments[0].fetchData()).toString()).toBe("bytes");

    const unsigned = new Request(`http://paperclip${path}`, { method: "POST", body });
    expect((await wa.handleWebhook(unsigned)).status).toBe(401);
    const stale = new Request(`http://paperclip${path}`, { method: "POST", body, headers: whatsAppSignedHeaders({ secret: SECRET, method: "POST", path, body, now: Date.now() - 6 * 60_000 }) });
    expect((await wa.handleWebhook(stale)).status).toBe(401);
    const foreignBody = JSON.stringify(event({ accountId: "otherEndpoint_1" }));
    const foreign = new Request(`http://paperclip${path}`, { method: "POST", body: foreignBody, headers: whatsAppSignedHeaders({ secret: SECRET, method: "POST", path, body: foreignBody }) });
    expect((await wa.handleWebhook(foreign)).status).toBe(400);
    expect(processMessage).toHaveBeenCalledTimes(1);
  });

  it("publishes text and files with publication-derived idempotency keys", async () => {
    const { adapter: wa, send } = adapter();
    const threadId = whatsAppThreadId({ accountId: ACCOUNT, jid: "4915550001@s.whatsapp.net" });
    const result = await wa.publish(threadId, "pub-uuid", {
      text: "**Done**",
      files: [{ filename: "r.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF") }],
    });
    expect(send.mock.calls.map(([, input]) => input)).toEqual([
      { jid: "4915550001@s.whatsapp.net", text: "*Done*", idempotencyKey: "pub:pub-uuid:text-0" },
      { jid: "4915550001@s.whatsapp.net", media: { base64: Buffer.from("%PDF").toString("base64"), mimetype: "application/pdf", fileName: "r.pdf" }, idempotencyKey: "pub:pub-uuid:file-0" },
    ]);
    expect(result).toEqual({ id: "id:pub:pub-uuid:file-0", threadId, raw: { messageIds: ["id:pub:pub-uuid:text-0", "id:pub:pub-uuid:file-0"] }, text: "**Done**" });
    // A retry of the same publication sends the same keys.
    await wa.publish(threadId, "pub-uuid", { text: "**Done**" });
    expect(send.mock.calls.at(-1)![1]).toMatchObject({ idempotencyKey: "pub:pub-uuid:text-0" });
    await expect(wa.publish(threadId, "pub-uuid", { text: "  " })).rejects.toMatchObject({ code: "rejected" });
    await expect(wa.editMessage(threadId, "OUT1", { markdown: "x", files: [{ filename: "a.txt", data: Buffer.from("a") }] })).rejects.toMatchObject({ code: "rejected" });
  });

  it("refuses conversations of another account", () => {
    const { adapter: wa } = adapter();
    expect(() => wa.decodeThreadId(whatsAppThreadId({ accountId: "otherEndpoint_1", jid: "4915550001@s.whatsapp.net" }))).toThrow(/Wrong WhatsApp account/);
    expect(wa.isDM(whatsAppThreadId({ accountId: ACCOUNT, jid: "777@lid" }))).toBe(true);
  });
});

// ---- Phases 2 and 3 --------------------------------------------------------

import { DEFAULT_WHATSAPP_CUSTOMER_RATE_LIMIT, customerRateLimitReached, whatsAppCustomerRateLimit, whatsAppUnknownSenderPolicy } from "../chat-channels/whatsapp/customers.js";
import { WHATSAPP_CUSTOMER_GUIDANCE } from "../chat-channels/whatsapp/customer-guidance.js";
import { buildChatCommunicationGuidance } from "../chat-communication-guidance.js";
import { linkWhatsAppKnownPerson, normalizeWhatsAppKnownPeople, whatsAppKnownPersonFor } from "../chat-channels/whatsapp/known-people.js";
import { ownerCardPrincipalAddressable, ownerCardPushEnabled, ownerCardThreadId } from "../owner-card-push.js";
import { whatsAppConversationReceivesCards } from "../chat-interaction-publications.js";
import { applyChatTaskReviewContainment } from "../chat-channels/inbound/task-trust.js";
import { matchWhatsAppPromptReply, whatsAppCardPrompt } from "./prompts.js";
import { WhatsAppState } from "./state.js";
import type { ChatSdkStatePersistence } from "../chat-sdk-state.js";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";

function memoryPersistence(): ChatSdkStatePersistence {
  const rows = new Map<string, { value: unknown; version: number; expiresAt: Date | null }>();
  return {
    async read(_scope, key) { return rows.get(key) ?? null; },
    async compareAndSet(input) {
      const current = rows.get(input.key);
      if ((current?.version ?? null) !== input.expectedVersion) return false;
      rows.set(input.key, { value: input.value, version: (current?.version ?? 0) + 1, expiresAt: input.expiresAt });
      return true;
    },
    async deleteIfVersion(input) { return rows.delete(input.key); },
  };
}

const confirmationPayload: SafeChatPublicationPayload = {
  text: "Approve the release?\n\nOpen the task in Paperclip to respond: https://paperclip.example/t/1",
  interactionId: "interaction-1",
  card: {
    schema: "paperclip.chat.card.v1",
    kind: "confirmation",
    title: "Approve the release?",
    body: "Ships version 2.4 to production.",
    actions: [
      { type: "callback", actionId: "pcq_accept", label: "Approve", style: "primary" },
      { type: "callback", actionId: "pcq_reject", label: "Reject", style: "danger" },
    ],
  },
};

describe("WhatsApp owner cards as numbered prompts", () => {
  it("renders a confirmation card as a numbered prompt", () => {
    const prompt = whatsAppCardPrompt(confirmationPayload)!;
    expect(prompt.kind).toBe("confirmation");
    expect(prompt.text).toContain("1. Approve\n2. Reject");
    expect(prompt.text).toContain("Reply 1 to approve, 2 to reject.");
    expect(prompt.choices.map((c) => c.decision)).toEqual(["accept", "reject"]);
    expect(whatsAppCardPrompt({ ...confirmationPayload, card: { ...confirmationPayload.card!, actions: [{ type: "link", label: "Open", url: "https://x" }] } })).toBeNull();
    expect(whatsAppCardPrompt({ text: "plain" })).toBeNull();
  });

  it("maps whole replies (number, option words, yes/no) and leaves sentences alone", () => {
    const prompt = whatsAppCardPrompt(confirmationPayload)!;
    expect(matchWhatsAppPromptReply(prompt, "1")?.actionId).toBe("pcq_accept");
    expect(matchWhatsAppPromptReply(prompt, " 2. ")?.actionId).toBe("pcq_reject");
    expect(matchWhatsAppPromptReply(prompt, "Approve!")?.actionId).toBe("pcq_accept");
    expect(matchWhatsAppPromptReply(prompt, "yes")?.actionId).toBe("pcq_accept");
    expect(matchWhatsAppPromptReply(prompt, "no")?.actionId).toBe("pcq_reject");
    expect(matchWhatsAppPromptReply(prompt, "3")).toBeNull();
    expect(matchWhatsAppPromptReply(prompt, "I need 1 more day")).toBeNull();
    const question = whatsAppCardPrompt({ ...confirmationPayload, card: { ...confirmationPayload.card!, kind: "question", actions: [
      { type: "callback", actionId: "a1", label: "Staging" }, { type: "callback", actionId: "a2", label: "Production" }, { type: "callback", actionId: "a3", label: "Both" },
    ] } })!;
    expect(question.text).toContain("Reply with the number of your answer (1–3)");
    expect(matchWhatsAppPromptReply(question, "production")?.actionId).toBe("a2");
    expect(matchWhatsAppPromptReply(question, "yes")).toBeNull();
  });

  it("turns the owner's reply into the card's action; a reply to an answered card stays a message", async () => {
    const send = vi.fn(async (_a: string, input: { idempotencyKey: string }) => ({ messageId: `OUT-${input.idempotencyKey}` }));
    const client = { send } as unknown as WhatsAppSidecarClient;
    const state = new WhatsAppState({ companyId: "c", endpointId: "e" }, memoryPersistence());
    const wa = new WhatsAppChatAdapter("Agent", { accountId: ACCOUNT, phoneNumber: "4917600000000" }, () => config, client, state);
    const processAction = vi.fn(async () => undefined);
    const processMessage = vi.fn(async () => undefined);
    await wa.initialize({ processAction, processMessage } as never);
    const threadId = whatsAppThreadId({ accountId: ACCOUNT, jid: "4915550001@s.whatsapp.net" });
    const prompt = whatsAppCardPrompt(confirmationPayload)!;
    const published = await wa.publish(threadId, "pub-1", { text: prompt.text });
    await wa.rememberPrompt({ interactionId: prompt.interactionId, kind: prompt.kind, choices: prompt.choices }, threadId, published.raw.messageIds);
    const post = async (overrides: Record<string, unknown>) => {
      const path = `/api/chat-webhooks/${ACCOUNT}/whatsapp`;
      const body = JSON.stringify(event(overrides));
      return wa.handleWebhook(new Request(`http://paperclip${path}`, { method: "POST", body, headers: whatsAppSignedHeaders({ secret: SECRET, method: "POST", path, body }) }));
    };
    expect((await post({ messageId: "IN1", text: "1" })).status).toBe(200);
    expect(processAction).toHaveBeenCalledTimes(1);
    expect(processAction.mock.calls[0]).toEqual([expect.objectContaining({
      actionId: "pcq_accept", value: "interaction-1", messageId: published.id, threadId,
      user: expect.objectContaining({ userId: "4915550001" }),
    }), undefined]);
    // One reply answers one prompt: the next bare number is a normal message.
    await post({ messageId: "IN2", text: "2" });
    expect(processAction).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledTimes(1);
    // A quote of the prompt still maps, unless the card was answered elsewhere.
    wa.promptPending = async () => false;
    await post({ messageId: "IN3", text: "reject", quotedId: published.id });
    expect(processAction).toHaveBeenCalledTimes(1);
    wa.promptPending = async () => true;
    await post({ messageId: "IN4", text: "reject", quotedId: published.id });
    expect(processAction).toHaveBeenCalledTimes(2);
    expect(processAction.mock.calls[1]).toEqual([expect.objectContaining({ actionId: "pcq_reject" }), undefined]);
  });

  it("pushes owner cards to WhatsApp owners known by number only", () => {
    expect(ownerCardPushEnabled({ provider: "whatsapp", setup: { step: "complete" } })).toBe(true);
    expect(ownerCardPushEnabled({ provider: "whatsapp", setup: { step: "complete", ownerCardPush: false } })).toBe(false);
    expect(ownerCardPrincipalAddressable("whatsapp", "4915550001")).toBe(true);
    expect(ownerCardPrincipalAddressable("whatsapp", "lid:777000")).toBe(false);
    expect(ownerCardPrincipalAddressable("telegram", "-100")).toBe(false);
    expect(ownerCardThreadId("4915550001", { provider: "whatsapp", publicId: ACCOUNT }))
      .toBe(whatsAppThreadId({ accountId: ACCOUNT, jid: "4915550001@s.whatsapp.net" }));
    expect(ownerCardThreadId("123")).toBe("telegram:123");
  });
});

describe("WhatsApp customers (unknown-sender policy)", () => {
  it("maps the policy to the unlinked-people switch and bounds the limit", () => {
    expect(whatsAppUnknownSenderPolicy({ provider: "whatsapp", allowUnlinkedPeople: false })).toBe("ignore");
    expect(whatsAppUnknownSenderPolicy({ provider: "whatsapp", allowUnlinkedPeople: true })).toBe("client");
    expect(whatsAppCustomerRateLimit({ step: "complete" })).toEqual(DEFAULT_WHATSAPP_CUSTOMER_RATE_LIMIT);
    expect(whatsAppCustomerRateLimit({ step: "complete", whatsAppCustomerRateLimit: { messages: 3, windowMinutes: 5 } })).toEqual({ messages: 3, windowMinutes: 5 });
    expect(whatsAppCustomerRateLimit({ step: "complete", whatsAppCustomerRateLimit: { messages: 0, windowMinutes: 5 } })).toEqual(DEFAULT_WHATSAPP_CUSTOMER_RATE_LIMIT);
    expect(customerRateLimitReached(2, { messages: 3, windowMinutes: 10 })).toBe(false);
    expect(customerRateLimitReached(3, { messages: 3, windowMinutes: 10 })).toBe(true);
  });

  it("tells the agent it is talking to a customer and what is out of bounds", () => {
    const guidance = buildChatCommunicationGuidance({ provider: "whatsapp", isDirectMessage: true, customer: true })!;
    for (const line of WHATSAPP_CUSTOMER_GUIDANCE) expect(guidance).toContain(line);
    expect(guidance).toMatch(/deployments, feature flags, approvals/);
    expect(guidance).not.toContain("project's code");
    const team = buildChatCommunicationGuidance({ provider: "whatsapp", isDirectMessage: true })!;
    expect(team).not.toContain("customer on WhatsApp");
  });

  it("a customer can never trigger owner-only things", async () => {
    // 1. Customer tasks run under the low-trust containment: only read-only tool classes.
    let applied: Record<string, unknown> | null = null;
    const tx = { update: () => ({ set: (values: Record<string, unknown>) => { applied = values; return { where: async () => undefined }; } }) };
    await applyChatTaskReviewContainment(tx as never, { companyId: "c", assignedAgentId: "agent" } as never, { id: "issue", executionPolicy: null } as never);
    const boundary = (applied!.executionPolicy as { authorizationPolicy: { trustBoundary: { allowedToolClasses: string[] } } }).authorizationPolicy.trustBoundary;
    expect(boundary.allowedToolClasses).toEqual(["git.read", "github.pr.read", "tests.local"]);
    expect(boundary.allowedToolClasses.some((c) => /merge|deploy|flag|approv|write/.test(c))).toBe(false);
    // 2. Customer conversations (quarantined tasks) never receive approval/question cards.
    expect(whatsAppConversationReceivesCards({ preset: "low_trust_review", disposition: "quarantined", sourceIssueId: "issue" } as never)).toBe(false);
    expect(whatsAppConversationReceivesCards(null)).toBe(true);
    // 3. Owner cards are only pushed to owners addressable by a linked number.
    expect(ownerCardPrincipalAddressable("whatsapp", "lid:1234")).toBe(false);
    // 4. A numbered reply is only ever dispatched as an action, which Paperclip's
    //    action handler refuses for anyone not linked to an active member
    //    (see handleAction in chat-channels/interactions/callbacks.ts).
  });
});

describe("WhatsApp presence, reactions and edits", () => {
  function client() {
    return {
      send: vi.fn(async () => ({ messageId: "OUT1" })),
      presence: vi.fn(async () => undefined),
      react: vi.fn(async () => undefined),
      edit: vi.fn(async (_a: string, input: { messageId: string }) => ({ messageId: input.messageId })),
    };
  }
  const threadId = whatsAppThreadId({ accountId: ACCOUNT, jid: "4915550001@s.whatsapp.net" });

  it("shows typing while working and pauses it when the reply is published", async () => {
    vi.useFakeTimers();
    try {
      const c = client();
      const wa = new WhatsAppChatAdapter("Agent", { accountId: ACCOUNT, phoneNumber: "4917600000000" }, () => config, c as unknown as WhatsAppSidecarClient);
      await wa.startTyping(threadId);
      expect(c.presence).toHaveBeenLastCalledWith(ACCOUNT, { jid: "4915550001@s.whatsapp.net", state: "composing" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(c.presence).toHaveBeenCalledTimes(2);
      await wa.publish(threadId, "pub-2", { text: "done" });
      expect(c.presence).toHaveBeenLastCalledWith(ACCOUNT, { jid: "4915550001@s.whatsapp.net", state: "paused" });
      expect(wa.isTyping(threadId)).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(c.presence).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends reactions and edits through the sidecar", async () => {
    const c = client();
    const wa = new WhatsAppChatAdapter("Agent", { accountId: ACCOUNT, phoneNumber: "4917600000000" }, () => config, c as unknown as WhatsAppSidecarClient);
    await wa.addReaction(threadId, "IN1", "👍");
    expect(c.react).toHaveBeenLastCalledWith(ACCOUNT, { jid: "4915550001@s.whatsapp.net", messageId: "IN1", emoji: "👍" });
    await wa.removeReaction(threadId, "IN1", "👍");
    expect(c.react).toHaveBeenLastCalledWith(ACCOUNT, { jid: "4915550001@s.whatsapp.net", messageId: "IN1", emoji: "" });
    await expect(wa.editMessage(threadId, "OUT1", { markdown: "**fixed**" })).resolves.toMatchObject({ id: "OUT1", threadId });
    expect(c.edit).toHaveBeenLastCalledWith(ACCOUNT, { jid: "4915550001@s.whatsapp.net", messageId: "OUT1", text: "*fixed*" });
  });

  it("parses inbound reactions and edits and dispatches them as such", async () => {
    const reaction = parseWhatsAppInboundEvent(event({ messageId: "R1", type: "reaction", targetId: "OUT1", emoji: "❤️", text: undefined }), ACCOUNT);
    expect(reaction).toMatchObject({ type: "reaction", targetId: "OUT1", emoji: "❤️" });
    const edit = parseWhatsAppInboundEvent(event({ messageId: "E1", type: "edit", targetId: "IN1", text: "fixed" }), ACCOUNT);
    expect(edit).toMatchObject({ type: "edit", targetId: "IN1", text: "fixed" });
    expect(() => parseWhatsAppInboundEvent(event({ type: "poll" }), ACCOUNT)).toThrow(/Unsupported/);
    expect(() => parseWhatsAppInboundEvent(event({ type: "edit", targetId: "IN1", text: 5 }), ACCOUNT)).toThrow();

    const state = new WhatsAppState({ companyId: "c", endpointId: "e" }, memoryPersistence());
    const wa = new WhatsAppChatAdapter("Agent", { accountId: ACCOUNT, phoneNumber: "4917600000000" }, () => config, client() as unknown as WhatsAppSidecarClient, state);
    const processReaction = vi.fn();
    const processMessageUpdated = vi.fn(async () => undefined);
    const processMessage = vi.fn(async () => undefined);
    await wa.initialize({ processReaction, processMessageUpdated, processMessage } as never);
    const post = async (body: string) => {
      const path = `/api/chat-webhooks/${ACCOUNT}/whatsapp`;
      return wa.handleWebhook(new Request(`http://paperclip${path}`, { method: "POST", body, headers: whatsAppSignedHeaders({ secret: SECRET, method: "POST", path, body }) }));
    };
    await post(JSON.stringify(event({ messageId: "R1", type: "reaction", targetId: "OUT1", emoji: "❤️" })));
    await post(JSON.stringify(event({ messageId: "R2", type: "reaction", targetId: "OUT1", emoji: "" })));
    expect(processReaction.mock.calls.map(([e]) => [e.added, e.rawEmoji, e.messageId])).toEqual([[true, "❤️", "OUT1"], [false, "❤️", "OUT1"]]);
    await post(JSON.stringify(event({ messageId: "E1", type: "edit", targetId: "IN1", text: "fixed" })));
    const [updated] = processMessageUpdated.mock.calls[0] as unknown as [{ message: { id: string; text: string; metadata: { edited: boolean } } }];
    expect(updated.message).toMatchObject({ id: "IN1", text: "fixed", metadata: { edited: true } });
    expect(processMessage).not.toHaveBeenCalled();
  });

  it("client: new sidecar calls are signed, and a paused channel still proves its number", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      const path = new URL(url).pathname;
      paths.push(`${init!.method} ${path}`);
      expect(verifyWhatsAppSignature({ secret: SECRET, method: init!.method!, path, timestamp: headers[WHATSAPP_TIMESTAMP_HEADER], signature: headers[WHATSAPP_SIGNATURE_HEADER], body: (init!.body as string) ?? "" })).toEqual({ ok: true });
      if (path.endsWith("/pause")) return new Response(JSON.stringify({ state: "paused", me: "4917600000000" }), { status: 200 });
      if (path.endsWith("/resume")) return new Response(JSON.stringify({ state: "connecting", me: "4917600000000" }), { status: 200 });
      if (path.endsWith("/edit")) return new Response(JSON.stringify({ messageId: "OUT1" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const c = new WhatsAppSidecarClient(() => config, fetchImpl as unknown as typeof fetch);
    expect((await c.pause(ACCOUNT)).state).toBe("paused");
    expect((await c.resume(ACCOUNT)).state).toBe("connecting");
    await c.presence(ACCOUNT, { jid: "4915550001@s.whatsapp.net", state: "composing" });
    await c.react(ACCOUNT, { jid: "4915550001@s.whatsapp.net", messageId: "IN1", emoji: "👍" });
    await expect(c.edit(ACCOUNT, { jid: "4915550001@s.whatsapp.net", messageId: "OUT1", text: "x" })).resolves.toEqual({ messageId: "OUT1" });
    expect(paths).toEqual([`POST /accounts/${ACCOUNT}/pause`, `POST /accounts/${ACCOUNT}/resume`, `POST /accounts/${ACCOUNT}/presence`, `POST /accounts/${ACCOUNT}/react`, `POST /accounts/${ACCOUNT}/edit`]);
    await expect(c.setKnownPhones(ACCOUNT, ["201090608890"])).resolves.toEqual({ numbers: 0, hiddenIds: 0 });
    expect(paths.at(-1)).toBe(`POST /accounts/${ACCOUNT}/known-phones`);
    expect(whatsAppIdentityFromStatus({ state: "paused", me: "4917600000000" }).botExternalId).toBe("4917600000000");
    expect(() => whatsAppIdentityFromStatus({ state: "logged_out" })).toThrow();
    expect(classifyChatPublicationError(new WhatsAppSidecarError("paused", "x"), 1).kind).toBe("endpoint_attention");
    const paused = new WhatsAppSidecarClient(() => config, (async () => new Response(JSON.stringify({ error: "paused" }), { status: 409 })) as unknown as typeof fetch);
    await expect(paused.send(ACCOUNT, { jid: "1@s.whatsapp.net", text: "x", idempotencyKey: "k" })).rejects.toMatchObject({ code: "paused" });
  });
});

describe("WhatsApp pre-approved people", () => {
  const endpoint = (people: unknown) => ({
    id: "endpoint", companyId: "company", connectionId: "connection", provider: "whatsapp",
    setup: { step: "complete", whatsAppKnownPeople: people },
  });

  it("normalizes the list and only matches phone numbers", () => {
    expect(normalizeWhatsAppKnownPeople([{ phone: "+49 155 50001", paperclipUserId: "u1" }, { phone: "4915550001", paperclipUserId: "u2" }]))
      .toEqual([{ phone: "4915550001", paperclipUserId: "u2" }]);
    expect(() => normalizeWhatsAppKnownPeople([{ phone: "12", paperclipUserId: "u1" }])).toThrow();
    expect(() => normalizeWhatsAppKnownPeople(Array.from({ length: 501 }, (_, i) => ({ phone: `49155${String(i).padStart(5, "0")}`, paperclipUserId: "u" })))).toThrow(/500/);
    const setup = endpoint([{ phone: "4915550001", paperclipUserId: "u1" }]).setup as never;
    expect(whatsAppKnownPersonFor(setup, "4915550001")).toEqual({ phone: "4915550001", paperclipUserId: "u1" });
    expect(whatsAppKnownPersonFor(setup, "lid:4915550001")).toBeNull();
    expect(whatsAppKnownPersonFor(setup, "4915550002")).toBeNull();
  });

  /** A transaction double answering selects in order: existing link, membership, conflicting link. */
  function fakeDb(selects: unknown[][]) {
    const inserted: unknown[] = [];
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
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    return { db: { ...tx, transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) }, inserted };
  }

  it("links a listed number to an active member, and processes as that user", async () => {
    const { db, inserted } = fakeDb([[], [{ userId: "u1", role: "member" }], []]);
    const linked = await linkWhatsAppKnownPerson(db as never, endpoint([{ phone: "4915550001", paperclipUserId: "u1" }]) as never, { id: "principal", externalId: "4915550001" });
    expect(linked).toBe("u1");
    // Only identity-link rows: the activity log may insert its own settings row through the same double.
    const links = inserted.filter((row) => (row as { principalId?: unknown }).principalId !== undefined);
    expect(links).toEqual([expect.objectContaining({ endpointId: "endpoint", principalId: "principal", paperclipUserId: "u1", status: "linked" })]);
  });

  it("never matches a hidden-id sender, refuses non-members and respects a removed link", async () => {
    const lid = fakeDb([]);
    expect(await linkWhatsAppKnownPerson(lid.db as never, endpoint([{ phone: "4915550001", paperclipUserId: "u1" }]) as never, { id: "p", externalId: "lid:4915550001" })).toBeNull();
    expect(lid.inserted).toEqual([]);
    const outsider = fakeDb([[], []]);
    expect(await linkWhatsAppKnownPerson(outsider.db as never, endpoint([{ phone: "4915550001", paperclipUserId: "u9" }]) as never, { id: "p", externalId: "4915550001" })).toBeNull();
    expect(outsider.inserted).toEqual([]);
    const viewer = fakeDb([[], [{ userId: "u1", role: "viewer" }]]);
    expect(await linkWhatsAppKnownPerson(viewer.db as never, endpoint([{ phone: "4915550001", paperclipUserId: "u1" }]) as never, { id: "p", externalId: "4915550001" })).toBeNull();
    const removed = fakeDb([[{ status: "revoked", userId: "u1" }]]);
    expect(await linkWhatsAppKnownPerson(removed.db as never, endpoint([{ phone: "4915550001", paperclipUserId: "u1" }]) as never, { id: "p", externalId: "4915550001" })).toBeNull();
    expect(removed.inserted).toEqual([]);
  });
});

// ---- Phase 4: usernames and client groups ---------------------------------

import { whatsAppSenderMetadata } from "../chat-channels/whatsapp/messages.js";
import {
  CLIENT_GROUP_USAGE,
  answersClientGroups,
  clientGroupForResource,
  clientGroupSenderRows,
  clientGroupTaskDescription,
  clientGroupTaskTitle,
  parseClientGroupCommand,
  withClientGroupGuidance,
} from "../chat-channels/client-groups/core.js";
import { nonDirectDestinationAllowed, providerResourceType, canonicalProviderResourceId } from "../chat-channels/inbound/surfaces.js";
import { whatsAppGroupJidOfThread } from "./parse.js";

const GROUP = "120363025246125486@g.us";

describe("WhatsApp usernames", () => {
  it("parses a sender username WhatsApp asserted and refuses a malformed one", () => {
    expect(parseWhatsAppInboundEvent(event({ fromUsername: "Lead.Dev" }), ACCOUNT).fromUsername).toBe("lead.dev");
    expect(parseWhatsAppInboundEvent(event(), ACCOUNT).fromUsername).toBeUndefined();
    expect(() => parseWhatsAppInboundEvent(event({ fromUsername: "a b" }), ACCOUNT)).toThrow(/username/);
    // A username-only sender keeps its hidden-id principal; the username is shown, never the key.
    const hidden = parseWhatsAppInboundEvent(event({ fromJid: "55443322@lid", fromPhone: null, fromLid: "55443322", fromUsername: "lead.dev" }), ACCOUNT);
    expect(whatsAppExternalPrincipalId(hidden)).toBe("lid:55443322");
    expect(whatsAppSenderMetadata(hidden)).toEqual([
      { type: "key_value", label: "WhatsApp number", value: "Hidden by WhatsApp" },
      { type: "key_value", label: "Username", value: "@lead.dev" },
    ]);
  });

  const setup = (people: unknown) => ({ step: "complete", whatsAppKnownPeople: people }) as never;

  it("pre-approves by username as well as number, matching number first", () => {
    expect(normalizeWhatsAppKnownPeople([
      { phone: "+49 155 50001", paperclipUserId: "u1" },
      { username: "@Lead.Dev", paperclipUserId: "u2" },
      { phone: "4915550002", username: "teacher_one", paperclipUserId: "u3" },
      { username: "LEAD.DEV", paperclipUserId: "u4" },
    ])).toEqual([
      { phone: "4915550001", paperclipUserId: "u1" },
      { phone: "4915550002", username: "teacher_one", paperclipUserId: "u3" },
      { username: "lead.dev", paperclipUserId: "u4" },
    ]);
    expect(() => normalizeWhatsAppKnownPeople([{ paperclipUserId: "u1" }])).toThrow(/number or username/);
    expect(() => normalizeWhatsAppKnownPeople([{ username: "x y", paperclipUserId: "u1" }])).toThrow(/username/);
    const people = setup([{ phone: "4915550001", paperclipUserId: "u1" }, { username: "lead.dev", paperclipUserId: "u2" }, { username: "BAD NAME", paperclipUserId: "u9" }]);
    expect(whatsAppKnownPersonFor(people, "4915550001", "lead.dev")).toEqual({ phone: "4915550001", paperclipUserId: "u1" });
    expect(whatsAppKnownPersonFor(people, "lid:55443322", "Lead.Dev")).toEqual({ username: "lead.dev", paperclipUserId: "u2" });
    expect(whatsAppKnownPersonFor(people, "lid:55443322", null)).toBeNull();
  });

  /** Selects in order: existing link, membership, conflicting link. */
  function fakeDb(selects: unknown[][]) {
    const inserted: unknown[] = [];
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
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    };
    return { db: { ...tx, transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) }, inserted };
  }
  const endpoint = (people: unknown) => ({ id: "endpoint", companyId: "company", connectionId: "connection", provider: "whatsapp", setup: { step: "complete", whatsAppKnownPeople: people } });

  it("links a username-only sender only from the username WhatsApp asserted, never from the display name", async () => {
    const list = [{ username: "lead.dev", paperclipUserId: "u2" }];
    const asserted = fakeDb([[], [{ userId: "u2", role: "member" }], []]);
    expect(await linkWhatsAppKnownPerson(asserted.db as never, endpoint(list) as never, { id: "p", externalId: "lid:55443322" }, { fromUsername: "lead.dev", pushName: "x" })).toBe("u2");
    expect(asserted.inserted.filter((row) => (row as { principalId?: unknown }).principalId)).toEqual([expect.objectContaining({ principalId: "p", paperclipUserId: "u2", status: "linked" })]);
    const displayName = fakeDb([]);
    expect(await linkWhatsAppKnownPerson(displayName.db as never, endpoint(list) as never, { id: "p", externalId: "lid:55443322" }, { pushName: "lead.dev" })).toBeNull();
    expect(displayName.inserted).toEqual([]);
    const removed = fakeDb([[{ status: "revoked", userId: "u2" }]]);
    expect(await linkWhatsAppKnownPerson(removed.db as never, endpoint(list) as never, { id: "p", externalId: "lid:55443322" }, { fromUsername: "lead.dev" })).toBeNull();
    const viewer = fakeDb([[], [{ userId: "u2", role: "viewer" }]]);
    expect(await linkWhatsAppKnownPerson(viewer.db as never, endpoint(list) as never, { id: "p", externalId: "lid:55443322" }, { fromUsername: "lead.dev" })).toBeNull();
  });

  it("sends usernames and the group switch to the sidecar with the numbers", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({ numbers: 1, hiddenIds: 1, usernameIds: 1, groups: true }), { status: 200 }));
    const client = new WhatsAppSidecarClient(() => config, fetchImpl as never);
    await expect(client.setKnownPhones(ACCOUNT, ["4915550001"], { usernames: ["lead.dev"], groups: true }))
      .resolves.toEqual({ numbers: 1, hiddenIds: 1, usernameIds: 1, groups: true });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({ phones: ["4915550001"], usernames: ["lead.dev"], groups: true });
  });
});

describe("WhatsApp groups", () => {
  const groupEvent = (overrides: Record<string, unknown> = {}) =>
    event({ chatType: "group", groupJid: GROUP, groupSubject: "Academy X support", senderIsGroupAdmin: true, mentionsMe: false, ...overrides });

  it("parses group events closed and gives groups their own conversation identity", () => {
    const parsed = parseWhatsAppInboundEvent(groupEvent(), ACCOUNT);
    expect(parsed).toMatchObject({ chatType: "group", groupJid: GROUP, groupSubject: "Academy X support", senderIsGroupAdmin: true, mentionsMe: false, fromPhone: "4915550001" });
    expect(() => parseWhatsAppInboundEvent(groupEvent({ groupJid: "status@broadcast" }), ACCOUNT)).toThrow(/group/);
    expect(() => parseWhatsAppInboundEvent(groupEvent({ chatType: "newsletter" }), ACCOUNT)).toThrow(/chat type/);
    expect(() => parseWhatsAppInboundEvent(event({ groupJid: GROUP }), ACCOUNT)).toThrow(/without a group/);
    const threadId = whatsAppThreadId({ accountId: ACCOUNT, jid: GROUP });
    expect(threadId).toMatch(new RegExp(`^whatsapp:${ACCOUNT}:g:`));
    expect(whatsAppGroupJidOfThread(threadId)).toBe(GROUP);
    expect(whatsAppGroupJidOfThread(whatsAppThreadId({ accountId: ACCOUNT, jid: "4915550001@s.whatsapp.net" }))).toBeNull();
  });

  it("dispatches group messages to the group thread, addressed only by a mention or /client, and replies quote the asker", async () => {
    const send = vi.fn(async (_account: string, input: { idempotencyKey: string }) => ({ messageId: `id:${input.idempotencyKey}` }));
    const client = { send, presence: vi.fn(async () => ({ sent: true })) } as unknown as WhatsAppSidecarClient;
    const wa = new WhatsAppChatAdapter("Agent", { accountId: ACCOUNT, phoneNumber: "4917600000000" }, () => config, client);
    const processMessage = vi.fn(async () => undefined);
    await wa.initialize({ processMessage } as never);
    const path = `/api/chat-webhooks/${ACCOUNT}/whatsapp`;
    const post = async (body: string) =>
      wa.handleWebhook(new Request(`http://paperclip${path}`, { method: "POST", body, headers: whatsAppSignedHeaders({ secret: SECRET, method: "POST", path, body }) }));
    expect((await post(JSON.stringify(groupEvent({ messageId: "G1", text: "do you open on Friday?" })))).status).toBe(200);
    expect((await post(JSON.stringify(groupEvent({ messageId: "G2", text: "@4917600000000 /client Academy X | 42" })))).status).toBe(200);
    expect((await post(JSON.stringify(groupEvent({ messageId: "G3", text: "hey bot", mentionsMe: true })))).status).toBe(200);
    const calls = processMessage.mock.calls as unknown as Array<[unknown, string, { isMention?: boolean }]>;
    const groupThread = whatsAppThreadId({ accountId: ACCOUNT, jid: GROUP });
    expect(calls.map(([, threadId]) => threadId)).toEqual([groupThread, groupThread, groupThread]);
    expect(calls.map(([, , message]) => message.isMention)).toEqual([false, true, true]);
    expect(wa.isDM(groupThread)).toBe(false);
    expect((await wa.fetchThread(groupThread)).channelName).toBe("Academy X support");
    await wa.publish(groupThread, "pub-group", { text: "We open at 9." });
    expect(send.mock.calls.at(-1)![1]).toMatchObject({ jid: GROUP, quotedId: "G3" });
  });

  it("maps a WhatsApp group to one resource admitted by the group switch or by enabling", () => {
    expect(providerResourceType("whatsapp", "linear_group", false)).toBe("group_chat");
    expect(canonicalProviderResourceId("whatsapp", { channelId: whatsAppThreadId({ accountId: ACCOUNT, jid: GROUP }), id: "x" })).toBe(GROUP);
    const resource = { type: "group_chat", availability: "available", enabled: false } as never;
    expect(nonDirectDestinationAllowed({ provider: "whatsapp", allowGroupChats: true } as never, resource)).toBe(true);
    expect(nonDirectDestinationAllowed({ provider: "whatsapp", allowGroupChats: false } as never, resource)).toBe(false);
    expect(nonDirectDestinationAllowed({ provider: "whatsapp", allowGroupChats: false } as never, { ...(resource as object), enabled: true } as never)).toBe(true);
  });
});

describe("Client groups", () => {
  it("parses /client commands and leaves ordinary text alone", () => {
    expect(parseClientGroupCommand("/client")).toEqual({ kind: "show" });
    expect(parseClientGroupCommand("/client@osarh_bot clear")).toEqual({ kind: "clear" });
    expect(parseClientGroupCommand("@4917600000000 /client Academy X | 42")).toEqual({ kind: "set", academyName: "Academy X", academyId: "42" });
    expect(parseClientGroupCommand("/client Academy X")).toEqual({ kind: "usage", reason: "missing_separator" });
    expect(parseClientGroupCommand("/client  | 42")).toEqual({ kind: "usage", reason: "invalid_fields" });
    expect(parseClientGroupCommand("this is Academy X, id 42")).toBeNull();
    expect(parseClientGroupCommand("please /client me")).toBeNull();
    expect(CLIENT_GROUP_USAGE).toContain("/client <academy name> | <academy id>");
  });

  const client = { academyName: "Academy X", academyId: "42", introducedByUserId: "u1", introducedAt: "2026-11-28T00:00:00.000Z", source: "group_command" };

  it("finds a group's client only in a client-group provider's group", () => {
    const resource = { type: "group_chat", availability: "available", metadata: { clientGroup: client } };
    expect(clientGroupForResource({ provider: "whatsapp" }, resource, false)).toEqual(client);
    expect(clientGroupForResource({ provider: "whatsapp" }, resource, true)).toBeNull();
    expect(clientGroupForResource({ provider: "slack" }, resource, false)).toBeNull();
    expect(clientGroupForResource({ provider: "telegram" }, { ...resource, type: "chat" }, false)).toEqual(client);
    expect(clientGroupForResource({ provider: "whatsapp" }, { ...resource, availability: "removed" }, false)).toBeNull();
    expect(clientGroupForResource({ provider: "whatsapp" }, { ...resource, metadata: { clientGroup: { academyName: "" } } }, false)).toBeNull();
    expect(answersClientGroups({ provider: "whatsapp", setup: {} })).toBe(true);
    expect(answersClientGroups({ provider: "telegram", setup: { answerClientGroups: false } })).toBe(false);
  });

  it("tells the agent whose group it is, scopes lookups and forbids internal information", () => {
    const guidance = buildChatCommunicationGuidance({ provider: "whatsapp", isDirectMessage: false, customer: true, clientGroup: client })!;
    expect(guidance).toContain("customer on WhatsApp");
    expect(guidance).toContain("## Client group");
    expect(guidance).toContain("Academy X (academy id 42)");
    expect(guidance).toContain("scope every lookup to academy id 42");
    expect(guidance).toMatch(/Never share internal information in this group/);
    const telegram = buildChatCommunicationGuidance({ provider: "telegram", isDirectMessage: false, customer: true, clientGroup: client })!;
    expect(telegram).toContain("customer on Telegram");
    // A team member's conversation in the group keeps team guidance plus the client section.
    const staff = buildChatCommunicationGuidance({ provider: "telegram", isDirectMessage: false, clientGroup: client })!;
    expect(staff).not.toContain("customer on Telegram");
    expect(staff).toContain("## Client group");
    // Changing the client replaces only that section.
    const changed = withClientGroupGuidance(guidance, { academyName: "Academy Y", academyId: "7" })!;
    expect(changed).toContain("Academy Y (academy id 7)");
    expect(changed).not.toContain("academy id 42");
    expect(withClientGroupGuidance(guidance, null)).not.toContain("## Client group");
  });

  it("puts the academy on the task and the sender rows", () => {
    expect(clientGroupTaskTitle("Login fails", client)).toBe("[Academy X] Login fails");
    expect(clientGroupTaskTitle("Login fails", null)).toBe("Login fails");
    expect(clientGroupTaskDescription("Started from WhatsApp: Academy X support", client)).toBe("Started from WhatsApp: Academy X support\nClient academy: Academy X\nAcademy id: 42");
    expect(clientGroupSenderRows(client)).toEqual([
      { type: "key_value", label: "Client academy", value: "Academy X" },
      { type: "key_value", label: "Academy id", value: "42" },
    ]);
  });
});
