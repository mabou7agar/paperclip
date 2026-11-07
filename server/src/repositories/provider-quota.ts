import { and, desc, eq, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** Read immutable execution attribution, never an agent's mutable current account. */
export function providerQuotaRepository(db: Db) {
  return {
    async latestEvidence(companyId: string, connectionId: string, _now: Date) {
      return db.select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        result: heartbeatRuns.resultJson,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
        provider: sql<string>`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'provider'`,
      }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId),
        sql`not exists (select 1 from activity_log recovery where recovery.company_id=${companyId}
          and recovery.entity_type='tool_connection' and recovery.entity_id=${connectionId}
          and recovery.action='ai_connection.quota_recovery_acknowledged' and recovery.actor_type='user'
          and recovery.created_at >= ${heartbeatRuns.finishedAt})`,
        sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'connectionId' = ${connectionId}`,
        or(
          eq(heartbeatRuns.errorCode, "provider_quota"),
          // Preserve immutable older receipts whose typed 429 was unclassified.
          and(eq(heartbeatRuns.errorCode, "acpx_turn_failed"),
            sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'provider' = 'anthropic'`,
            sql`${heartbeatRuns.resultJson}->'terminalSessionFailure'->>'category' = 'limit'`,
            sql`coalesce(${heartbeatRuns.resultJson}->'terminalSessionFailure'->>'title', '') ~* '(HTTP[[:space:]]+429|rejected[[:space:]]*[(]429[)])'`),
          sql`${heartbeatRuns.resultJson}->>'errorFamily' = 'provider_quota'`,
        ),
      )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id)).limit(1).then(rows => rows[0] ?? null);
    },
  };
}
