import { randomUUID } from "node:crypto";
import {
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type ChatInstance,
  type FetchOptions,
  type FileUpload,
  type FormattedContent,
  type RawMessage,
  type ThreadInfo,
  type WebhookOptions,
} from "chat";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";
import type { WhatsAppSidecarConfig } from "./config.js";
import {
  WhatsAppEventError,
  markdownToWhatsApp,
  parseWhatsAppInboundEvent,
  parseWhatsAppThreadId,
  splitWhatsAppText,
  whatsAppExternalPrincipalId,
  whatsAppThreadId,
  type WhatsAppInboundEvent,
  type WhatsAppThread,
} from "./parse.js";
import { WhatsAppSidecarClient, WhatsAppSidecarError } from "./sidecar-client.js";
import {
  WHATSAPP_SIGNATURE_HEADER,
  WHATSAPP_TIMESTAMP_HEADER,
  verifyWhatsAppSignature,
} from "./signature.js";

/** Closed, credential-free locator stored with durable inbound attachments. */
export interface WhatsAppMediaLocator {
  kind: "whatsapp_media";
  accountId: string;
  messageId: string;
}

export interface WhatsAppAdapterIdentity {
  /** The endpoint's public id; the sidecar keys its login by it. */
  accountId: string;
  /** Linked number, digits only. */
  phoneNumber: string;
}

export interface WhatsAppPublishResult {
  id: string;
  threadId: string;
  raw: { messageIds: string[] };
  text: string;
}

function textOf(message: AdapterPostableMessage): string {
  if (typeof message === "string") return message;
  if ("markdown" in message) return message.markdown;
  if ("raw" in message) return message.raw;
  if ("ast" in message) return stringifyMarkdown(message.ast);
  if ("fallbackText" in message) return message.fallbackText ?? "";
  return "";
}

function filesOf(message: AdapterPostableMessage): FileUpload[] {
  return typeof message !== "string" && "files" in message ? (message.files ?? []) : [];
}

function attachmentType(mimetype: string): Attachment["type"] {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("audio/")) return "audio";
  if (mimetype.startsWith("video/")) return "video";
  return "file";
}

