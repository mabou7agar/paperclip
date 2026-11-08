import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  connectionGrants,
  agents,
  issues,
  companyPhaseRouting,
  heartbeatRuns,
  providerQuotaProbes,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import type { ApiQuotaProbeOutcome } from "../types/api-quota-probe.js";

export function providerQuotaProbeRepository(db: Db) {
  return {
    policies: () => db.select().from(companyPhaseRouting),
    connections: (companyId: string) =>
      db
        .select({
          id: toolConnections.id,
          grantId: connectionGrants.id,
          metadata: sql<
            Record<string, unknown>
          >`${toolConnections.config}->'ai'`,
        })
        .from(toolConnections)
        .innerJoin(
          connectionGrants,
          and(
            eq(connectionGrants.connectionId, toolConnections.id),
            eq(connectionGrants.companyId, toolConnections.companyId),
            eq(connectionGrants.status, "active"),
          ),
        )
        .where(
          and(
            eq(toolConnections.companyId, companyId),
            eq(toolConnections.connectionPurpose, "ai"),
            eq(toolConnections.enabled, true),
            eq(toolConnections.status, "active"),
            sql`${toolConnections.config}->'ai'->>'method'='api_key'`,
          ),
        ),
    async claim(input: {
      companyId: string;
      connectionId: string;
      grantId: string;
      sourceRunId: string;
      model: string;
      intervalSeconds: number;
      now: Date;
    }) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`quota-probe:${input.companyId}:${input.connectionId}:${input.grantId}`},0))`,
        );
        const [source] = await tx
          .select({ finishedAt: heartbeatRuns.finishedAt })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, input.sourceRunId),
              eq(heartbeatRuns.companyId, input.companyId),
              sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'connectionId'=${input.connectionId}`,
              sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'grantId'=${input.grantId}`,
            ),
          );
        if (
          !source?.finishedAt ||
          source.finishedAt.getTime() + input.intervalSeconds * 1000 >
            input.now.getTime()
        )
          return null;
        const [last] = await tx
          .select()
          .from(providerQuotaProbes)
          .where(
            and(
              eq(providerQuotaProbes.companyId, input.companyId),
              eq(providerQuotaProbes.connectionId, input.connectionId),
              eq(providerQuotaProbes.grantId, input.grantId),
            ),
          )
          .orderBy(
            desc(providerQuotaProbes.startedAt),
            desc(providerQuotaProbes.id),
          )
          .limit(1);
        if (last?.outcome === "available") {
          // A stale caller cannot probe the failure already covered by success.
          // A later failure starts a fresh base interval, not the old backoff.
          if (last.startedAt >= source.finishedAt) return null;
        } else if (last && last.nextCheckAt > input.now) return null;
        const failureCount =
          last?.outcome === "available"
            ? 0
            : Math.min(8, (last?.failureCount ?? -1) + 1);
        // Reserve the next window BEFORE network I/O. A lost response or restart
        // cannot cause the same health request to be dispatched on every sweep.
        const wait = Math.min(86400, input.intervalSeconds * 2 ** failureCount);
        const [row] = await tx
          .insert(providerQuotaProbes)
          .values({
            id: randomUUID(),
            companyId: input.companyId,
            connectionId: input.connectionId,
            grantId: input.grantId,
            sourceRunId: input.sourceRunId,
            model: input.model,
            startedAt: input.now,
            nextCheckAt: new Date(input.now.getTime() + wait * 1000),
            failureCount,
          })
          .returning();
        return row;
      });
    },
    async complete(id: string, result: ApiQuotaProbeOutcome, now: Date) {
      return db
        .update(providerQuotaProbes)
        .set({
          outcome: result.outcome,
          usage: result.usage,
          completedAt: now,
          ...(result.retryAfterSeconds
            ? {
                nextCheckAt: sql`greatest(${providerQuotaProbes.nextCheckAt}, ${new Date(now.getTime() + result.retryAfterSeconds * 1000).toISOString()}::timestamptz)`,
              }
            : {}),
        })
        .where(
          and(
            eq(providerQuotaProbes.id, id),
            isNull(providerQuotaProbes.completedAt),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    },
    pendingRecoveries: () =>
      db
        .select()
        .from(providerQuotaProbes)
        .where(
          and(
            eq(providerQuotaProbes.outcome, "available"),
            isNull(providerQuotaProbes.recoveryDeliveredAt),
          ),
        )
        .orderBy(providerQuotaProbes.completedAt)
        .limit(20),
    claimRecovery: (id: string, now: Date) =>
      db
        .update(providerQuotaProbes)
        .set({
          recoveryClaimId: randomUUID(),
          recoveryClaimExpiresAt: new Date(now.getTime() + 120000),
        })
        .where(
          and(
            eq(providerQuotaProbes.id, id),
            isNull(providerQuotaProbes.recoveryDeliveredAt),
            sql`(${providerQuotaProbes.recoveryClaimExpiresAt} is null or ${providerQuotaProbes.recoveryClaimExpiresAt} <= ${now.toISOString()}::timestamptz)`,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null),
    delivered: (id: string, claimId: string, now: Date) =>
      db
        .update(providerQuotaProbes)
        .set({ recoveryDeliveredAt: now, recoveryClaimExpiresAt: null })
        .where(
          and(
            eq(providerQuotaProbes.id, id),
            eq(providerQuotaProbes.recoveryClaimId, claimId),
            isNull(providerQuotaProbes.recoveryDeliveredAt),
          ),
        ),
    async waitContext(companyId: string, issueId: string, agentId: string) {
      const [row] = await db
        .select({ issue: issues, agent: agents })
        .from(issues)
        .innerJoin(
          agents,
          and(eq(agents.companyId, companyId), eq(agents.id, agentId)),
        )
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
      return row ?? null;
    },
    waits: (companyId: string, before: Date) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "scheduled_retry"),
            eq(heartbeatRuns.scheduledRetryReason, "ai_connection_pool_wait"),
            sql`${heartbeatRuns.createdAt} <= ${before.toISOString()}::timestamptz`,
          ),
        ),
  };
}
