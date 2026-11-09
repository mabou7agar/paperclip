import { z } from "zod";

const thresholdValues = {
  inputTokensPerRun: z.number().int().min(1000).max(100_000_000),
  outputTokensPerRun: z.number().int().min(100).max(10_000_000),
  runsPerTaskHour: z.number().int().min(2).max(1000),
  cacheWriteShare: z.number().min(0.05).max(1),
  minCacheWriteTokens: z.number().int().min(1000).max(100_000_000),
};
export const usageHealthThresholdsSchema = z
  .object({
    inputTokensPerRun: thresholdValues.inputTokensPerRun.default(250_000),
    outputTokensPerRun: thresholdValues.outputTokensPerRun.default(30_000),
    runsPerTaskHour: thresholdValues.runsPerTaskHour.default(8),
    cacheWriteShare: thresholdValues.cacheWriteShare.default(0.5),
    minCacheWriteTokens: thresholdValues.minCacheWriteTokens.default(50_000),
  })
  .strict();
export const usageHealthPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    thresholds: usageHealthThresholdsSchema.default(() =>
      usageHealthThresholdsSchema.parse({}),
    ),
    agentOverrides: z
      .record(z.string().uuid(), z.object(thresholdValues).partial().strict())
      .refine(
        (value) => Object.keys(value).length <= 1000,
        "At most 1000 agent overrides",
      )
      .default({}),
  })
  .strict();
export const usageHealthQuerySchema = z
  .object({
    from: z.union([z.iso.datetime({ offset: true }), z.iso.date()]).optional(),
    to: z.union([z.iso.datetime({ offset: true }), z.iso.date()]).optional(),
  })
  .strict()
  .refine(
    (v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to),
    "from must not be after to",
  );
export type UsageHealthThresholds = z.infer<typeof usageHealthThresholdsSchema>;
export type UsageHealthPolicy = z.infer<typeof usageHealthPolicySchema>;
export type UsageHealthRule =
  | "large_input"
  | "large_output"
  | "repeated_runs"
  | "cache_writes"
  | "missing_usage"
  | "billing_mismatch";
export interface UsageHealthObservation {
  id: string;
  kind: string;
  agentId: string | null;
  agentName: string | null;
  issueId: string | null;
  identifier: string | null;
  provider: string;
  model: string;
  phase: string;
  status: string;
  occurredAt: string;
  sessionReused: boolean;
  expectedNoUsage: boolean;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  providerRequestId: string | null;
  billingType: string;
  authMethod: string | null;
}
export interface UsageHealthFlag {
  id: string;
  rule: UsageHealthRule;
  runId: string;
  kind: string;
  agentId: string | null;
  agentName: string | null;
  issueId: string | null;
  identifier: string | null;
  occurredAt: string;
  observed: number;
  threshold: number | null;
}
export interface UsageHealthTotals {
  runs: number;
  measuredRuns: number;
  pendingRuns: number;
  missingRuns: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWriteMeasuredRuns: number;
  outputTokens: number;
  totalTokens: number;
  requestIdsReported: number;
}
export interface UsageHealthGroup extends UsageHealthTotals {
  id: string;
  label: string;
}
export interface UsageHealthReport {
  from: string;
  to: string;
  policy: UsageHealthPolicy;
  totals: UsageHealthTotals;
  status: "within_thresholds" | "review" | "incomplete";
  byAgent: UsageHealthGroup[];
  byModel: UsageHealthGroup[];
  byTask: UsageHealthGroup[];
  flags: UsageHealthFlag[];
  flagCount: number;
  alerts: UsageHealthFlag[];
  canManage: boolean;
}
