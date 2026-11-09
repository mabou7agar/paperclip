import { and, asc, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import {
  activityLog,
  heartbeatRuns,
  providerQuotaProbes,
  type Db,
} from "@paperclipai/db";

/** Read immutable execution attribution, never an agent's mutable current account. */
export function providerQuotaRepository(db: Db) {
  return {
    async unlabelledRecoveryResets(companyId: string) {
      const rows = await db
        .selectDistinctOn([heartbeatRuns.id], {
          runId: heartbeatRuns.id,
          details: activityLog.details,
        })
        .from(heartbeatRuns)
        .leftJoin(
          activityLog,
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.runId, heartbeatRuns.id),
            eq(activityLog.actorType, "system"),
            eq(activityLog.actorId, "recovery"),
            eq(activityLog.action, "issue.monitor_scheduled"),
            sql`${activityLog.details}->>'source' = 'recovery.provider_quota'`,
          ),
        )
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            sql`${heartbeatRuns.resultJson}->>'recoveryClassification' = 'provider_quota'`,
            sql`${heartbeatRuns.resultJson}->>'providerQuotaResetSource' is null`,
          ),
        )
        .orderBy(
          heartbeatRuns.id,
          asc(activityLog.createdAt),
          asc(activityLog.id),
        );
      return rows.map((row) => ({
        runId: row.runId,
        parsedResetTime: row.details?.parsedResetTime,
      }));
    },
    async labelRecoveryReset(
      companyId: string,
      runId: string,
      source: "provider" | "backoff",
    ) {
      return db
        .update(heartbeatRuns)
        .set({
          resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
        || jsonb_build_object('providerQuotaResetSource',${source}::text)`,
        })
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.id, runId),
            sql`${heartbeatRuns.resultJson}->>'providerQuotaResetSource' is null`,
          ),
        )
        .returning({ id: heartbeatRuns.id })
        .then((rows) => rows.length > 0);
    },
    async latestEvidence(
      companyId: string,
      connectionId: string,
      _now: Date,
      grantId?: string,
    ) {
      // Resolve immutable recovery boundaries once. Correlated anti-joins against
      // historical runs can defeat the account/time index on a populated database.
      const [ownerRecovery] = await db
        .select({ at: activityLog.createdAt })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "tool_connection"),
            eq(activityLog.entityId, connectionId),
            eq(activityLog.action, "ai_connection.quota_recovery_acknowledged"),
            eq(activityLog.actorType, "user"),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(1);
      const probes = await db
        .selectDistinctOn([providerQuotaProbes.grantId], {
          grantId: providerQuotaProbes.grantId,
          at: providerQuotaProbes.startedAt,
        })
        .from(providerQuotaProbes)
        .where(
          and(
            eq(providerQuotaProbes.companyId, companyId),
            eq(providerQuotaProbes.connectionId, connectionId),
            eq(providerQuotaProbes.outcome, "available"),
            grantId ? eq(providerQuotaProbes.grantId, grantId) : undefined,
          ),
        )
        .orderBy(
          providerQuotaProbes.grantId,
          desc(providerQuotaProbes.startedAt),
        );
      const attributedGrant = sql<string>`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'grantId'`;
      return db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          responsibleUserId: heartbeatRuns.responsibleUserId,
          grantId: sql<string>`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'grantId'`,
          model: sql<string>`coalesce(${heartbeatRuns.runnerProfileJson}#>>'{adapterDispatch,phaseRoute,profile,model}', ${heartbeatRuns.usageJson}->>'model')`,
          status: heartbeatRuns.status,
          finishedAt: heartbeatRuns.finishedAt,
          result: heartbeatRuns.resultJson,
          errorCode: heartbeatRuns.errorCode,
          error: heartbeatRuns.error,
          provider: sql<string>`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'provider'`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            grantId
              ? sql`(${heartbeatRuns.contextSnapshot}->'aiConnection'->>'grantId'=${grantId} or ${heartbeatRuns.contextSnapshot}->'aiConnection'->>'grantId' is null)`
              : undefined,
            ownerRecovery
              ? or(
                  isNull(heartbeatRuns.finishedAt),
                  gt(heartbeatRuns.finishedAt, ownerRecovery.at),
                )
              : undefined,
            ...probes.map((probe) =>
              or(
                isNull(heartbeatRuns.finishedAt),
                isNull(attributedGrant),
                ne(attributedGrant, probe.grantId),
                gt(heartbeatRuns.finishedAt, probe.at),
              ),
            ),
            sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'connectionId' = ${connectionId}`,
            // Keep literals aligned with the partial quota-receipt index so
            // prepared queries also avoid scanning large successful run contexts.
            sql`(${heartbeatRuns.errorCode} = 'provider_quota'
              or (${heartbeatRuns.errorCode} = 'acpx_turn_failed'
                and ${heartbeatRuns.contextSnapshot}->'aiConnection'->>'provider' = 'anthropic'
                and ${heartbeatRuns.resultJson}->'terminalSessionFailure'->>'category' = 'limit'
                and coalesce(${heartbeatRuns.resultJson}->'terminalSessionFailure'->>'title', '') ~* '(HTTP[[:space:]]+429|rejected[[:space:]]*[(]429[)])')
              or ${heartbeatRuns.resultJson}->>'errorFamily' = 'provider_quota')`,
          ),
        )
        .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
    },
  };
}
