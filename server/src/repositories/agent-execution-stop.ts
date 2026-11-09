import { and, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, nativeRunResults, type Db } from "@paperclipai/db";

/** Stop scans must never materialize every run's prompts, output, or usage. */
export function listAgentExecutionStopObservations(db: Db, agentIds: string[]) {
  return db.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
    startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
    processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
    processStartedAt: heartbeatRuns.processStartedAt,
    controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
    controllerBootId: heartbeatRuns.controllerBootId, nextEventSeq: heartbeatRuns.nextEventSeq,
    updatedAt: heartbeatRuns.updatedAt,
  }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
}

export type AgentExecutionStopObservation = Awaited<ReturnType<typeof listAgentExecutionStopObservations>>[number];

/** Read one exceptional cancellation at a time, retaining all verification fields. */
export async function readCancelledExecutionStopRun(db: Db, observed: AgentExecutionStopObservation) {
  const [run] = await db.select({
    ...getTableColumns(heartbeatRuns),
    resultJson: sql<typeof heartbeatRuns.$inferSelect["resultJson"]>`${heartbeatRuns.resultJson} - 'stdout' - 'stderr'`,
    resultOutputPresent: sql<boolean>`coalesce(length(${heartbeatRuns.resultJson}->>'stdout'), 0) > 0
      or coalesce(length(${heartbeatRuns.resultJson}->>'stderr'), 0) > 0`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, observed.companyId), eq(heartbeatRuns.id, observed.id)));
  return run ?? null;
}

export type CancelledExecutionStopRun = NonNullable<Awaited<ReturnType<typeof readCancelledExecutionStopRun>>>;

export async function readPreparationJournalEvidence(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">,
  executionStarted: SQL) {
  const [evidence] = await db.select({
    count: sql<number>`count(*)::integer`,
    distinctCount: sql<number>`count(distinct ${heartbeatRunEvents.seq})::integer`,
    firstSeq: sql<number | null>`min(${heartbeatRunEvents.seq})::double precision`,
    lastSeq: sql<number | null>`max(${heartbeatRunEvents.seq})::double precision`,
    executionStarted: sql<boolean>`coalesce(bool_or(${executionStarted}), false)`,
    resultExists: sql<boolean>`exists (select 1 from ${nativeRunResults}
      where ${nativeRunResults.companyId} = ${run.companyId} and ${nativeRunResults.runId} = ${run.id})`,
  }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id)));
  return evidence;
}
