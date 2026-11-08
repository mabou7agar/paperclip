import { z } from "zod";
import { aiConnectionBindingSchema, isAiConnectionCompatible } from "./ai-connections.js";
import { AGENT_ROLES } from "./constants.js";

export const EXECUTION_RESPONSIBILITIES = ["planning", "implementation", "review"] as const;
export const executionResponsibilitySchema = z.enum(EXECUTION_RESPONSIBILITIES);

export const PHASE_ROUTING_ADAPTERS = ["claude_local", "codex_local", "opencode_local"] as const;
export const phaseRouteProfileSchema = z.object({
  id: z.string().trim().min(1).max(80),
  adapterType: z.enum(PHASE_ROUTING_ADAPTERS),
  model: z.string().trim().min(1).max(200),
  binding: aiConnectionBindingSchema,
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
}).strict().superRefine((profile, ctx) => {
  if (!isAiConnectionCompatible(profile.binding, profile.adapterType, profile.model)) {
    ctx.addIssue({ code: "custom", path: ["binding"], message: "Choose a connection compatible with this harness and model" });
  }
});

const phaseProfilesSchema = z.array(phaseRouteProfileSchema).min(1).superRefine((profiles, ctx) => {
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) {
    ctx.addIssue({ code: "custom", message: "Profile ids must be unique within a phase" });
  }
});

/** Opt-in. Existing agents and ask/conversation turns retain their configured harness. */
export const phaseRoutingSchema = z.object({
  enabled: z.boolean().default(false),
  planning: phaseProfilesSchema,
  implementation: phaseProfilesSchema,
  review: phaseProfilesSchema.optional(),
  defaultResponsibility: executionResponsibilitySchema.optional(),
  roleResponsibilities: z.partialRecord(z.enum(AGENT_ROLES), executionResponsibilitySchema).optional(),
  /** Explicit task exceptions; omitted responsibilities continue to inherit. */
  taskOverrides: z.record(z.string().uuid(), z.object({
    planning: phaseProfilesSchema.optional(),
    implementation: phaseProfilesSchema.optional(),
    review: phaseProfilesSchema.optional(),
  }).strict()).optional(),
  unknownResetCooldownSeconds: z.number().int().min(0).max(86_400).refine(value => value === 0 || value >= 60, "Use 0 to wait for confirmation, or at least 60 seconds").default(3_600),
}).strict();

export type PhaseRouteProfile = z.infer<typeof phaseRouteProfileSchema>;
export type PhaseRouting = z.infer<typeof phaseRoutingSchema>;
export type ExecutionPhase = typeof EXECUTION_RESPONSIBILITIES[number];

/** Explicit planning remains a task workflow; ordinary work follows the agent's responsibility. */
export function executionPhaseForResponsibility(input: {
  workMode: unknown; agentRole?: string; responsibility?: unknown; policy: PhaseRouting;
}): ExecutionPhase | null {
  if (input.workMode === "planning") return "planning";
  if (input.workMode !== "standard") return null;
  const explicit = executionResponsibilitySchema.safeParse(input.responsibility);
  const roles = input.policy.roleResponsibilities;
  return explicit.success ? explicit.data
    : roles?.[input.agentRole as keyof NonNullable<typeof roles>]
      ?? input.policy.defaultResponsibility ?? "implementation";
}

export function executionPhaseForWorkMode(workMode: unknown): ExecutionPhase | null {
  return workMode === "planning" ? "planning" : workMode === "standard" ? "implementation" : null;
}

export const quotaRecoveryRequestSchema = z.object({reason:z.string().trim().min(1).max(500)}).strict();
