import { and, eq, sql } from "drizzle-orm";
import {
  heartbeatRuns,
  decisionInvocations,
  fastResponseRequests,
  type Db,
} from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

/** Derive account identity from the server-owned source, never from a reported receipt. */
export async function costConnectionAttribution(
  db: Db,
  companyId: string,
  source: {
    heartbeatRunId?: string | null;
    usageKind?: string;
    idempotencyKey?: string | null;
  },
) {
  if (source.heartbeatRunId) {
    const [row] = await db
      .select({
        id: sql<string>`${heartbeatRuns.contextSnapshot}->'aiConnection'->>'connectionId'`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.id, source.heartbeatRunId),
        ),
      );
    return row?.id && isUuidLike(row.id) ? row.id : null;
  }
  const prefix =
    source.usageKind === "decision"
      ? "decision:"
      : source.usageKind === "fast_response"
        ? "fast-response:"
        : null;
  const id =
    prefix && source.idempotencyKey?.startsWith(prefix)
      ? source.idempotencyKey.slice(prefix.length)
      : null;
  if (!id || !isUuidLike(id)) return null;
  const table =
    source.usageKind === "decision"
      ? decisionInvocations
      : fastResponseRequests;
  const [row] = await db
    .select({ id: table.connectionId })
    .from(table)
    .where(and(eq(table.companyId, companyId), eq(table.id, id)));
  return row?.id ?? null;
}
