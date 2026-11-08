export interface ApiQuotaProbeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
}
export interface ApiQuotaProbeOutcome {
  outcome:
    | "available"
    | "quota"
    | "authentication"
    | "unavailable"
    | "configuration";
  usage: ApiQuotaProbeUsage | null;
  retryAfterSeconds: number | null;
}
