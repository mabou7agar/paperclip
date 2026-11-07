import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  ADAPTER_AGNOSTIC_KEYS, PHASE_ROUTING_ADAPTERS, executionPhaseForWorkMode, phaseRouteProfileSchema,
  phaseRoutingSchema, type PhaseRouteProfile,
} from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";
import { AI_AUTH_ENV_KEYS, stripAiAuthBindings } from "./ai-connection-runtime.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { forbidden, HttpError, unprocessable } from "../errors.js";
import { phaseRoutingSettingsRepository } from "../repositories/phase-routing-settings.js";

export const PHASE_QUOTA_FALLBACK_RETRY_REASON = "phase_quota_fallback";
export const phaseRouteDispatchSchema = z.object({
  phase: z.enum(["planning", "implementation"]),
  profile: phaseRouteProfileSchema.nullable(),
  maxFallbackAttempts: z.number().int().nonnegative(),
  connectionId: z.string().nullable(),
  grantId: z.string().nullable(),
  retryAt: z.string().datetime().nullable(),
  notes: z.array(z.string()),
}).strict();
export type PhaseRouteDispatch = z.infer<typeof phaseRouteDispatchSchema>;

/** Share task/workspace/instruction settings, never another harness's commands or auth. */
export function phaseRouteAdapterConfig(base: Record<string, unknown>, profile: PhaseRouteProfile): Record<string, unknown> {
  const commonKeys = [
    ...ADAPTER_AGNOSTIC_KEYS, "instructionsBundle", "desiredSkills",
    "engine", "mode", "nonInteractivePermissions", "warmHandleIdleMs",
    "maxTurnsPerRun",
    "dangerouslySkipPermissions", "dangerouslyBypassApprovalsAndSandbox",
  ];
  const config: Record<string, unknown> = Object.fromEntries(commonKeys.filter(key => key in base).map(key => [key, base[key]]));
  if (base.env !== undefined) {
    const env = stripAiAuthBindings(base.env);
    for (const key of AI_AUTH_ENV_KEYS) delete env[key];
    config.env = env;
  }
  config.model = profile.model;
  const effortKey = { codex_local: "modelReasoningEffort", claude_local: "effort", opencode_local: "variant" }[profile.adapterType];
  if (profile.effort) config[effortKey] = profile.effort;
  return config;
}

/** Stable phase/account affinity; provider-native ids never cross phase/profile boundaries. */
export function phaseRouteTaskKey(taskKey: string | null, route: PhaseRouteDispatch): string | null {
  if (!taskKey || !route.profile) return taskKey;
  const identity = createHash("sha256").update(JSON.stringify({
    phase: route.phase, adapter: route.profile.adapterType, model: route.profile.model,
    connectionId: route.connectionId, grantId: route.grantId,
  })).digest("hex").slice(0, 24);
  return `${taskKey}:phase:${identity}`;
}

export function quotaCooldownUntil(
  evidence: { status: string; finishedAt: Date | null; result: Record<string, unknown> | null } | null,
  unknownResetCooldownSeconds: number,
  now: Date,
): Date | null {
  if (!evidence || evidence.status === "succeeded" || !evidence.finishedAt) return null;
  const result = evidence.result ?? {};
  const reset = result.providerQuotaRetryNotBefore ?? result.retryNotBefore ?? result.transientRetryNotBefore;
  const parsedReset = typeof reset === "string" ? Date.parse(reset) : NaN;
  const until = Number.isFinite(parsedReset)
    ? new Date(parsedReset)
    : new Date(evidence.finishedAt.getTime() + unknownResetCooldownSeconds * 1_000);
  return until.getTime() > now.getTime() ? until : null;
}

