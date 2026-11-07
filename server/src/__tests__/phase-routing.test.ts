import { beforeEach, describe, expect, it, vi } from "vitest";
import { phaseRoutingSchema, type PhaseRouteProfile } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

const { select, latestEvidence, getDefaults } = vi.hoisted(() => ({ select: vi.fn(), latestEvidence: vi.fn(), getDefaults: vi.fn() }));
vi.mock("../services/ai-connections.js", () => ({ aiConnectionService: () => ({ select }) }));
vi.mock("../repositories/provider-quota.js", () => ({ providerQuotaRepository: () => ({ latestEvidence }) }));
vi.mock("../repositories/phase-routing-settings.js", () => ({ phaseRoutingSettingsRepository: () => ({ get: getDefaults }) }));
import { phaseRouteAdapterConfig, phaseRouteTaskKey, phaseRoutingService, quotaCooldownUntil } from "../services/phase-routing.js";

const claude: PhaseRouteProfile = { id: "claude", adapterType: "claude_local", model: "claude-model", binding: { provider: "anthropic", method: "subscription", mode: "responsible_user" } };
const codex: PhaseRouteProfile = { id: "codex", adapterType: "codex_local", model: "codex-model", binding: { provider: "openai", method: "subscription", mode: "responsible_user" } };
const policy = phaseRoutingSchema.parse({ enabled: true, planning: [claude, codex], implementation: [codex] });
const now = new Date("2026-11-07T10:00:00Z");
const input = { companyId: "company", agentId: "agent", userId: "user", adapterType: "claude_local", runtimeConfig: { phaseRouting: policy }, workMode: "planning", isConversation: false, now };
const service = () => phaseRoutingService({} as never);

beforeEach(() => {
  select.mockReset().mockImplementation(async ({ binding }) => ({
    connection: { id: binding.provider === "anthropic" ? "10000000-0000-4000-8000-000000000001" : "10000000-0000-4000-8000-000000000002" },
    grant: { id: "20000000-0000-4000-8000-000000000001", kind: "user" },
    attribution: { provider: binding.provider, method: binding.method },
  }));
  latestEvidence.mockReset().mockResolvedValue(null);
  getDefaults.mockReset().mockResolvedValue(null);
});

