import { describe, expect, it } from "vitest";
import { reportedProviderQuotaReset, unknownQuotaResetBackoffSeconds } from "./provider-quota-reset.js";

describe("provider quota reset evidence", () => {
  it("does not report an inferred backoff as a renewal", () => {
    expect(reportedProviderQuotaReset({ status: "failed", finishedAt: new Date("2026-11-08T01:00:00Z"),
      provider: "anthropic", error: "API Error: Request rejected (429) · api key 7天限额已用完",
      result: { providerQuotaResetSource: "backoff", retryNotBefore: "2026-11-08T02:00:00Z" } })).toBeNull();
  });
  it("retains a real subscription renewal and preserves agent policy overrides", () => {
    const result = reportedProviderQuotaReset({ status: "failed", finishedAt: new Date("2026-11-07T20:00:00Z"), provider: "anthropic",
      error: "You've hit your limit · resets Nov 8, 7pm (UTC)", result: {} });
    expect(result?.toISOString()).toBe("2026-11-08T19:00:00.000Z");
    expect(unknownQuotaResetBackoffSeconds({ unknownResetCooldownSeconds: 0 }, {})).toBe(0);
    expect(unknownQuotaResetBackoffSeconds({ unknownResetCooldownSeconds: 0 }, { phaseRouting: { unknownResetCooldownSeconds: 120 } })).toBe(120);
    expect(unknownQuotaResetBackoffSeconds(null, {})).toBe(3600);
  });
});
