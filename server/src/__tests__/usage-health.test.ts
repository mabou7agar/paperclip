import { describe, expect, it } from "vitest";
import {
  usageHealthPolicySchema,
  type UsageHealthObservation,
} from "@paperclipai/shared";
import {
  addUsageHealthObservation,
  assessUsageHealth,
  emptyUsageHealthTotals,
} from "../services/usage-health-evaluation.js";
const row: UsageHealthObservation = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "agent",
  agentId: "20000000-0000-4000-8000-000000000001",
  agentName: "Worker",
  issueId: "30000000-0000-4000-8000-000000000001",
  identifier: "T-1",
  provider: "anthropic",
  model: "claude-test",
  phase: "implementation",
  status: "succeeded",
  occurredAt: "2026-11-07T10:00:00Z",
  sessionReused: true,
  expectedNoUsage: false,
  inputTokens: 100,
  cachedInputTokens: 200,
  cacheWriteTokens: 40,
  outputTokens: 10,
  providerRequestId: null,
  billingType: "subscription_included",
  authMethod: "subscription",
};
describe("usage health report-only assessment", () => {
  it("counts cache writes once and preserves an unknown split", () => {
    const totals = emptyUsageHealthTotals();
    addUsageHealthObservation(totals, row);
    addUsageHealthObservation(totals, { ...row, cacheWriteTokens: null });
    expect(totals).toMatchObject({
      runs: 2,
      measuredRuns: 2,
      inputTokens: 200,
      cachedInputTokens: 400,
      cacheWriteTokens: 40,
      cacheWriteMeasuredRuns: 1,
      outputTokens: 20,
      totalTokens: 620,
      requestIdsReported: 0,
    });
  });
  it("distinguishes missing final usage, pending usage and no-provider gates", () => {
    const totals = emptyUsageHealthTotals();
    for (const patch of [
      { status: "failed" },
      { status: "running" },
      { status: "cancelled", expectedNoUsage: true },
    ])
      addUsageHealthObservation(totals, {
        ...row,
        ...patch,
        inputTokens: null,
      });
    expect(totals).toMatchObject({
      runs: 3,
      measuredRuns: 0,
      pendingRuns: 1,
      missingRuns: 1,
      totalTokens: 0,
    });
  });
  it("applies company and agent thresholds without changing execution", () => {
    const policy = usageHealthPolicySchema.parse({
      enabled: true,
      thresholds: { inputTokensPerRun: 10000, minCacheWriteTokens: 1000 },
      agentOverrides: { [row.agentId!]: { inputTokensPerRun: 1000 } },
    });
    const r = {
      ...row,
      inputTokens: 2000,
      cachedInputTokens: 0,
      cacheWriteTokens: 1800,
    };
    const first = assessUsageHealth("company", r, policy, 9);
    expect(first.map((x) => x.rule)).toEqual([
      "large_input",
      "repeated_runs",
      "cache_writes",
    ]);
    expect(assessUsageHealth("company", r, policy, 9)).toEqual(first);
    expect(assessUsageHealth("other-company", r, policy, 9)[0].id).not.toBe(
      first[0].id,
    );
    expect(
      assessUsageHealth(
        "company",
        { ...r, sessionReused: false },
        policy,
        1,
      ).some((x) => x.rule === "cache_writes"),
    ).toBe(false);
  });
  it("does not call missing cache-write data zero or call a fresh cache write excessive", () => {
    const policy = usageHealthPolicySchema.parse({});
    expect(policy.enabled).toBe(false);
    expect(
      assessUsageHealth(
        "company",
        { ...row, inputTokens: 100000, cacheWriteTokens: null },
        policy,
        1,
      ),
    ).toEqual([]);
    expect(
      assessUsageHealth(
        "company",
        { ...row, authMethod: "api_key" },
        policy,
        1,
      ).map((f) => f.rule),
    ).toEqual(["billing_mismatch"]);
    expect(
      assessUsageHealth(
        "company",
        { ...row, inputTokens: null },
        policy,
        1,
      ).map((f) => f.rule),
    ).toEqual(["missing_usage"]);
  });
  it("validates limits and scoped override IDs", () => {
    expect(
      usageHealthPolicySchema.safeParse({ thresholds: { runsPerTaskHour: 0 } })
        .success,
    ).toBe(false);
    expect(
      usageHealthPolicySchema.safeParse({
        agentOverrides: { other: { inputTokensPerRun: 1 } },
      }).success,
    ).toBe(false);
    expect(
      usageHealthPolicySchema.safeParse({ pauseOnLimit: true }).success,
    ).toBe(false);
  });
});
