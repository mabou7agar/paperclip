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
      }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId),
        sql`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'connectionId' = ${connectionId}`,
        or(
          eq(heartbeatRuns.errorCode, "provider_quota"),
          sql`${heartbeatRuns.resultJson}->>'errorFamily' = 'provider_quota'`,
        ),
      )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id)).limit(1).then(rows => rows[0] ?? null);
    },
  };
}
