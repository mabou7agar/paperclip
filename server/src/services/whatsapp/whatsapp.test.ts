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
    expect(() => whatsAppThreadId({ accountId: ACCOUNT, jid: "120363@g.us" })).toThrow();
    expect(() => parseWhatsAppThreadId(`whatsapp:${ACCOUNT}:d:${Buffer.from("120363@g.us").toString("base64url")}`)).toThrow();
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
    await expect(wa.editMessage()).rejects.toThrow();
  });

  it("refuses conversations of another account", () => {
    const { adapter: wa } = adapter();
    expect(() => wa.decodeThreadId(whatsAppThreadId({ accountId: "otherEndpoint_1", jid: "4915550001@s.whatsapp.net" }))).toThrow(/Wrong WhatsApp account/);
    expect(wa.isDM(whatsAppThreadId({ accountId: ACCOUNT, jid: "777@lid" }))).toBe(true);
  });
});
