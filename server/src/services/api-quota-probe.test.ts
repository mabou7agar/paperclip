import { expect, it, vi } from "vitest";
import {
  messagesQuotaDestination,
  probeMessagesQuota,
} from "./api-quota-probe.js";
const input = {
  baseUrl: "https://gateway.example",
  auth: "bearer" as const,
  credential: "test-key",
  model: "test-model",
};
it("uses the official Anthropic origin only for a standard API connection", async () => {
  const destination = messagesQuotaDestination({
    provider: "anthropic",
    method: "api_key",
  });
  expect(destination).toEqual({
    baseUrl: "https://api.anthropic.com",
    auth: "api_key",
  });
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "OK" }],
        }),
      ),
  );
  await probeMessagesQuota(
    { ...input, ...destination! },
    request as typeof fetch,
  );
  const [url, options] = request.mock.calls[0] as unknown as [URL, RequestInit];
  expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
  expect(options).toMatchObject({ headers: { "x-api-key": "test-key" } });
  expect(
    messagesQuotaDestination({ provider: "anthropic", method: "subscription" }),
  ).toBeNull();
  expect(
    messagesQuotaDestination({ provider: "openai", method: "api_key" }),
  ).toBeNull();
  expect(
    messagesQuotaDestination({
      provider: "anthropic",
      method: "api_key",
      routing: {
        kind: "gateway",
        protocol: "responses",
        baseUrl: "https://custom.example",
        auth: "bearer",
        models: [],
      },
    }),
  ).toBeNull();
  expect(
    messagesQuotaDestination({
      provider: "anthropic",
      method: "api_key",
      routing: {
        kind: "gateway",
        protocol: "messages",
        baseUrl: "https://custom.example",
        auth: "bearer",
        models: [],
      },
    }),
  ).toEqual({ baseUrl: "https://custom.example", auth: "bearer" });
});
it("makes one bounded inference request without task context or cache controls", async () => {
  const request = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "OK" }],
          usage: { input_tokens: 14, output_tokens: 5 },
        }),
      ),
  );
  expect(
    await probeMessagesQuota(input, request as typeof fetch),
  ).toMatchObject({
    outcome: "available",
    usage: { inputTokens: 14, outputTokens: 5, cacheWriteTokens: 0 },
  });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, options] = request.mock.calls[0] as unknown as [URL, RequestInit];
  expect(String(url)).toBe("https://gateway.example/v1/messages");
  expect(options.redirect).toBe("error");
  expect(JSON.parse(options.body as string)).toEqual({
    model: "test-model",
    max_tokens: 8,
    messages: [{ role: "user", content: "Reply OK." }],
  });
  expect(options.headers).toMatchObject({ Authorization: "Bearer test-key" });
});
it.each([429, 401, 403, 500])(
  "keeps missing usage unknown after HTTP %i and respects Retry-After",
  async (status) => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "never return provider text or credentials" },
          }),
          { status, headers: { "retry-after": "172800" } },
        ),
    );
    const result = await probeMessagesQuota(input, request as typeof fetch);
    expect(result.usage).toBeNull();
    expect(result.retryAfterSeconds).toBe(172800);
    expect(result.outcome).toBe(
      status === 429
        ? "quota"
        : status < 500
          ? "authentication"
          : "unavailable",
    );
    expect(JSON.stringify(result)).not.toContain("credentials");
    expect(request).toHaveBeenCalledTimes(1);
  },
);
it("rejects an auth-only or malformed success and bounds response bytes", async () => {
  for (const body of [
    { models: [] },
    { type: "message", content: [] },
    "x".repeat(70000),
  ]) {
    const result = await probeMessagesQuota(
      input,
      (async () => new Response(JSON.stringify(body))) as typeof fetch,
    );
    expect(result.outcome).toBe("unavailable");
  }
});
it("never forwards credentials to an invalid destination or follows redirects", async () => {
  const request = vi.fn();
  for (const baseUrl of [
    "http://gateway.example",
    "https://user:pass@gateway.example",
    "https://gateway.example?key=x",
  ]) {
    expect(
      (await probeMessagesQuota({ ...input, baseUrl }, request)).outcome,
    ).toBe("unavailable");
  }
  expect(request).not.toHaveBeenCalled();
});
it("leaves transport ambiguity unmeasured and never retries", async () => {
  const request = vi.fn(async () => {
    throw new Error("private provider error");
  });
  expect(await probeMessagesQuota(input, request)).toEqual({
    outcome: "unavailable",
    usage: null,
    retryAfterSeconds: null,
  });
  expect(request).toHaveBeenCalledTimes(1);
});
