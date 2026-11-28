import { randomUUID } from "node:crypto";
import {
  Message,
  defaultEmojiResolver,
  parseMarkdown,
  stringifyMarkdown,
  type Adapter,
  type AdapterPostableMessage,
  type Attachment,
  type Author,
  type EmojiValue,
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
import { parseClientGroupCommand } from "../chat-channels/client-groups/core.js";
import {
  WhatsAppEventError,
  isWhatsAppGroupJid,
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
  WHATSAPP_PROMPT_TTL_MS,
  matchWhatsAppPromptReply,
  whatsAppPromptMessageKey,
  whatsAppPromptRecipientKeys,
  type WhatsAppPromptChoice,
  type WhatsAppPromptRecord,
} from "./prompts.js";
import type { WhatsAppState } from "./state.js";
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

/** Typing is refreshed while a run works, but never longer than this. */
export const WHATSAPP_TYPING_REFRESH_MS = 10_000;
export const WHATSAPP_TYPING_MAX_MS = 10 * 60_000;
/** A reply in a group quotes the asker's latest message when it is this recent. */
export const WHATSAPP_GROUP_QUOTE_MAX_AGE_MS = 30 * 60_000;

/** The chat a WhatsApp event belongs to: the group for a group message, else the sender's one-to-one chat. */
function chatJidOf(event: WhatsAppInboundEvent): string {
  return event.chatType === "group" && event.groupJid ? event.groupJid : event.fromJid;
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
 * which holds the linked-device socket. One-to-one chats and (phase 4) groups.
 */
export class WhatsAppChatAdapter implements Adapter<WhatsAppThread, WhatsAppInboundEvent> {
  readonly name = "whatsapp";
  readonly lockScope = "channel" as const;
  readonly botUserId: string;
  private chat: ChatInstance | null = null;
  private readonly typing = new Map<string, { timer: ReturnType<typeof setTimeout>; startedAt: number }>();
  /** Group thread -> latest inbound message (quoted by the next reply) and subject. */
  private readonly groupLatest = new Map<string, { messageId: string; at: number }>();
  private readonly groupSubjects = new Map<string, string>();
  /**
   * Set by the endpoint runtime: whether a card's interaction is still
   * pending. A reply to a card already answered elsewhere stays a message.
   */
  promptPending?: (interactionId: string) => Promise<boolean>;

  constructor(
    readonly userName: string,
    readonly identity: WhatsAppAdapterIdentity,
    private readonly configSource: () => WhatsAppSidecarConfig,
    readonly client: WhatsAppSidecarClient = new WhatsAppSidecarClient(configSource),
    /** Endpoint-scoped store for owner-card prompt receipts; absent in unit tests. */
    readonly state: WhatsAppState | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.botUserId = identity.phoneNumber;
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  async disconnect(): Promise<void> {
    this.chat = null;
    for (const { timer } of this.typing.values()) clearTimeout(timer);
    this.typing.clear();
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
    const { jid } = this.decodeThreadId(id);
    return !isWhatsAppGroupJid(jid);
  }

  async fetchThread(id: string): Promise<ThreadInfo> {
    const { jid } = this.decodeThreadId(id);
    if (isWhatsAppGroupJid(jid))
      return { id, channelId: id, channelName: this.groupSubjects.get(id) ?? "WhatsApp group", isDM: false, metadata: { jid } };
    const number = jid.endsWith("@s.whatsapp.net") ? `+${jid.split("@")[0]}` : "WhatsApp contact";
    return { id, channelId: id, channelName: number, isDM: true, metadata: { jid } };
  }

  async fetchChannelInfo(id: string) {
    const info = await this.fetchThread(id);
    return { id, name: info.channelName, isDM: info.isDM, metadata: info.metadata };
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

  private author(raw: WhatsAppInboundEvent): Author {
    const userId = whatsAppExternalPrincipalId(raw);
    const handle = raw.fromPhone ? `+${raw.fromPhone}` : raw.fromUsername ? `@${raw.fromUsername}` : userId;
    return { userId, userName: handle, fullName: raw.pushName?.trim() || handle, isBot: false, isMe: false };
  }

  parseMessage(raw: WhatsAppInboundEvent): Message<WhatsAppInboundEvent> {
    const threadId = this.encodeThreadId({ accountId: this.identity.accountId, jid: chatJidOf(raw) });
    const group = raw.chatType === "group";
    if (group) {
      this.groupLatest.set(threadId, { messageId: raw.messageId, at: this.now() });
      if (raw.groupSubject) this.groupSubjects.set(threadId, raw.groupSubject);
      for (const map of [this.groupLatest, this.groupSubjects]) while (map.size > 1000) map.delete(map.keys().next().value!);
    }
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
      author: this.author(raw),
      metadata: { dateSent: new Date(raw.timestamp), edited: false },
      // In a group the bot is addressed by a mention, a reply to its message,
      // or a /client command; a client group's customers are admitted by
      // Paperclip without one. One-to-one chats are always addressed.
      ...(group ? { isMention: raw.mentionsMe === true || parseClientGroupCommand(raw.text) !== null } : {}),
    });
  }

  /** The edited message as Paperclip knows it: the original id with the new text. */
  parseEdit(raw: WhatsAppInboundEvent): Message<WhatsAppInboundEvent> {
    const threadId = this.encodeThreadId({ accountId: this.identity.accountId, jid: chatJidOf(raw) });
    return new Message({
      id: raw.targetId!,
      threadId,
      text: raw.text,
      formatted: parseMarkdown(raw.text),
      raw,
      attachments: [],
      author: this.author(raw),
      metadata: { dateSent: new Date(raw.timestamp), edited: true, editedAt: new Date(raw.timestamp) },
    });
  }

  // ---- Owner cards as numbered text prompts -------------------------------

  /**
   * File a published card prompt under its message ids and its recipient, so
   * a later numbered reply (or a quote of the prompt) can be mapped back to
   * the card's opaque action id.
   */
  async rememberPrompt(
    prompt: Omit<WhatsAppPromptRecord, "version" | "expiresAt" | "threadId" | "messageId">,
    threadId: string,
    messageIds: string[],
  ): Promise<void> {
    if (!this.state || !messageIds.length) return;
    const { jid } = this.decodeThreadId(threadId);
    const record: WhatsAppPromptRecord = {
      version: 1,
      ...prompt,
      threadId,
      messageId: messageIds[messageIds.length - 1],
      expiresAt: this.now() + WHATSAPP_PROMPT_TTL_MS,
    };
    const expiresAt = new Date(record.expiresAt);
    for (const id of messageIds) await this.state.write(whatsAppPromptMessageKey(id), record, expiresAt);
    // In a group only a quote of the prompt answers it: a bare number from
    // anyone in the group must not be read as the owner's answer.
    if (isWhatsAppGroupJid(jid)) return;
    const [user, server] = jid.split("@");
    const keys = whatsAppPromptRecipientKeys(server === "lid" ? { fromLid: user } : { fromPhone: user });
    for (const key of keys) await this.state.write(key, record, expiresAt);
  }

  private async promptFor(event: WhatsAppInboundEvent): Promise<{ record: WhatsAppPromptRecord; recipientKeys: string[] } | null> {
    if (!this.state) return null;
    const recipientKeys = whatsAppPromptRecipientKeys(event);
    const usable = (record: WhatsAppPromptRecord | null) =>
      record && record.version === 1 && record.expiresAt > this.now() ? record : null;
    if (event.quotedId) {
      const quoted = usable(await this.state.read<WhatsAppPromptRecord>(whatsAppPromptMessageKey(event.quotedId)));
      if (quoted && (event.chatType !== "group" || quoted.threadId === this.encodeThreadId({ accountId: this.identity.accountId, jid: chatJidOf(event) })))
        return { record: quoted, recipientKeys: event.chatType === "group" ? [] : recipientKeys };
    }
    if (event.chatType === "group") return null;
    for (const key of recipientKeys) {
      const latest = usable(await this.state.read<WhatsAppPromptRecord>(key));
      if (latest) return { record: latest, recipientKeys };
    }
    return null;
  }

  /**
   * A reply that answers the latest (or quoted) card prompt becomes a normal
   * Chat SDK action with the card's opaque action id. Paperclip's action
   * handler then checks everything a button press is checked for: the sender
   * must be linked to an active, non-viewer member, the card must still be
   * pending, and the action must belong to that exact published message. A
   * customer's "1" is therefore refused there, never executed.
   */
  private async dispatchPromptReply(event: WhatsAppInboundEvent, options?: WebhookOptions): Promise<boolean> {
    if (!this.chat || event.media || !event.text.trim()) return false;
    const found = await this.promptFor(event);
    if (!found) return false;
    const choice: WhatsAppPromptChoice | null = matchWhatsAppPromptReply(found.record, event.text);
    if (!choice) return false;
    const clear = async () => {
      for (const key of found.recipientKeys) await this.state!.write(key, null, new Date(this.now() + 60_000));
    };
    if (this.promptPending && !(await this.promptPending(found.record.interactionId))) {
      await clear();
      return false;
    }
    // One reply answers one prompt: later bare numbers are ordinary messages.
    await clear();
    await this.chat.processAction(
      {
        adapter: this,
        actionId: choice.actionId,
        value: found.record.interactionId,
        messageId: found.record.messageId,
        threadId: found.record.threadId,
        user: this.author(event),
        raw: event,
      },
      options,
    );
    return true;
  }

  // ---- Reactions -----------------------------------------------------------

  private reactionKey(event: WhatsAppInboundEvent): string {
    return `reaction:${whatsAppExternalPrincipalId(event)}:${event.targetId}`;
  }

  /**
   * WhatsApp reports a removed reaction as an empty emoji; the last emoji the
   * sender put on that message (kept for a day) names what was removed.
   */
  private async dispatchReaction(event: WhatsAppInboundEvent, options?: WebhookOptions): Promise<void> {
    if (!this.chat || !event.targetId) return;
    const threadId = this.encodeThreadId({ accountId: this.identity.accountId, jid: chatJidOf(event) });
    let rawEmoji = event.emoji ?? "";
    const added = rawEmoji !== "";
    if (this.state) {
      const key = this.reactionKey(event);
      if (added) await this.state.write(key, { emoji: rawEmoji }, new Date(this.now() + 24 * 3600_000));
      else {
        rawEmoji = (await this.state.read<{ emoji?: string }>(key))?.emoji ?? "";
        await this.state.write(key, null, new Date(this.now() + 60_000));
      }
    }
    if (!rawEmoji) return; // a removal we cannot name is dropped
    this.chat.processReaction(
      {
        adapter: this,
        added,
        emoji: defaultEmojiResolver.fromGChat(rawEmoji),
        rawEmoji,
        messageId: event.targetId,
        threadId,
        user: this.author(event),
        raw: event,
      },
      options,
    );
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
    if (event.type === "reaction") {
      await this.dispatchReaction(event, options);
      return json(200, { ok: true });
    }
    if (event.type === "edit") {
      const edited = this.parseEdit(event);
      void this.chat.processMessageUpdated({ adapter: this, threadId: edited.threadId, message: edited }, options).catch(() => undefined);
      return json(200, { ok: true });
    }
    if (await this.dispatchPromptReply(event, options).catch(() => false)) return json(200, { ok: true });
    const message = this.parseMessage(event);
    void this.chat.processMessage(this, message.threadId, message, options).catch(() => undefined);
    return json(200, { ok: true });
  }

  renderFormatted(content: FormattedContent): string {
    return markdownToWhatsApp(stringifyMarkdown(content));
  }

  /**
   * "composing" while an agent run works for this chat, refreshed every few
   * seconds (WhatsApp clears it after ~25 s) and capped, then "paused" when
   * the reply is published or the run ends. Presence is best effort.
   */
  async startTyping(threadId: string): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    const current = this.typing.get(threadId);
    if (current) clearTimeout(current.timer);
    const startedAt = current?.startedAt ?? this.now();
    await this.client.presence(this.identity.accountId, { jid, state: "composing" }).catch(() => undefined);
    if (this.now() - startedAt >= WHATSAPP_TYPING_MAX_MS) {
      this.typing.delete(threadId);
      await this.client.presence(this.identity.accountId, { jid, state: "paused" }).catch(() => undefined);
      return;
    }
    const timer = setTimeout(() => {
      if (this.typing.get(threadId)?.timer !== timer) return;
      void this.startTyping(threadId).catch(() => undefined);
    }, WHATSAPP_TYPING_REFRESH_MS);
    timer.unref?.();
    this.typing.set(threadId, { timer, startedAt });
  }

  async endTyping(threadId: string): Promise<void> {
    const current = this.typing.get(threadId);
    if (!current) return;
    clearTimeout(current.timer);
    this.typing.delete(threadId);
    const { jid } = this.decodeThreadId(threadId);
    await this.client.presence(this.identity.accountId, { jid, state: "paused" }).catch(() => undefined);
  }

  isTyping(threadId: string): boolean {
    return this.typing.has(threadId);
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
    await this.endTyping(threadId);
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
    const messageIds = await this.sendParts(threadId, `pub:${publicationId}`, message.text, message.files ?? [], message.replyTo ?? this.groupQuote(threadId));
    return { id: messageIds[messageIds.length - 1], threadId, raw: { messageIds }, text: message.text };
  }

  /** In a group, a reply quotes the latest message there so the asker sees it is for them. */
  private groupQuote(threadId: string): string | undefined {
    const latest = this.groupLatest.get(threadId);
    return latest && this.now() - latest.at <= WHATSAPP_GROUP_QUOTE_MAX_AGE_MS ? latest.messageId : undefined;
  }

  /** Ad hoc sends (setup and control notices) outside the publication outbox. */
  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<WhatsAppInboundEvent>> {
    const messageIds = await this.sendParts(threadId, `adhoc:${randomUUID()}`, textOf(message), filesOf(message), this.groupQuote(threadId));
    return { id: messageIds[messageIds.length - 1], threadId, raw: undefined as unknown as WhatsAppInboundEvent };
  }

  /**
   * Edit a text message this channel sent. WhatsApp allows edits for 15
   * minutes; the sidecar refuses older or foreign messages. Files cannot be
   * edited. Paperclip's publication outbox keeps posting new messages
   * (capabilities.messageEdits stays false), so this serves direct callers.
   */
  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage): Promise<RawMessage<WhatsAppInboundEvent>> {
    const { jid } = this.decodeThreadId(threadId);
    if (filesOf(message).length) throw new WhatsAppSidecarError("rejected", "WhatsApp cannot add files to an edited message");
    const text = markdownToWhatsApp(textOf(message)).trim();
    if (!text) throw new WhatsAppSidecarError("rejected", "An edited WhatsApp message needs text");
    if (Array.from(text).length > 4000) throw new WhatsAppSidecarError("rejected", "An edited WhatsApp message is too long");
    const edited = await this.client.edit(this.identity.accountId, { jid, messageId, text });
    return { id: edited.messageId, threadId, raw: undefined as unknown as WhatsAppInboundEvent };
  }

  async deleteMessage(): Promise<never> {
    throw new WhatsAppSidecarError("rejected", "WhatsApp message deletion is not supported");
  }

  /** React to a message in this chat. Reactions never represent approvals. */
  async addReaction(threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    const unicode = defaultEmojiResolver.toGChat(emoji);
    if (!unicode) return;
    await this.client.react(this.identity.accountId, { jid, messageId, emoji: unicode });
  }

  /** WhatsApp keeps one reaction per person per message: removing sends an empty reaction. */
  async removeReaction(threadId: string, messageId: string, _emoji: EmojiValue | string): Promise<void> {
    const { jid } = this.decodeThreadId(threadId);
    await this.client.react(this.identity.accountId, { jid, messageId, emoji: "" });
  }
}
