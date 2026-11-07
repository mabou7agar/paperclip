import { createHash } from "node:crypto";
import type {
  UsageHealthFlag,
  UsageHealthObservation,
  UsageHealthPolicy,
  UsageHealthTotals,
} from "@paperclipai/shared";

export const emptyUsageHealthTotals = (): UsageHealthTotals => ({
  runs: 0,
  measuredRuns: 0,
  pendingRuns: 0,
  missingRuns: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheWriteMeasuredRuns: 0,
  outputTokens: 0,
  totalTokens: 0,
  requestIdsReported: 0,
});
export function addUsageHealthObservation(
  total: UsageHealthTotals,
  row: UsageHealthObservation,
) {
  total.runs++;
  if (row.inputTokens === null) {
    if (["running", "queued", "scheduled_retry"].includes(row.status))
      total.pendingRuns++;
    else if (!row.expectedNoUsage) total.missingRuns++;
    return;
  }
  total.measuredRuns++;
  total.inputTokens += row.inputTokens;
  total.cachedInputTokens += row.cachedInputTokens ?? 0;
  total.outputTokens += row.outputTokens ?? 0;
  total.totalTokens +=
    row.inputTokens + (row.cachedInputTokens ?? 0) + (row.outputTokens ?? 0);
  if (row.cacheWriteTokens !== null) {
    total.cacheWriteTokens += row.cacheWriteTokens;
    total.cacheWriteMeasuredRuns++;
  }
  if (row.providerRequestId) total.requestIdsReported++;
}
export function assessUsageHealth(
  companyId: string,
  row: UsageHealthObservation,
  policy: UsageHealthPolicy,
  taskRuns: number,
): UsageHealthFlag[] {
  const thresholds = {
    ...policy.thresholds,
    ...(row.agentId ? policy.agentOverrides[row.agentId] : {}),
  };
  const result: UsageHealthFlag[] = [];
  const flag = (
    rule: UsageHealthFlag["rule"],
    observed: number,
    threshold: number | null,
  ) => {
    const hash = createHash("sha256")
      .update(`${companyId}:${row.kind}:${row.id}:${rule}`)
      .digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    result.push({
      id,
      rule,
      runId: row.id,
      kind: row.kind,
      agentId: row.agentId,
      agentName: row.agentName,
      issueId: row.issueId,
      identifier: row.identifier,
      occurredAt: row.occurredAt,
      observed,
      threshold,
    });
  };
  if (row.inputTokens === null) {
    if (
      !row.expectedNoUsage &&
      !["running", "queued", "scheduled_retry"].includes(row.status)
    )
      flag("missing_usage", 1, null);
    return result;
  }
  if (row.inputTokens > thresholds.inputTokensPerRun)
    flag("large_input", row.inputTokens, thresholds.inputTokensPerRun);
  if ((row.outputTokens ?? 0) > thresholds.outputTokensPerRun)
    flag("large_output", row.outputTokens!, thresholds.outputTokensPerRun);
  if (taskRuns > thresholds.runsPerTaskHour)
    flag("repeated_runs", taskRuns, thresholds.runsPerTaskHour);
  const writes = row.cacheWriteTokens;
  const input = row.inputTokens + (row.cachedInputTokens ?? 0);
  if (
    row.sessionReused &&
    writes !== null &&
    writes >= thresholds.minCacheWriteTokens &&
    input > 0 &&
    writes / input > thresholds.cacheWriteShare
  )
    flag("cache_writes", writes / input, thresholds.cacheWriteShare);
  if (
    row.authMethod === "api_key" &&
    row.billingType === "subscription_included"
  )
    flag("billing_mismatch", 1, null);
  return result;
}
