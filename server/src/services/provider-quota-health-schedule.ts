import type { Db } from "@paperclipai/db";
import { aiConnectionMetadataSchema } from "@paperclipai/shared";
import { providerQuotaProbeRepository } from "../repositories/provider-quota-probes.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { messagesQuotaDestination } from "./api-quota-probe.js";
import { connectionUsageCapsService } from "./connection-usage-caps.js";

/** Reads configured health deadlines; never resolves credentials or calls providers. */
export function providerQuotaHealthSchedule(db: Db, clock: () => Date = () => new Date()) {
  const probes = providerQuotaProbeRepository(db), quota = providerQuotaRepository(db);
  return {
    async next(): Promise<number | null> {
      const now = clock();
      let next: number | null = null;
      const include = (at: number) => { next = next === null ? at : Math.min(next, at); };
      for (const pending of await probes.pendingRecoveries()) {
        include(Math.max(now.getTime(), pending.recoveryClaimExpiresAt?.getTime() ?? 0));
      }
      for (const company of await probes.policies()) {
        for (const connection of await probes.connections(company.companyId)) {
          const seconds = company.policy.apiQuotaRecheckOverrides?.[connection.id]
            ?? company.policy.apiQuotaRecheckSeconds ?? 0;
          if (!Number.isInteger(seconds) || seconds < 300 || seconds > 86400) continue;
          const metadata = aiConnectionMetadataSchema.safeParse(connection.metadata);
          if (!metadata.success || !messagesQuotaDestination(metadata.data)) continue;
          const source = await quota.latestEvidence(company.companyId, connection.id, now, connection.grantId);
          if (!source?.finishedAt || !source.responsibleUserId || !source.grantId || !source.model || source.model === "unknown") continue;
          const last = await probes.latest(company.companyId, connection.id, connection.grantId);
          if (last?.outcome === "available" && last.startedAt >= source.finishedAt) continue;
          let at = Math.max(source.finishedAt.getTime() + seconds * 1000,
            last && last.outcome !== "available" ? last.nextCheckAt.getTime() : 0);
          const caps = company.policy.connectionUsageCaps?.[connection.id];
          if (caps) {
            const capacity = await connectionUsageCapsService(db).check(company.companyId, connection.id, now, caps);
            if (capacity.blocked && capacity.retryAt) at = Math.max(at, Date.parse(capacity.retryAt));
          }
          include(at);
        }
      }
      return next;
    },
  };
}
