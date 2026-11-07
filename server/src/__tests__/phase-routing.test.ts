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

  it("routes ordinary CTO coordination and independent review by responsibility", async () => {
    getDefaults.mockResolvedValue({ ...policy, roleResponsibilities: { cto: "planning" }, review: [claude] });
    const ordinary = { ...input, workMode: "standard", runtimeConfig: {} };
    expect((await service().resolve({ ...ordinary, agentRole: "cto" }))?.phase).toBe("planning");
    expect((await service().resolve({ ...ordinary, agentRole: "engineer" }))?.phase).toBe("implementation");
    expect((await service().resolve({ ...ordinary, runtimeConfig: { executionResponsibility: "review" } }))?.phase).toBe("review");
    expect((await service().resolve({ ...ordinary, agentRole: "cto", runtimeConfig: { executionResponsibility: "implementation" } }))?.phase).toBe("implementation");
    expect((await service().resolve({ ...ordinary, workMode: "planning", runtimeConfig: { executionResponsibility: "review" } }))?.phase).toBe("planning");
  });

  it("limits a task review fallback to its configured task and responsibility", async () => {
    const taskId = "30000000-0000-4000-8000-000000000001";
    getDefaults.mockResolvedValue({ ...policy, review: [claude], taskOverrides: { [taskId]: { review: [claude, codex] } } });
    latestEvidence.mockImplementation(async (_company, connectionId) => connectionId.endsWith("1")
      ? { status: "failed", finishedAt: now, result: { retryNotBefore: "2026-11-08T10:00:00Z" } } : null);
    const review = { ...input, workMode: "standard", runtimeConfig: { executionResponsibility: "review" }, issueId: taskId };
    expect(await service().resolve(review)).toMatchObject({ phase: "review", profile: { id: "codex" }, maxFallbackAttempts: 1 });
    expect(await service().resolve({ ...review, issueId: "30000000-0000-4000-8000-000000000002" })).toMatchObject({ profile: null, retryAt: "2026-11-08T10:00:00.000Z", maxFallbackAttempts: 0 });
    expect(await service().resolve({ ...review, runtimeConfig: {} })).toMatchObject({ phase: "implementation", profile: { id: "codex" }, maxFallbackAttempts: 0 });
    expect(await service().resolve({ ...review, afterProfileId: "claude", afterPhase: "review" })).toMatchObject({ profile: { id: "codex" } });
    expect(await service().resolve({ ...review, afterProfileId: "codex", afterPhase: "review" })).toMatchObject({ profile: null });
  });

  it("validates task profile connections and rejects non-board configuration", async () => {
    const taskId = "30000000-0000-4000-8000-000000000001";
    const scoped = { ...policy, taskOverrides: { [taskId]: { review: [{ ...codex, model: "codex-task-model" }] } } };
    await service().validateConfiguration({ companyId: "company", agentId: "agent", userId: "user", isBoard: true, adapterType: "claude_local", policy: scoped });
    expect(select).toHaveBeenCalledTimes(4);
    select.mockImplementation(async ({ model }) => { if (model === "codex-task-model") throw forbidden("Unavailable grant"); return {}; });
    await expect(service().validateConfiguration({ companyId: "company", agentId: "agent", userId: "user", isBoard: true, adapterType: "claude_local", policy: scoped })).rejects.toThrow("Unavailable grant");
    await expect(service().validateConfiguration({ companyId: "company", agentId: "agent", userId: "user", isBoard: false, adapterType: "claude_local", policy: scoped })).rejects.toThrow("Only the board");
    expect(phaseRoutingSchema.safeParse({ ...policy, taskOverrides: { invalid: { review: [codex] } } }).success).toBe(false);
    expect(phaseRoutingSchema.safeParse({ ...policy, taskOverrides: { [taskId]: { review: [] } } }).success).toBe(false);
  });

  it("fails closed when review is selected without a review chain", async () => {
    expect(await service().resolve({ ...input, workMode: "standard", runtimeConfig: { phaseRouting: policy, executionResponsibility: "review" } }))
      .toMatchObject({ phase: "review", profile: null, retryAt: null, maxFallbackAttempts: 0 });
    expect(select).not.toHaveBeenCalled();
  });

  it("does not carry fallback position across responsibilities", async () => {
    const result = await service().resolve({ ...input, workMode: "standard", afterPhase: "planning", afterProfileId: "codex" });
    expect(result).toMatchObject({ phase: "implementation", profile: { id: "codex" } });
  });

  it("parks the review chain on quota without switching to an implementation model", async () => {
    latestEvidence.mockResolvedValue({ status: "failed", finishedAt: now, result: { retryNotBefore: "2026-11-08T10:00:00Z" } });
    const result = await service().resolve({ ...input, workMode: "standard", runtimeConfig: { executionResponsibility: "review", phaseRouting: { ...policy, review: [claude] } } });
    expect(result).toMatchObject({ phase: "review", profile: null, maxFallbackAttempts: 0, retryAt: "2026-11-08T10:00:00.000Z" });
    expect(select).toHaveBeenCalledTimes(1);
    expect(select.mock.calls[0][0].binding.provider).toBe("anthropic");
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


describe("legacy provider reset receipts", () => {
  it("anchors a dated Claude reset to the original receipt, without modifying it", () => {
    const evidence = { status: "failed", finishedAt: new Date("2026-11-07T16:54:48Z"), result: null, provider: "anthropic", error: "You've hit your weekly limit · resets Nov 8, 7pm (UTC)" };
    expect(quotaCooldownUntil(evidence, 3600, new Date("2026-11-07T20:00:00Z"))?.toISOString()).toBe("2026-11-08T19:00:00.000Z");
    expect(quotaCooldownUntil(evidence, 3600, new Date("2026-11-08T19:00:01Z"))).toBeNull();
    expect(quotaCooldownUntil({ ...evidence, provider: "openai" }, 3600, new Date("2026-11-07T20:00:00Z"))).toBeNull();
  });
});
