import { describe, expect, it } from "vitest";
import { managedAgentConnectionNeedsValidation } from "./agent-configuration.js";

const previous = {
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-5", env: { EXAMPLE: "value" } },
  defaultEnvironmentId: null,
  runtimeConfig: { aiConnection: { mode: "responsible_user", method: "subscription", provider: "anthropic" } },
};

describe("managed connection revalidation scope", () => {
  it("allows unrelated settings and JSONB key ordering without another provider probe", () => {
    expect(managedAgentConnectionNeedsValidation(previous, { ...previous,
      adapterConfig: { env: { EXAMPLE: "value" }, model: "claude-sonnet-5" },
      runtimeConfig: { heartbeat: { enabled: false }, phaseRouting: { enabled: true },
        aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" } },
    })).toBe(false);
  });

  it.each([
    { adapterType: "codex_local" },
    { adapterConfig: { model: "claude-opus-5" } },
    { defaultEnvironmentId: "different-environment" },
    { runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } } },
  ])("revalidates actual execution changes: %j", change => {
    expect(managedAgentConnectionNeedsValidation(previous, { ...previous, ...change })).toBe(true);
  });
});
