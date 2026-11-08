import type { Db } from "@paperclipai/db";
import {
  CONNECTION_USAGE_WINDOWS,
  centsToUnits,
  usdToUnits,
  centsToUsd,
  unitsToCents,
  type ConnectionUsageCaps,
  type ConnectionUsageCapStatus,
  type ConnectionUsageWindow,
} from "@paperclipai/shared";
import { connectionUsageRepository } from "../repositories/connection-usage.js";
import { phaseRoutingSettingsRepository } from "../repositories/phase-routing-settings.js";
import type { ConnectionUsageObservation } from "../types/connection-usage.js";

export class ConnectionUsageCapReached extends Error {
  constructor(public readonly status: ConnectionUsageCapStatus) {
    super("This AI connection has reached its configured usage cap");
  }
}

/** Application usage caps govern new runs; an in-flight run is allowed to finish. */
export function evaluateConnectionUsageCaps(
  connectionId: string,
  caps: ConnectionUsageCaps,
  observations: ConnectionUsageObservation[],
  now: Date,
): ConnectionUsageCapStatus {
  const windows: ConnectionUsageCapStatus["windows"] = [];
  for (const window of Object.keys(
    CONNECTION_USAGE_WINDOWS,
  ) as ConnectionUsageWindow[]) {
    const cap = caps[window];
    if (!cap || (cap.tokens === undefined && cap.apiCostUsd === undefined))
      continue;
    const duration = CONNECTION_USAGE_WINDOWS[window] * 1000;
    const rows = observations
      .filter((r) => r.at.getTime() > now.getTime() - duration && r.at <= now)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    let tokens = 0n,
      cost = 0n,
      unknownTokens = 0,
      unknownCost = 0;
    for (const r of rows) {
      if (r.tokens === null) unknownTokens++;
      else tokens += BigInt(r.tokens);
      if (r.apiCostCents === null) unknownCost++;
      else cost += centsToUnits(r.apiCostCents);
    }
    const exceeded = () =>
      (cap.tokens !== undefined &&
        ((caps.onUnknownUsage === "hold" && unknownTokens > 0) ||
          tokens >= BigInt(cap.tokens))) ||
      (cap.apiCostUsd !== undefined &&
        ((caps.onUnknownUsage === "hold" && unknownCost > 0) ||
          cost >= usdToUnits(cap.apiCostUsd)));
    const knownTokens = Number(tokens),
      knownApiCostUsd = centsToUsd(unitsToCents(cost));
    const blocked = exceeded(),
      totalTokens = unknownTokens ? null : Number(tokens),
      totalCost = unknownCost ? null : centsToUsd(unitsToCents(cost));
    let retryAt: string | null = null;
    if (blocked)
      for (const r of rows) {
        if (r.tokens === null) unknownTokens--;
        else tokens -= BigInt(r.tokens);
        if (r.apiCostCents === null) unknownCost--;
        else cost -= centsToUnits(r.apiCostCents);
        if (!exceeded()) {
          retryAt = new Date(r.at.getTime() + duration).toISOString();
          break;
        }
      }
    windows.push({
      window,
      tokens: totalTokens,
      apiCostUsd: totalCost,
      knownTokens,
      knownApiCostUsd,
      tokenCap: cap.tokens,
      apiCostCapUsd: cap.apiCostUsd,
      blocked,
      retryAt,
    });
  }
  const waits = windows
    .filter((w) => w.blocked)
    .map((w) => Date.parse(w.retryAt!));
  return {
    connectionId,
    windows,
    blocked: waits.length > 0,
    retryAt: waits.length ? new Date(Math.max(...waits)).toISOString() : null,
  };
}

export function connectionUsageCapsService(db: Db) {
  const settings = phaseRoutingSettingsRepository(db),
    repository = connectionUsageRepository(db);
  const check = async (
    companyId: string,
    connectionId: string,
    now = new Date(),
    caps?: ConnectionUsageCaps,
  ) => {
    const configured =
      caps ??
      (await settings.get(companyId))?.connectionUsageCaps?.[connectionId];
    if (
      !configured ||
      !(Object.keys(CONNECTION_USAGE_WINDOWS) as ConnectionUsageWindow[]).some(
        (window) =>
          configured[window]?.tokens !== undefined ||
          configured[window]?.apiCostUsd !== undefined,
      )
    )
      return {
        connectionId,
        blocked: false,
        retryAt: null,
        windows: [],
      } as ConnectionUsageCapStatus;
    return evaluateConnectionUsageCaps(
      connectionId,
      configured,
      await repository.observations(
        companyId,
        connectionId,
        new Date(now.getTime() - 7 * 86400000),
        now,
      ),
      now,
    );
  };
  return {
    check,
    async assertAvailable(companyId: string, connectionId: string) {
      const status = await check(companyId, connectionId);
      if (status.blocked) throw new ConnectionUsageCapReached(status);
    },
    async report(companyId: string) {
      const caps = (await settings.get(companyId))?.connectionUsageCaps ?? {};
      const result: ConnectionUsageCapStatus[] = [];
      for (const [id, value] of Object.entries(caps))
        result.push(await check(companyId, id, new Date(), value));
      return result;
    },
  };
}
