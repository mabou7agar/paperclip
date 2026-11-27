import { readFileSync } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

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
      "WhatsApp is not available on this instance: set PAPERCLIP_WHATSAPP_SIDECAR_URL and PAPERCLIP_WHATSAPP_SIDECAR_SECRET, or write secrets/whatsapp-sidecar.json in the instance folder",
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

/**
 * The instance file `secrets/whatsapp-sidecar.json` ({"url", "secret"}), used
 * when the environment does not set the sidecar. It lets an operator add the
 * sidecar to a running instance without changing the container environment.
 */
export function whatsAppSidecarFileEnv(
  file = path.join(resolvePaperclipInstanceRoot(), "secrets", "whatsapp-sidecar.json"),
): Record<string, string | undefined> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("secrets/whatsapp-sidecar.json is not valid JSON");
  }
  const value = (parsed ?? {}) as { url?: unknown; secret?: unknown };
  return {
    PAPERCLIP_WHATSAPP_SIDECAR_URL: typeof value.url === "string" ? value.url : undefined,
    PAPERCLIP_WHATSAPP_SIDECAR_SECRET: typeof value.secret === "string" ? value.secret : undefined,
  };
}

export function whatsAppSidecarConfig(
  env: Record<string, string | undefined> = process.env,
  fileEnv: () => Record<string, string | undefined> = () => whatsAppSidecarFileEnv(),
): WhatsAppSidecarConfig {
  const config = parseWhatsAppSidecarConfig(env) ?? parseWhatsAppSidecarConfig(fileEnv());
  if (!config) throw new WhatsAppSidecarUnconfiguredError();
  return config;
}
