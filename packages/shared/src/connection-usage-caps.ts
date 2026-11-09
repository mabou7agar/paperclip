import { z } from "zod";

export const CONNECTION_USAGE_WINDOWS = {
  rolling5h: 5 * 3600,
  daily: 86400,
  weekly: 7 * 86400,
} as const;
export const connectionUsageWindowSchema = z
  .object({
    tokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    apiCostUsd: z
      .string()
      .regex(/^\d{1,9}(\.\d{1,6})?$/)
      .refine((v) => Number(v) > 0, "Enter a positive USD amount")
      .optional(),
  })
  .strict();
/** Company-owned connection limits cannot be bypassed by agent routing overrides. */
export const connectionUsageCapsSchema = z
  .object({
    onUnknownUsage: z.enum(["report", "hold"]).optional(),
    rolling5h: connectionUsageWindowSchema.optional(),
    daily: connectionUsageWindowSchema.optional(),
    weekly: connectionUsageWindowSchema.optional(),
  })
  .strict();
export type ConnectionUsageCaps = z.infer<typeof connectionUsageCapsSchema>;
export type ConnectionUsageWindow = keyof typeof CONNECTION_USAGE_WINDOWS;
export interface ConnectionUsageCapStatus {
  connectionId: string;
  blocked: boolean;
  retryAt: string | null;
  windows: Array<{
    window: ConnectionUsageWindow;
    tokens: number | null;
    apiCostUsd: string | null;
    knownTokens: number;
    knownApiCostUsd: string;
    tokenCap?: number;
    apiCostCapUsd?: string;
    blocked: boolean;
    retryAt: string | null;
  }>;
}
