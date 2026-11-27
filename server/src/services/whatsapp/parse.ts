/**
 * Closed parsing for WhatsApp sidecar events and Paperclip's WhatsApp
 * conversation identities. Nothing here trusts a field the sidecar did not
 * sign; the signature is checked before parseWhatsAppInboundEvent runs.
 */

export interface WhatsAppInboundMedia {
  /** Sidecar media handle: the WhatsApp message id that carried it. */
  id: string;
  mimetype: string;
  fileName: string;
  size: number;
  kind: "image" | "audio" | "video" | "document";
  voice: boolean;
  sha256?: string;
}

export interface WhatsAppInboundEvent {
  version: 1;
  accountId: string;
  messageId: string;
  timestamp: number;
  /** One-to-one chat JID, without a device suffix. */
  fromJid: string;
  /** Sender number, digits only, when WhatsApp or the LID mapping revealed it. */
  fromPhone: string | null;
  /** Sender hidden id (LID user part) when the chat is addressed by LID. */
  fromLid: string | null;
  pushName: string | null;
  text: string;
  quotedId: string | null;
  media?: WhatsAppInboundMedia;
}

export class WhatsAppEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppEventError";
  }
}

const ACCOUNT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MESSAGE_ID = /^[\x21-\x7e]{1,256}$/;
const PERSONAL_JID = /^(\d{3,32})@(s\.whatsapp\.net|lid)$/;
const MAX_TEXT = 64 * 1024;
const MEDIA_KINDS = new Set(["image", "audio", "video", "document"]);

export function isPersonalWhatsAppJid(jid: string): boolean {
  return PERSONAL_JID.test(jid);
}

function str(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new WhatsAppEventError(`Invalid WhatsApp event field: ${field}`);
  return value;
}

function optionalStr(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return str(value, field, max);
}

function safeFileName(value: string): string {
  return value.replace(/[\\/\0\r\n"]+/g, "_").slice(0, 120) || "file";
}

export function parseWhatsAppInboundEvent(value: unknown, expectedAccountId: string): WhatsAppInboundEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WhatsAppEventError("WhatsApp event must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new WhatsAppEventError("Unsupported WhatsApp event version");
  const accountId = str(raw.accountId, "accountId", 64);
  if (!ACCOUNT_ID.test(accountId) || accountId !== expectedAccountId)
    throw new WhatsAppEventError("WhatsApp event belongs to another channel");
  const messageId = str(raw.messageId, "messageId", 256);
  if (!MESSAGE_ID.test(messageId)) throw new WhatsAppEventError("Invalid WhatsApp message id");
  const timestamp = raw.timestamp;
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0)
    throw new WhatsAppEventError("Invalid WhatsApp event timestamp");
  const fromJid = str(raw.fromJid, "fromJid", 80);
  const jidMatch = PERSONAL_JID.exec(fromJid);
  if (!jidMatch) throw new WhatsAppEventError("WhatsApp event is not from a one-to-one chat");
  let fromPhone = optionalStr(raw.fromPhone, "fromPhone", 32);
  if (fromPhone !== null && !/^\d{6,20}$/.test(fromPhone)) throw new WhatsAppEventError("Invalid WhatsApp sender number");
  let fromLid = optionalStr(raw.fromLid, "fromLid", 40);
  if (fromLid !== null && !/^\d{3,32}$/.test(fromLid)) throw new WhatsAppEventError("Invalid WhatsApp sender hidden id");
  // The chat JID is authoritative: a phone JID fixes the number, a LID JID fixes the hidden id.
  if (jidMatch[2] === "s.whatsapp.net") {
    if (fromPhone !== null && fromPhone !== jidMatch[1]) throw new WhatsAppEventError("WhatsApp sender number does not match its chat");
    fromPhone = jidMatch[1];
    fromLid = null;
  } else {
    if (fromLid !== null && fromLid !== jidMatch[1]) throw new WhatsAppEventError("WhatsApp sender hidden id does not match its chat");
    fromLid = jidMatch[1];
  }
  const pushName = optionalStr(raw.pushName, "pushName", 200);
  const text = typeof raw.text === "string" ? raw.text.slice(0, MAX_TEXT) : "";
  const quotedId = optionalStr(raw.quotedId, "quotedId", 256);
  const event: WhatsAppInboundEvent = {
    version: 1,
    accountId,
    messageId,
    timestamp,
    fromJid,
    fromPhone,
    fromLid,
    pushName,
    text,
    quotedId: quotedId && MESSAGE_ID.test(quotedId) ? quotedId : null,
  };
  if (raw.media !== undefined && raw.media !== null) {
    if (typeof raw.media !== "object" || Array.isArray(raw.media)) throw new WhatsAppEventError("Invalid WhatsApp media");
    const media = raw.media as Record<string, unknown>;
    const id = str(media.id, "media.id", 256);
    if (id !== messageId) throw new WhatsAppEventError("WhatsApp media does not belong to its message");
    const mimetype = str(media.mimetype, "media.mimetype", 128).toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimetype)) throw new WhatsAppEventError("Invalid WhatsApp media type");
    const size = media.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new WhatsAppEventError("Invalid WhatsApp media size");
    const kind = typeof media.kind === "string" && MEDIA_KINDS.has(media.kind) ? (media.kind as WhatsAppInboundMedia["kind"]) : "document";
    const sha256 = typeof media.sha256 === "string" && /^[0-9a-f]{64}$/.test(media.sha256) ? media.sha256 : undefined;
    event.media = {
      id,
      mimetype,
      fileName: safeFileName(str(media.fileName, "media.fileName", 256)),
      size,
      kind,
      voice: media.voice === true,
      ...(sha256 ? { sha256 } : {}),
    };
  }
  return event;
}