export function phaseRoutingService(db: Db) {
  const accounts = aiConnectionService(db);
  const quota = providerQuotaRepository(db);
  const settings = phaseRoutingSettingsRepository(db);
  return {
    getCompanyDefaults: settings.get,
    async saveCompanyDefaults(input: { companyId: string; userId: string; policy: unknown }) {
      const policy = phaseRoutingSchema.parse(input.policy);
      if (policy.enabled) for (const profile of [...policy.planning, ...policy.implementation]) {
        // Company defaults require company-wide installations. Per-agent
        // credentials can still be chosen in that agent's explicit override.
        await accounts.select({ companyId: input.companyId, agentId: "company-defaults",
          userId: input.userId, adapterType: profile.adapterType, binding: profile.binding, model: profile.model });
      }
      return settings.save(input.companyId, policy);
    },
    async validateConfiguration(input: {
      companyId: string; agentId: string; userId: string | null; isBoard: boolean;
      adapterType: string; policy: unknown;
    }) {
      if (!input.isBoard) throw forbidden("Only the board may configure phase routing");
      if (input.policy === undefined) return;
      const policy = phaseRoutingSchema.parse(input.policy);
      if (!policy.enabled) return;
      if (!(PHASE_ROUTING_ADAPTERS as readonly string[]).includes(input.adapterType)) {
        throw unprocessable("Phase routing supports Claude, Codex and OpenCode agents");
      }
      for (const profile of [...policy.planning, ...policy.implementation]) {
        await accounts.select({ companyId: input.companyId, agentId: input.agentId,
          userId: input.userId, adapterType: profile.adapterType, binding: profile.binding, model: profile.model });
      }
    },
    async resolve(input: {
      companyId: string; agentId: string; userId: string | null;
      adapterType: string; runtimeConfig: Record<string, unknown>; workMode: unknown;
      isConversation: boolean; now?: Date; afterProfileId?: string;
    }): Promise<PhaseRouteDispatch | null> {
      const phase = executionPhaseForWorkMode(input.workMode);
      if (!phase || input.isConversation || !(PHASE_ROUTING_ADAPTERS as readonly string[]).includes(input.adapterType)) return null;
      const policy = phaseRoutingSchema.safeParse(input.runtimeConfig.phaseRouting ?? await settings.get(input.companyId));
      if (!policy.success || !policy.data.enabled) return null;
      const now = input.now ?? new Date();
      const profiles = policy.data[phase];
      const notes: string[] = [];
      const retryDates: Date[] = [];
      const previousIndex = input.afterProfileId ? profiles.findIndex(profile => profile.id === input.afterProfileId) : -1;
      if (input.afterProfileId && previousIndex < 0) return {
        phase, profile: null, connectionId: null, grantId: null, maxFallbackAttempts: profiles.length - 1,
        retryAt: null, notes: ["The fallback policy changed. Start a new turn with the updated policy."],
      };
      for (const profile of profiles.slice(previousIndex + 1)) {
        // Selection verifies membership, grant/agent installation and authoritative
        // model compatibility without decrypting credentials or calling a model.
        let account: Awaited<ReturnType<typeof accounts.select>>;
        try {
          account = await accounts.select({
            companyId: input.companyId, agentId: input.agentId, userId: input.userId,
            adapterType: profile.adapterType, binding: profile.binding, model: profile.model,
          });
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
          // Authentication/access errors require configuration, never a silent
          // provider switch or a retry loop.
          return { phase, profile: null, connectionId: null, grantId: null,
            maxFallbackAttempts: profiles.length - 1, retryAt: null,
            notes: [`${profile.id}: ${error.message}`] };
        }
        const cooldown = quotaCooldownUntil(await quota.latestEvidence(input.companyId, account.connection.id, now), policy.data.unknownResetCooldownSeconds, now);
        if (cooldown) {
          retryDates.push(cooldown);
          notes.push(`${profile.id}: quota cooldown until ${cooldown.toISOString()}`);
          continue;
        }
        return {
          phase, profile: { ...profile, binding: {
            provider: account.attribution.provider, method: account.attribution.method,
            mode: account.grant.kind === "organization" ? "shared" : "delegated",
            connectionId: account.connection.id, grantId: account.grant.id,
          } }, connectionId: account.connection.id, grantId: account.grant.id,
          maxFallbackAttempts: profiles.length - 1, retryAt: null, notes,
        };
      }
      return {
        phase, profile: null, connectionId: null, grantId: null,
        maxFallbackAttempts: profiles.length - 1,
        retryAt: retryDates.length ? new Date(Math.min(...retryDates.map(date => date.getTime()))).toISOString() : null,
        notes,
      };
    },
  };
}
