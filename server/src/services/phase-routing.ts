import { reportedProviderQuotaReset, type ProviderQuotaResetEvidence } from "./provider-quota-reset.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import {
  ADAPTER_AGNOSTIC_KEYS, PHASE_ROUTING_ADAPTERS, executionPhaseForResponsibility, phaseRouteProfileSchema,
  phaseRoutingSchema, type PhaseRouteProfile, type PhaseRouting,
} from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";
import { AI_AUTH_ENV_KEYS, stripAiAuthBindings } from "./ai-connection-runtime.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { forbidden, HttpError, unprocessable } from "../errors.js";
import { phaseRoutingSettingsRepository } from "../repositories/phase-routing-settings.js";
import { connectionUsageRepository } from "../repositories/connection-usage.js";
import { connectionUsageCapsService } from "./connection-usage-caps.js";
import { phaseAvailabilityDrillService } from "./phase-availability-drills.js";
import { canonicalJson } from "@paperclipai/shared/portability-hash";

export const PHASE_QUOTA_FALLBACK_RETRY_REASON = "phase_quota_fallback";
export const PHASE_QUOTA_RESET_WAKE_REASON = "phase_quota_reset";
export const phaseRouteDispatchSchema = z.object({
  phase: z.enum(["planning", "implementation", "review"]),
  workMode: z.enum(["planning", "standard"]).optional(),
  profile: phaseRouteProfileSchema.nullable(),
  maxFallbackAttempts: z.number().int().nonnegative(),
  connectionId: z.string().nullable(),
  grantId: z.string().nullable(),
  retryAt: z.string().datetime().nullable(),
  waitReason: z.enum(["quota_reset_unknown","usage_cap"]).optional(),
  notes: z.array(z.string()),
}).strict();
export type PhaseRouteDispatch = z.infer<typeof phaseRouteDispatchSchema>;

