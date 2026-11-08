import { extractClaudeRetryNotBefore } from "@paperclipai/adapter-claude-local/server";

export interface ProviderQuotaResetEvidence {
  status: string;
  finishedAt: Date | null;
  result: Record<string, unknown> | null;
  error?: string | null;
  provider?: string | null;
}

/** A control-plane backoff is not a provider-reported renewal date. */
export function reportedProviderQuotaReset(evidence: ProviderQuotaResetEvidence | null): Date | null {
  if (!evidence) return null;
  const result = evidence.result ?? {};
  if (result.providerQuotaResetSource !== "backoff") {
    const value = result.providerQuotaRetryNotBefore ?? result.retryNotBefore ?? result.transientRetryNotBefore;
    if (typeof value === "string") {
      const parsed = new Date(value);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
  }
  return evidence.provider === "anthropic" && evidence.finishedAt
    ? extractClaudeRetryNotBefore({ errorMessage: evidence.error }, evidence.finishedAt)
    : null;
}

export function unknownQuotaResetBackoffSeconds(companyPolicy: unknown, runtimeConfig: unknown): number {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const value = object(object(runtimeConfig).phaseRouting).unknownResetCooldownSeconds
    ?? object(companyPolicy).unknownResetCooldownSeconds ?? 3600;
  return typeof value === "number" && Number.isInteger(value) && (value === 0 || value >= 60) && value <= 86400 ? value : 3600;
}
