import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request signing shared with the WhatsApp sidecar (its src/signature.js).
 * Both directions use one instance secret. The signed bytes are
 *   "v1\n" + METHOD + "\n" + path-with-query + "\n" + timestamp + "\n" + body
 * and the header value is "v1=" + hex(HMAC-SHA256(secret, bytes)). The
 * timestamp is unix milliseconds and must fall inside the replay window.
 */
export const WHATSAPP_SIGNATURE_HEADER = "x-whatsapp-sidecar-signature";
export const WHATSAPP_TIMESTAMP_HEADER = "x-whatsapp-sidecar-timestamp";
export const WHATSAPP_REPLAY_WINDOW_MS = 5 * 60_000;

export type WhatsAppSignatureFailure =
  | "unconfigured"
  | "missing"
  | "malformed"
  | "stale"
  | "mismatch";

function bodyBytes(body: string | Uint8Array | undefined | null): Buffer {
  if (body === undefined || body === null) return Buffer.alloc(0);
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
}

export function whatsAppSignature(input: {
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  body?: string | Uint8Array | null;
}): string {
  if (!input.secret) throw new Error("WhatsApp sidecar secret is not configured");
  const hmac = createHmac("sha256", input.secret);
  hmac.update(`v1\n${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n`);
  hmac.update(bodyBytes(input.body));
  return `v1=${hmac.digest("hex")}`;
}

export function whatsAppSignedHeaders(input: {
  secret: string;
  method: string;
  path: string;
  body?: string | Uint8Array | null;
  now?: number;
}): Record<string, string> {
  const timestamp = String(Math.trunc(input.now ?? Date.now()));
  return {
    [WHATSAPP_TIMESTAMP_HEADER]: timestamp,
    [WHATSAPP_SIGNATURE_HEADER]: whatsAppSignature({ ...input, timestamp }),
  };
}

/** Constant-time verification with a bounded replay window. Never throws. */
export function verifyWhatsAppSignature(input: {
  secret: string | null | undefined;
  method: string;
  path: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body?: string | Uint8Array | null;
  now?: number;
  windowMs?: number;
}): { ok: true } | { ok: false; reason: WhatsAppSignatureFailure } {
  if (!input.secret) return { ok: false, reason: "unconfigured" };
  const { timestamp, signature } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing" };
  if (!/^\d{1,16}$/.test(timestamp)) return { ok: false, reason: "malformed" };
  const at = Number(timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(at) || Math.abs(now - at) > (input.windowMs ?? WHATSAPP_REPLAY_WINDOW_MS))
    return { ok: false, reason: "stale" };
  if (!/^v1=[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(
    whatsAppSignature({ secret: input.secret, method: input.method, path: input.path, timestamp, body: input.body }),
  );
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    return { ok: false, reason: "mismatch" };
  return { ok: true };
}