/**
 * Stable Paperclip principal id for a WhatsApp sender: the phone number in
 * E.164 digits (no "+"). A sender known only by hidden id stays "lid:<id>",
 * which never matches a phone number and so can never be linked by number.
 */
export function whatsAppExternalPrincipalId(event: Pick<WhatsAppInboundEvent, "fromPhone" | "fromLid">): string {
  if (event.fromPhone) return event.fromPhone;
  if (event.fromLid) return `lid:${event.fromLid}`;
  throw new WhatsAppEventError("WhatsApp sender has no stable identity");
}

/** Principal id from a stored raw event, or null when it carries no usable sender. */
export function whatsAppPrincipalIdFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { fromPhone?: unknown; fromLid?: unknown };
  if (typeof value.fromPhone === "string" && /^\d{6,20}$/.test(value.fromPhone)) return value.fromPhone;
  if (typeof value.fromLid === "string" && /^\d{3,32}$/.test(value.fromLid)) return `lid:${value.fromLid}`;
  return null;
}

export interface WhatsAppThread {
  accountId: string;
  jid: string;
}

export function whatsAppThreadId(value: WhatsAppThread): string {
  if (!ACCOUNT_ID.test(value.accountId)) throw new Error("Invalid WhatsApp account id");
  if (!isPersonalWhatsAppJid(value.jid)) throw new Error("WhatsApp conversations must be one-to-one chats");
  return `whatsapp:${value.accountId}:d:${Buffer.from(value.jid).toString("base64url")}`;
}

export function parseWhatsAppThreadId(value: string): WhatsAppThread {
  const match = /^whatsapp:([A-Za-z0-9_-]{8,64}):d:([A-Za-z0-9_-]{1,256})$/.exec(value);
  if (!match) throw new Error("Invalid WhatsApp conversation identity");
  const jid = Buffer.from(match[2], "base64url").toString("utf8");
  if (Buffer.from(jid).toString("base64url") !== match[2] || !isPersonalWhatsAppJid(jid))
    throw new Error("Invalid WhatsApp chat identity");
  return { accountId: match[1], jid };
}

/** WhatsApp has no Markdown; keep bold/italic/code readable in its own syntax. */
export function markdownToWhatsApp(input: string): string {
  const parts = input.replace(/\r\n/g, "\n").split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```")) return part;
      return part
        .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "*$1*")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)");
    })
    .join("");
}

/** Split long text on paragraph boundaries; WhatsApp accepts ~65k but long bubbles read badly. */
export function splitWhatsAppText(text: string, maximum = 4000): string[] {
  const points = Array.from(text);
  const result: string[] = [];
  while (points.length > maximum) {
    const candidate = points.slice(0, maximum).join("");
    const paragraph = candidate.lastIndexOf("\n\n");
    const count = paragraph >= maximum / 2 ? Array.from(candidate.slice(0, paragraph + 2)).length : maximum;
    result.push(points.splice(0, count).join(""));
  }
  if (points.length) result.push(points.join(""));
  return result;
}
