import type { AiConnectionMetadata } from "@paperclipai/shared";
import type {
  ApiQuotaProbeOutcome,
  ApiQuotaProbeUsage,
} from "../types/api-quota-probe.js";
export type {
  ApiQuotaProbeOutcome,
  ApiQuotaProbeUsage,
} from "../types/api-quota-probe.js";
/** Provider selection authorizes the official origin when no custom route exists. */
export function messagesQuotaDestination(metadata: AiConnectionMetadata) {
  if (metadata.provider !== "anthropic" || metadata.method !== "api_key")
    return null;
  if (!metadata.routing)
    return { baseUrl: "https://api.anthropic.com", auth: "api_key" as const };
  return metadata.routing.protocol === "messages" && metadata.routing.baseUrl
    ? { baseUrl: metadata.routing.baseUrl, auth: metadata.routing.auth }
    : null;
}
const tokens = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 2147483647
    ? v
    : null;

/** A real, minimal Messages request, using only the already approved connection destination. */
export async function probeMessagesQuota(
  input: {
    baseUrl: string;
    auth: "bearer" | "api_key" | "none";
    credential: string;
    model: string;
  },
  request: typeof fetch = fetch,
): Promise<ApiQuotaProbeOutcome> {
  const unavailable: ApiQuotaProbeOutcome = {
    outcome: "unavailable",
    usage: null,
    retryAfterSeconds: null,
  };
  try {
    const url = new URL(
      input.baseUrl.replace(/\/$/, "") +
        (input.baseUrl.replace(/\/$/, "").endsWith("/v1")
          ? "/messages"
          : "/v1/messages"),
    );
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return unavailable;
    const response = await request(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(input.auth === "api_key"
          ? { "x-api-key": input.credential }
          : input.auth === "bearer"
            ? { Authorization: `Bearer ${input.credential}` }
            : {}),
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply OK." }],
      }),
    });
    const retry = response.headers.get("retry-after"),
      retryDate = retry ? Date.parse(retry) : NaN;
    const retryAfterSeconds =
      retry && /^\d+$/.test(retry)
        ? Math.min(31536000, Number(retry))
        : Number.isFinite(retryDate)
          ? Math.min(
              31536000,
              Math.max(0, Math.ceil((retryDate - Date.now()) / 1000)),
            )
          : null;
    const reader = response.body?.getReader();
    let bytes = 0,
      raw = "";
    const decoder = new TextDecoder();
    if (reader)
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65536) {
            await reader.cancel();
            return unavailable;
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return unavailable;
    }
    const u =
      body?.usage && typeof body.usage === "object"
        ? (body.usage as Record<string, unknown>)
        : {};
    const usage =
      tokens(u.input_tokens) !== null && tokens(u.output_tokens) !== null
        ? {
            inputTokens: tokens(u.input_tokens),
            outputTokens: tokens(u.output_tokens),
            cachedInputTokens: tokens(u.cache_read_input_tokens ?? 0),
            cacheWriteTokens: tokens(u.cache_creation_input_tokens ?? 0),
          }
        : null;
    return {
      outcome:
        response.ok &&
        body.type === "message" &&
        Array.isArray(body.content) &&
        body.content.some(
          (item: unknown) =>
            !!item &&
            typeof item === "object" &&
            "type" in item &&
            item.type === "text" &&
            "text" in item &&
            typeof item.text === "string" &&
            item.text.length > 0,
        )
          ? "available"
          : response.status === 429
            ? "quota"
            : [401, 403].includes(response.status)
              ? "authentication"
              : "unavailable",
      usage,
      retryAfterSeconds,
    };
  } catch {
    return unavailable;
  }
}
