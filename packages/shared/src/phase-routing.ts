import { z } from "zod";
import { aiConnectionBindingSchema, isAiConnectionCompatible } from "./ai-connections.js";

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
  unknownResetCooldownSeconds: z.number().int().min(60).max(86_400).default(3_600),
}).strict();

export type PhaseRouteProfile = z.infer<typeof phaseRouteProfileSchema>;
export type PhaseRouting = z.infer<typeof phaseRoutingSchema>;
export type ExecutionPhase = "planning" | "implementation";

export function executionPhaseForWorkMode(workMode: unknown): ExecutionPhase | null {
  return workMode === "planning" ? "planning" : workMode === "standard" ? "implementation" : null;
}
