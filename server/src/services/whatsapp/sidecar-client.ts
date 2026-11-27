import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";
import { whatsAppSidecarConfig, type WhatsAppSidecarConfig } from "./config.js";
import { whatsAppSignedHeaders } from "./signature.js";

export type WhatsAppLinkState =
  | "qr"
  | "pairing_code"
  | "linked"
  | "logged_out"
  | "connecting";

export interface WhatsAppLinkStatus {
  state: WhatsAppLinkState;
  qrPngDataUrl?: string;
  qrIssuedAt?: string;
  code?: string;
  /** Linked number, digits only (E.164 without "+"). */
  me?: string;
  lastError?: string;
}

export interface WhatsAppSendInput {
  jid: string;
  text?: string;
  media?: { base64: string; mimetype: string; fileName: string };
  quotedId?: string;
  idempotencyKey: string;
}

export type WhatsAppSidecarErrorCode =
  | "unavailable"
  | "unauthorized"
  | "not_linked"
  | "rejected"
  | "delivery_unknown"
  | "invalid_response";

export class WhatsAppSidecarError extends Error {
  constructor(
    readonly code: WhatsAppSidecarErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WhatsAppSidecarError";
  }
}

const LINK_STATES = new Set<WhatsAppLinkState>(["qr", "pairing_code", "linked", "logged_out", "connecting"]);
const ACCOUNT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const REQUEST_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 120_000;

function accountPath(accountId: string, suffix = ""): string {
  if (!ACCOUNT_ID.test(accountId)) throw new WhatsAppSidecarError("rejected", "Invalid WhatsApp account id");
  return `/accounts/${accountId}${suffix}`;
}

/** Closed parse of the sidecar's status document: unknown fields are dropped. */
export function parseWhatsAppLinkStatus(value: unknown): WhatsAppLinkStatus {
  if (!value || typeof value !== "object") throw new WhatsAppSidecarError("invalid_response", "WhatsApp sidecar returned an invalid status");
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== "string" || !LINK_STATES.has(raw.state as WhatsAppLinkState))
    throw new WhatsAppSidecarError("invalid_response", "WhatsApp sidecar returned an invalid status");
  const status: WhatsAppLinkStatus = { state: raw.state as WhatsAppLinkState };
  if (
    status.state === "qr" &&
    typeof raw.qrPngDataUrl === "string" &&
    raw.qrPngDataUrl.startsWith("data:image/png;base64,") &&
    raw.qrPngDataUrl.length < 200_000
  ) {
    status.qrPngDataUrl = raw.qrPngDataUrl;
    if (typeof raw.qrIssuedAt === "string" && !Number.isNaN(Date.parse(raw.qrIssuedAt))) status.qrIssuedAt = raw.qrIssuedAt;
  }
  if (status.state === "pairing_code" && typeof raw.code === "string" && /^[A-Z0-9-]{4,16}$/i.test(raw.code))
    status.code = raw.code;
  if (typeof raw.me === "string" && /^\d{6,20}$/.test(raw.me)) status.me = raw.me;
  if (typeof raw.lastError === "string" && /^[a-z_]{1,64}$/.test(raw.lastError)) status.lastError = raw.lastError;
  return status;
}

export class WhatsAppSidecarClient {
  constructor(
    private readonly configSource: () => WhatsAppSidecarConfig = () => whatsAppSidecarConfig(),
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const config = this.configSource();
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...whatsAppSignedHeaders({ secret: config.secret, method, path, body: text }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    };
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      return await this.fetchImpl(`${config.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : text,
        signal,
      });
    } catch {
      // Never surface fetch internals: they may echo the sidecar URL.
      throw new WhatsAppSidecarError(
        method === "POST" && path.endsWith("/send") ? "delivery_unknown" : "unavailable",
        "The WhatsApp service did not answer",
      );
    }
  }

  private async json(response: Response): Promise<Record<string, unknown>> {
    const value = await response.json().catch(() => null);
    if (!value || typeof value !== "object") throw new WhatsAppSidecarError("invalid_response", "WhatsApp service returned an invalid response", response.status);
    return value as Record<string, unknown>;
  }

  private async failure(response: Response, send = false): Promise<never> {
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const code = typeof body?.error === "string" ? body.error : "";
    if (response.status === 401) throw new WhatsAppSidecarError("unauthorized", "The WhatsApp service refused Paperclip's signature; check PAPERCLIP_WHATSAPP_SIDECAR_SECRET", 401);
    if (code === "not_linked") throw new WhatsAppSidecarError("not_linked", "WhatsApp is not linked for this channel", response.status);
    if (response.status >= 500 || response.status === 429)
      throw new WhatsAppSidecarError(send && response.status !== 429 ? "delivery_unknown" : "unavailable", "The WhatsApp service could not complete the request", response.status);
    const message = typeof body?.message === "string" && body.message.length <= 200 ? body.message : "WhatsApp rejected the request";
    throw new WhatsAppSidecarError("rejected", message, response.status);
  }

  async link(accountId: string, input: { mode: "qr" | "code"; phone?: string }): Promise<WhatsAppLinkStatus> {
    const response = await this.request("POST", accountPath(accountId, "/link"), {
      mode: input.mode,
      ...(input.mode === "code" ? { phone: input.phone } : {}),
    });
    if (!response.ok) return this.failure(response);
    return parseWhatsAppLinkStatus(await this.json(response));
  }

  async status(accountId: string): Promise<WhatsAppLinkStatus> {
    const response = await this.request("GET", accountPath(accountId, "/status"));
    if (!response.ok) return this.failure(response);
    return parseWhatsAppLinkStatus(await this.json(response));
  }

  async send(accountId: string, input: WhatsAppSendInput): Promise<{ messageId: string }> {
    const response = await this.request("POST", accountPath(accountId, "/send"), input, SEND_TIMEOUT_MS);
    if (!response.ok) return this.failure(response, true);
    const body = await this.json(response);
    if (typeof body.messageId !== "string" || !body.messageId || body.messageId.length > 256)
      throw new WhatsAppSidecarError("delivery_unknown", "WhatsApp service returned no message id");
    return { messageId: body.messageId };
  }

  async media(accountId: string, messageId: string, signal?: AbortSignal): Promise<Buffer> {
    if (!messageId || messageId.length > 256) throw new WhatsAppSidecarError("rejected", "Invalid WhatsApp media id");
    const response = await this.request("GET", accountPath(accountId, `/media/${encodeURIComponent(messageId)}`));
    if (!response.ok) return this.failure(response);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) throw new WhatsAppSidecarError("rejected", "Attachment exceeds the configured size limit");
    signal?.throwIfAborted();
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new WhatsAppSidecarError("rejected", "Attachment exceeds the configured size limit");
    return bytes;
  }

  async unlink(accountId: string): Promise<void> {
    const response = await this.request("DELETE", accountPath(accountId));
    if (!response.ok) await this.failure(response);
  }
}