/** Share task/workspace/instruction settings, never another harness's commands or auth. */
export function phaseRouteAdapterConfig(base: Record<string, unknown>, profile: PhaseRouteProfile): Record<string, unknown> {
  const commonKeys = [
    ...ADAPTER_AGNOSTIC_KEYS, "instructionsBundle", "desiredSkills",
    "engine", "mode", "permissionMode", "nonInteractivePermissions", "warmHandleIdleMs",
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
  evidence: ProviderQuotaResetEvidence | null,
  unknownResetCooldownSeconds: number,
  now: Date,
): Date | null {
  if (!evidence || evidence.status === "succeeded" || !evidence.finishedAt) return null;
  const result = evidence.result ?? {};
  const backoff = result.providerQuotaResetSource === "backoff" && typeof result.quotaRecoveryBackoffNotBefore === "string"
    ? new Date(result.quotaRecoveryBackoffNotBefore) : null;
  const until = reportedProviderQuotaReset(evidence)
    ?? (backoff && Number.isFinite(backoff.getTime()) ? backoff : new Date(evidence.finishedAt.getTime() + unknownResetCooldownSeconds * 1_000));
  return until.getTime() > now.getTime() ? until : null;
}

function configuredProfiles(policy: PhaseRouting): PhaseRouteProfile[] {
  return [...policy.planning, ...policy.implementation, ...(policy.review ?? []),
    ...Object.values(policy.taskOverrides ?? {}).flatMap(task =>
      [...(task.planning ?? []), ...(task.implementation ?? []), ...(task.review ?? [])])];
}

export function phaseRoutingService(db: Db) {
  const accounts = aiConnectionService(db);
  const quota = providerQuotaRepository(db);
  const settings = phaseRoutingSettingsRepository(db);
  return {
    getCompanyDefaults: settings.get,
    async saveCompanyDefaults(input: { companyId: string; userId: string; policy: unknown }) {
      const policy = phaseRoutingSchema.parse(input.policy);
      if (!await connectionUsageRepository(db).owns(input.companyId,Object.keys(policy.connectionUsageCaps??{}))) throw unprocessable("Usage caps must reference AI connections in this company");
      if (policy.enabled) for (const profile of configuredProfiles(policy)) {
        // Company defaults require company-wide installations. Per-agent
        // credentials can still be chosen in that agent's explicit override.
        await accounts.select({ companyId: input.companyId, agentId: "company-defaults",
          userId: input.userId, adapterType: profile.adapterType, binding: profile.binding, model: profile.model });
      }
      if (Object.values(policy.taskOverrides ?? {}).some(task => task.availabilityDrill)) {
        return db.transaction(async tx => {
          const scoped = phaseRoutingSettingsRepository(tx);
          await phaseAvailabilityDrillService(tx).validateNew(input.companyId, policy, await scoped.get(input.companyId));
          return scoped.save(input.companyId, policy);
        });
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
      if (Object.values(policy.taskOverrides ?? {}).some(task => task.availabilityDrill)) {
        throw unprocessable("Controlled availability drills must use the company task exception API");
      }
      if (!policy.enabled) return;
      if (!(PHASE_ROUTING_ADAPTERS as readonly string[]).includes(input.adapterType)) {
        throw unprocessable("Phase routing supports Claude, Codex and OpenCode agents");
      }
      for (const profile of configuredProfiles(policy)) {
        await accounts.select({ companyId: input.companyId, agentId: input.agentId,
          userId: input.userId, adapterType: profile.adapterType, binding: profile.binding, model: profile.model });
      }
    },
    async resolve(input: {
      companyId: string; agentId: string; userId: string | null;
      adapterType: string; runtimeConfig: Record<string, unknown>; workMode: unknown;
      isConversation: boolean; issueId?: string; now?: Date; afterProfileId?: string; afterPhase?: string; agentRole?: string;
    }): Promise<PhaseRouteDispatch | null> {
      if (!["planning", "standard"].includes(String(input.workMode)) || input.isConversation || !(PHASE_ROUTING_ADAPTERS as readonly string[]).includes(input.adapterType)) return null;
      const companyPolicy = phaseRoutingSchema.safeParse(await settings.get(input.companyId));
      const override = input.runtimeConfig.phaseRouting;
      const policy = phaseRoutingSchema.safeParse(override && typeof override === "object"
        ? { ...(companyPolicy.success ? companyPolicy.data : {}), ...override }
        : companyPolicy.success ? companyPolicy.data : null);
      if (!policy.success || !policy.data.enabled) return null;
      const phase = executionPhaseForResponsibility({ workMode: input.workMode, agentRole: input.agentRole,
        responsibility: input.runtimeConfig.executionResponsibility, policy: policy.data })!;
      const workMode = input.workMode as "planning" | "standard";
      const now = input.now ?? new Date();
      const taskProfiles = input.issueId ? policy.data.taskOverrides?.[input.issueId]?.[phase] : undefined;
      const profiles = taskProfiles ?? policy.data[phase] ?? [];
      // Only the board-owned company exception can inject a fault. Agent chain
      // overrides never authorize a fault, and children do not inherit it.
      const configuredDrill = input.issueId && companyPolicy.success
        ? companyPolicy.data.taskOverrides?.[input.issueId]?.availabilityDrill : undefined;
      const drill = configuredDrill?.phase === phase ? configuredDrill : undefined;
      const boardProfiles = input.issueId && companyPolicy.success
        ? companyPolicy.data.taskOverrides?.[input.issueId]?.[phase] ?? companyPolicy.data[phase] ?? [] : [];
      if (drill && (profiles.length < 2 || profiles[0]?.id !== drill.profileId || canonicalJson(profiles) !== canonicalJson(boardProfiles))) {
        return { phase, workMode, profile: null, connectionId: null, grantId: null,
          maxFallbackAttempts: 0, retryAt: null,
          notes: ["The controlled availability drill chain changed. Remove the task exception before continuing."] };
      }
      if (!profiles.length) return { phase, workMode, profile: null, connectionId: null, grantId: null,
        maxFallbackAttempts: 0, retryAt: null, notes: ["Configure a review model chain before running a reviewer."] };
      const afterProfileId = !input.afterPhase || input.afterPhase === phase ? input.afterProfileId : undefined;
      const notes: string[] = taskProfiles ? [`Task-specific ${phase} chain for ${input.issueId}`] : [];
      const retryDates: Date[] = [];
      let unknownResetHeld = false;
      let usageCapHeld = false;
      const previousIndex = afterProfileId ? profiles.findIndex(profile => profile.id === afterProfileId) : -1;
      if (afterProfileId && previousIndex < 0) return {
        phase, workMode, profile: null, connectionId: null, grantId: null, maxFallbackAttempts: profiles.length - 1,
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
          return { phase, workMode, profile: null, connectionId: null, grantId: null,
            maxFallbackAttempts: profiles.length - 1, retryAt: null,
            notes: [`${profile.id}: ${error.message}`] };
        }
        if (drill && input.issueId && profile.id === drill.profileId) {
          const state = await phaseAvailabilityDrillService(db).apply(input.companyId, input.issueId, drill);
          if (state !== "applied") return { phase, workMode, profile: null, connectionId: null, grantId: null,
            maxFallbackAttempts: 0, retryAt: null, notes: [state === "expired"
              ? "The controlled availability drill activation deadline expired. Remove the task exception before continuing."
              : state === "conflict" ? "The controlled availability drill id belongs to another operation. Remove the task exception before continuing."
              : "The controlled availability drill is no longer eligible."] };
          notes.push(`${profile.id}: controlled task-only availability fault ${drill.id}; no provider quota failure or shared cooldown`);
          continue;
        }
        const evidence = await quota.latestEvidence(input.companyId, account.connection.id, now, account.grant.id);
        if (evidence && evidence.status !== "succeeded" && policy.data.unknownResetCooldownSeconds === 0 && !reportedProviderQuotaReset(evidence)) {
          unknownResetHeld = true;
          notes.push(`${profile.id}: quota exhausted; renewal date is unknown. Confirm quota restoration before retrying.`);
          continue;
        }
        // Connection limits are company-owned even when the agent overrides its model chain.
        const caps = companyPolicy.success ? companyPolicy.data.connectionUsageCaps?.[account.connection.id] : undefined;
        const capacity = caps ? await connectionUsageCapsService(db).check(input.companyId,account.connection.id,now,caps) : null;
        if(capacity?.blocked)usageCapHeld=true;
        const cooldown = quotaCooldownUntil(evidence, policy.data.unknownResetCooldownSeconds, now);
        if (cooldown || capacity?.blocked) {
          const next = new Date(Math.max(cooldown?.getTime()??0,capacity?.retryAt?Date.parse(capacity.retryAt):0));
          retryDates.push(next);
          notes.push(`${profile.id}: ${capacity?.blocked?"configured usage cap":"quota cooldown"} until ${next.toISOString()}`);
          continue;
        }
        return {
          phase, workMode, profile: { ...profile, binding: {
            provider: account.attribution.provider, method: account.attribution.method,
            mode: account.grant.kind === "organization" ? "shared" : "delegated",
            connectionId: account.connection.id, grantId: account.grant.id,
          } }, connectionId: account.connection.id, grantId: account.grant.id,
          maxFallbackAttempts: profiles.length - 1, retryAt: null, notes,
        };
      }
      return {
        phase, workMode, profile: null, connectionId: null, grantId: null,
        maxFallbackAttempts: profiles.length - 1,
        retryAt: retryDates.length ? new Date(Math.min(...retryDates.map(date => date.getTime()))).toISOString() : null,
        ...(!retryDates.length && unknownResetHeld ? { waitReason: "quota_reset_unknown" as const } : retryDates.length && usageCapHeld ? {waitReason:"usage_cap" as const} : {}),
        notes,
      };
    },
  };
}
