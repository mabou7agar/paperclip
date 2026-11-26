/**
 * Instance settings for the WhatsApp sidecar. Read at call time so an operator
 * can add the sidecar without a code change; the secret is never logged or
 * serialized.
 */
export interface WhatsAppSidecarConfig {
  url: string;
  secret: string;
}

export class WhatsAppSidecarUnconfiguredError extends Error {
  constructor() {
    super(
      "WhatsApp is not available on this instance: set PAPERCLIP_WHATSAPP_SIDECAR_URL and PAPERCLIP_WHATSAPP_SIDECAR_SECRET",
    );
    this.name = "WhatsAppSidecarUnconfiguredError";
  }
}

export function parseWhatsAppSidecarConfig(
  env: Record<string, string | undefined>,
): WhatsAppSidecarConfig | null {
  const rawUrl = env.PAPERCLIP_WHATSAPP_SIDECAR_URL?.trim();
  const secret = env.PAPERCLIP_WHATSAPP_SIDECAR_SECRET?.trim();
  if (!rawUrl || !secret) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("PAPERCLIP_WHATSAPP_SIDECAR_URL must be an http(s) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("PAPERCLIP_WHATSAPP_SIDECAR_URL must be an http(s) URL without credentials, query or fragment");
  if (secret.length < 32)
    throw new Error("PAPERCLIP_WHATSAPP_SIDECAR_SECRET must be at least 32 characters");
  const config = { url: url.toString().replace(/\/+$/, "") } as WhatsAppSidecarConfig;
  Object.defineProperty(config, "secret", { value: secret, enumerable: false });
  return config;
}

export function whatsAppSidecarConfig(
  env: Record<string, string | undefined> = process.env,
): WhatsAppSidecarConfig {
  const config = parseWhatsAppSidecarConfig(env);
  if (!config) throw new WhatsAppSidecarUnconfiguredError();
  return config;
}