async function fileBytes(file: FileUpload): Promise<Buffer> {
  const bytes =
    file.data instanceof Blob
      ? Buffer.from(await file.data.arrayBuffer())
      : Buffer.isBuffer(file.data)
        ? file.data
        : Buffer.from(file.data as ArrayBuffer);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new WhatsAppSidecarError("rejected", "Attachment exceeds the configured size limit");
  return bytes;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * WhatsApp through the Paperclip sidecar. Inbound events arrive as signed
 * webhooks on the normal chat-webhook route; outbound sends go to the sidecar,
 * which holds the linked-device socket. Direct messages only.
 */
export class WhatsAppChatAdapter implements Adapter<WhatsAppThread, WhatsAppInboundEvent> {
  readonly name = "whatsapp";
  readonly lockScope = "channel" as const;
  readonly botUserId: string;
  private chat: ChatInstance | null = null;

  constructor(
    readonly userName: string,
    readonly identity: WhatsAppAdapterIdentity,
    private readonly configSource: () => WhatsAppSidecarConfig,
    readonly client: WhatsAppSidecarClient = new WhatsAppSidecarClient(configSource),
  ) {
    this.botUserId = identity.phoneNumber;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  async disconnect(): Promise<void> {
    this.chat = null;
  }

  encodeThreadId(value: WhatsAppThread): string {
    if (value.accountId !== this.identity.accountId) throw new Error("Wrong WhatsApp account");
    return whatsAppThreadId(value);
  }

  decodeThreadId(id: string): WhatsAppThread {
    const value = parseWhatsAppThreadId(id);
    if (value.accountId !== this.identity.accountId) throw new Error("Wrong WhatsApp account");
    return value;
  }

  channelIdFromThreadId(id: string): string {
    this.decodeThreadId(id);
    return id;
  }

  isDM(id: string): boolean {
    this.decodeThreadId(id);
    return true;
  }

  async fetchThread(id: string): Promise<ThreadInfo> {
    const { jid } = this.decodeThreadId(id);
    const number = jid.endsWith("@s.whatsapp.net") ? `+${jid.split("@")[0]}` : "WhatsApp contact";
    return { id, channelId: id, channelName: number, isDM: true, metadata: { jid } };
  }

  async fetchChannelInfo(id: string) {
    const info = await this.fetchThread(id);
    return { id, name: info.channelName, isDM: true, metadata: info.metadata };
  }

  /** WhatsApp linked devices keep no fetchable history for Paperclip. */
  async fetchMessages(id: string, _options?: FetchOptions) {
    this.decodeThreadId(id);
    return { messages: [] as Message<WhatsAppInboundEvent>[], nextCursor: undefined };
  }

  async fetchMessage(): Promise<null> {
    return null;
  }

  async getUser(userId: string) {
    const label = /^\d+$/.test(userId) ? `+${userId}` : userId;
    return { userId, fullName: label, userName: label, isBot: false };
  }

  mediaLocator(event: WhatsAppInboundEvent): WhatsAppMediaLocator | null {
    return event.media ? { kind: "whatsapp_media", accountId: this.identity.accountId, messageId: event.media.id } : null;
  }

  /** Download closure for an inbound attachment; also used after restart. */
  mediaFetcher(locator: WhatsAppMediaLocator): (signal?: AbortSignal) => Promise<Buffer> {
    if (locator.accountId !== this.identity.accountId) throw new Error("Wrong WhatsApp account");
    return (signal?: AbortSignal) => this.client.media(locator.accountId, locator.messageId, signal);
  }

  parseMessage(raw: WhatsAppInboundEvent): Message<WhatsAppInboundEvent> {
    const threadId = this.encodeThreadId({ accountId: this.identity.accountId, jid: raw.fromJid });
    const userId = whatsAppExternalPrincipalId(raw);
    const handle = raw.fromPhone ? `+${raw.fromPhone}` : userId;
    const locator = this.mediaLocator(raw);
    const attachments: Attachment[] =
      raw.media && locator
        ? [
            {
              type: attachmentType(raw.media.mimetype),
              name: raw.media.fileName,
              mimeType: raw.media.mimetype,
              size: raw.media.size,
              fetchMetadata: { kind: locator.kind, accountId: locator.accountId, messageId: locator.messageId },
              fetchData: () => this.mediaFetcher(locator)(),
            },
          ]
        : [];
    return new Message({
      id: raw.messageId,
      threadId,
      text: raw.text,
      formatted: parseMarkdown(raw.text),
      raw,
      attachments,
      author: {
        userId,
        userName: handle,
        fullName: raw.pushName?.trim() || handle,
        isBot: false,
        isMe: false,
      },
      metadata: { dateSent: new Date(raw.timestamp), edited: false },
    });
  }

  /**
   * Signed sidecar event -> normal Chat SDK message dispatch. The runtime
   * holds the response until Paperclip's durable ledger accepted the message.
   */
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    let config: WhatsAppSidecarConfig;
    try {
      config = this.configSource();
    } catch {
      return json(503, { error: "unconfigured" });
    }
    const verdict = verifyWhatsAppSignature({
      secret: config.secret,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      timestamp: request.headers.get(WHATSAPP_TIMESTAMP_HEADER),
      signature: request.headers.get(WHATSAPP_SIGNATURE_HEADER),
      body,
    });
    if (!verdict.ok) return json(401, { error: "unauthorized" });
    let event: WhatsAppInboundEvent;
    try {
      event = parseWhatsAppInboundEvent(JSON.parse(Buffer.from(body).toString("utf8")), this.identity.accountId);
    } catch (error) {
      if (error instanceof WhatsAppEventError || error instanceof SyntaxError) return json(400, { error: "invalid_event" });
      throw error;
    }
    if (!this.chat) return json(503, { error: "not_ready" });
    const message = this.parseMessage(event);
    void this.chat.processMessage(this, message.threadId, message, options).catch(() => undefined);
    return json(200, { ok: true });
  }

  renderFormatted(content: FormattedContent): string {
    return markdownToWhatsApp(stringifyMarkdown(content));
  }

  async startTyping(): Promise<void> {
    /* Phase 1 publishes no presence. */
  }

  async endTyping(): Promise<void> {
    /* Phase 1 publishes no presence. */
  }

  private async sendParts(
    threadId: string,
    keyPrefix: string,
    text: string,
    files: FileUpload[],
    quotedId?: string,
  ): Promise<string[]> {
    const { jid } = this.decodeThreadId(threadId);
    const messageIds: string[] = [];
    const parts = text.trim() ? splitWhatsAppText(markdownToWhatsApp(text)) : [];
    for (let index = 0; index < parts.length; index++) {
      const sent = await this.client.send(this.identity.accountId, {
        jid,
        text: parts[index],
        ...(quotedId && index === 0 ? { quotedId } : {}),
        idempotencyKey: `${keyPrefix}:text-${index}`,
      });
      messageIds.push(sent.messageId);
    }
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const bytes = await fileBytes(file);
      const sent = await this.client.send(this.identity.accountId, {
        jid,
        media: {
          base64: bytes.toString("base64"),
          mimetype: file.mimeType || "application/octet-stream",
          fileName: file.filename,
        },
        ...(quotedId && !parts.length && index === 0 ? { quotedId } : {}),
        idempotencyKey: `${keyPrefix}:file-${index}`,
      });
      messageIds.push(sent.messageId);
    }
    if (!messageIds.length) throw new WhatsAppSidecarError("rejected", "WhatsApp publication is empty");
    return messageIds;
  }

  /**
   * Publication-outbox send. Each part carries a key derived from the durable
   * publication id, so an outbox retry of the same publication returns the
   * sidecar's first message ids instead of sending twice.
   */
  async publish(
    threadId: string,
    publicationId: string,
    message: { text: string; files?: FileUpload[]; replyTo?: string },
  ): Promise<WhatsAppPublishResult> {
    if (!/^[\x21-\x7e]{1,120}$/.test(publicationId)) throw new Error("Invalid publication identity");
    const messageIds = await this.sendParts(threadId, `pub:${publicationId}`, message.text, message.files ?? [], message.replyTo);
    return { id: messageIds[messageIds.length - 1], threadId, raw: { messageIds }, text: message.text };
  }

  /** Ad hoc sends (setup and control notices) outside the publication outbox. */
  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<WhatsAppInboundEvent>> {
    const messageIds = await this.sendParts(threadId, `adhoc:${randomUUID()}`, textOf(message), filesOf(message));
    return { id: messageIds[messageIds.length - 1], threadId, raw: undefined as unknown as WhatsAppInboundEvent };
  }

  async editMessage(): Promise<never> {
    throw new WhatsAppSidecarError("rejected", "WhatsApp message edits are not supported");
  }

  async deleteMessage(): Promise<never> {
    throw new WhatsAppSidecarError("rejected", "WhatsApp message deletion is not supported");
  }

  async addReaction(): Promise<void> {
    /* Receipt reactions are not published on WhatsApp in phase 1. */
  }

  async removeReaction(): Promise<void> {
    /* Reactions never represent approvals. */
  }
}