describe("phase routing", () => {
  it.each([
    { runtimeConfig: {} }, { runtimeConfig: { phaseRouting: { ...policy, enabled: false } } },
    { isConversation: true }, { workMode: "ask" }, { workMode: undefined }, { adapterType: "paperclip_runner" },
  ])("preserves existing behavior outside configured task phases: %j", async patch => {
    expect(await service().resolve({ ...input, ...patch })).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("uses Claude for planning and Codex for implementation", async () => {
    expect((await service().resolve(input))?.profile?.id).toBe("claude");
    expect((await service().resolve({ ...input, workMode: "standard" }))?.profile?.id).toBe("codex");
  });

  it("inherits company defaults while allowing an agent to override or disable them", async () => {
    getDefaults.mockResolvedValue(policy);
    expect((await service().resolve({ ...input, runtimeConfig: {} }))?.profile?.id).toBe("claude");
    expect(await service().resolve({ ...input, runtimeConfig: { phaseRouting: { ...policy, enabled: false } } })).toBeNull();
    expect((await service().resolve({ ...input, runtimeConfig: { phaseRouting: { ...policy, planning: [codex] } } }))?.profile?.id).toBe("codex");
  });

  it("accepts an ordered chain of arbitrary depth", async () => {
    const chain = Array.from({ length: 12 }, (_, i) => ({ ...codex, id: `level-${i}` }));
    expect(phaseRoutingSchema.safeParse({ ...policy, planning: chain }).success).toBe(true);
    expect((await service().resolve({ ...input, runtimeConfig: { phaseRouting: { ...policy, planning: chain } } }))?.maxFallbackAttempts).toBe(11);
    expect((await service().resolve({ ...input, afterProfileId: "claude" }))?.profile?.id).toBe("codex");
  });

  it("skips an exhausted account using durable receipts without a provider probe", async () => {
    latestEvidence.mockImplementation(async (_company, connectionId) => connectionId.endsWith("1")
      ? { status: "failed", finishedAt: now, result: { providerQuotaRetryNotBefore: "2026-11-08T10:00:00Z" } }
      : null);
    const result = await service().resolve(input);
    expect(result?.profile?.id).toBe("codex");
    expect(result?.maxFallbackAttempts).toBe(1);
    expect(result?.notes).toHaveLength(1);
    expect(latestEvidence).toHaveBeenCalledWith("company", expect.any(String), now);
    // Pin the resolved account, even when the responsible user's default changes.
    expect(result?.profile?.binding.mode).toBe("delegated");
  });

  it("waits until the first reset when all accounts are exhausted", async () => {
    latestEvidence.mockResolvedValue({ status: "failed", finishedAt: now, result: { retryNotBefore: "2026-11-07T15:00:00Z" } });
    const route = await service().resolve(input);
    expect(route).toMatchObject({ profile: null, retryAt: "2026-11-07T15:00:00.000Z" });
    expect(route?.notes).toHaveLength(2);
  });

  it("does not silently fall back on revoked access", async () => {
    select.mockRejectedValue(forbidden("Access was revoked"));
    const route = await service().resolve(input);
    expect(route).toMatchObject({ profile: null, retryAt: null });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("requires board configuration and validates every profile without inference", async () => {
    await expect(service().validateConfiguration({ ...input, policy, isBoard: false })).rejects.toThrow("Only the board");
    await service().validateConfiguration({ ...input, policy, isBoard: true });
    expect(select).toHaveBeenCalledTimes(3);
    await expect(service().validateConfiguration({ ...input, adapterType: "process", policy, isBoard: true })).rejects.toThrow("supports Claude");
  });

  it("isolates native sessions by phase and resolved account", async () => {
    const route = (await service().resolve({ ...input, workMode: "standard" }))!;
    const key = phaseRouteTaskKey("task", route);
    expect(phaseRouteTaskKey("task", route)).toBe(key);
    expect(phaseRouteTaskKey("task", { ...route, phase: "planning" })).not.toBe(key);
    expect(phaseRouteTaskKey("task", { ...route, connectionId: "other" })).not.toBe(key);
  });

  it("shares instructions and workspace settings while stripping harness commands and auth", () => {
    const config = phaseRouteAdapterConfig({ cwd: "/workspace", instructionsFilePath: "AGENTS.md", maxTurnsPerRun: 20, command: "claude", agentCommand: "claude-acp", extraArgs: ["--model", "old"], model: "old", effort: "high", stateDir: "/claude/state", env: { CLAUDE_CODE_OAUTH_TOKEN: "secret", CODEX_HOME: "/old", ANTHROPIC_BASE_URL: "https://old-provider.invalid", SAFE: "yes" } }, codex);
    expect(config).toEqual({ cwd: "/workspace", instructionsFilePath: "AGENTS.md", maxTurnsPerRun: 20, model: "codex-model", env: { SAFE: "yes" } });
    expect(phaseRouteAdapterConfig({}, { ...codex, effort: "high" }).modelReasoningEffort).toBe("high");
    expect(phaseRouteAdapterConfig({}, { ...claude, effort: "high" }).effort).toBe("high");
    expect(phaseRouteAdapterConfig({}, { ...codex, adapterType: "opencode_local", effort: "high" }).variant).toBe("high");
    expect(phaseRouteAdapterConfig({ permissionMode: "deny-all", dangerouslyBypassApprovalsAndSandbox: false }, codex)).toMatchObject({ permissionMode: "deny-all", dangerouslyBypassApprovalsAndSandbox: false });
  });

  it("validates strict profiles, compatibility and duplicate identities", () => {
    expect(phaseRoutingSchema.safeParse({ ...policy, planning: [{ ...claude, command: "other" }] }).success).toBe(false);
    expect(phaseRoutingSchema.safeParse({ ...policy, planning: [claude, claude] }).success).toBe(false);
    expect(phaseRoutingSchema.safeParse({ ...policy, planning: [{ ...claude, binding: codex.binding }] }).success).toBe(false);
  });
});

describe("quota cooldown", () => {
  it("expires at the provider reset and handles unknown reset conservatively", () => {
    const evidence = { status: "failed", finishedAt: now, result: null };
    expect(quotaCooldownUntil(evidence, 3600, now)?.toISOString()).toBe("2026-11-07T11:00:00.000Z");
    expect(quotaCooldownUntil(evidence, 3600, new Date("2026-11-07T11:00:00Z"))).toBeNull();
    expect(quotaCooldownUntil({ ...evidence, status: "succeeded" }, 3600, now)).toBeNull();
    expect(quotaCooldownUntil({ ...evidence, result: { retryNotBefore: "2026-11-07T09:00:00Z" } }, 3600, now)).toBeNull();
  });
});
