import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companyUsageHealth,
  type Db,
} from "@paperclipai/db";
import type {
  UsageHealthFlag,
  UsageHealthObservation,
  UsageHealthPolicy,
} from "@paperclipai/shared";

export interface UsageHealthRecord extends UsageHealthObservation {
  cursorAt: string;
}
export interface UsageHealthCursor {
  occurredAt: string;
  id: string;
  kind: string;
}
const number = (value: ReturnType<typeof sql>) =>
  sql`case when jsonb_typeof(${value}) = 'number' then (${value})::text::bigint else null end`;

/** Numeric accounting metadata only: never return provider payloads or prompts. */
export function usageHealthRepository(db: Db) {
  return {
    async getPolicy(companyId: string) {
      return db
        .select({ policy: companyUsageHealth.policy })
        .from(companyUsageHealth)
        .where(eq(companyUsageHealth.companyId, companyId))
        .limit(1)
        .then((rows) => rows[0]?.policy ?? null);
    },
    async countCompanyAgents(companyId: string, ids: string[]) {
      return db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)))
        .then((rows) => rows.length);
    },
    async savePolicy(companyId: string, policy: UsageHealthPolicy) {
      await db
        .insert(companyUsageHealth)
        .values({ companyId, policy })
        .onConflictDoUpdate({
          target: companyUsageHealth.companyId,
          set: { policy, updatedAt: new Date() },
        });
      return policy;
    },
    async observations(
      companyId: string,
      from: Date,
      to: Date,
      cursor?: UsageHealthCursor,
      runId?: string,
    ): Promise<UsageHealthRecord[]> {
      const after = cursor
        ? sql`and ("occurredAt",id,kind) > (${cursor.occurredAt}::timestamptz,${cursor.id}::uuid,${cursor.kind})`
        : sql``;
      const selected = runId ? sql`and id=${runId}::uuid` : sql``;
      const rows = await db.execute(sql`
        with observations as (
          select r.id,'agent'::text kind,r.agent_id "agentId",a.name "agentName",r.issue_id "issueId",i.identifier,
            coalesce(r.usage_json->>'provider',r.context_snapshot->'aiConnection'->>'provider','unknown') provider,
            coalesce(r.usage_json->>'model','unknown') model,
            coalesce(r.runner_profile_json->'adapterDispatch'->'phaseRoute'->>'phase','unknown') phase,
            r.status,coalesce(r.started_at,r.created_at) "occurredAt",
            (r.session_id_before is not null and r.session_id_before=r.session_id_after) "sessionReused",
            (r.usage_json->'accountingProviderWorkStarted'='false'::jsonb or r.error_code in
              ('phase_quota_cooldown','phase_route_unavailable','issue_dependencies_blocked','issue_terminal_status','issue_assignee_changed','issue_reassigned')) "expectedNoUsage",
            ${number(sql`r.usage_json->'inputTokens'`)} "inputTokens",
            ${number(sql`r.usage_json->'cachedInputTokens'`)} "cachedInputTokens",
            coalesce(${number(sql`r.usage_json->'cacheWriteTokens'`)},${number(sql`r.result_json->'usage'->'cachedWriteTokens'`)}) "cacheWriteTokens",
            ${number(sql`r.usage_json->'outputTokens'`)} "outputTokens",
            r.usage_json->>'providerRequestId' "providerRequestId",coalesce(r.usage_json->>'billingType','unknown') "billingType",
            r.context_snapshot->'aiConnection'->>'method' "authMethod"
          from heartbeat_runs r left join agents a on a.id=r.agent_id and a.company_id=r.company_id
          left join issues i on i.id=r.issue_id and i.company_id=r.company_id
          where r.company_id=${companyId} and coalesce(r.started_at,r.created_at)>=${from.toISOString()}::timestamptz
            and coalesce(r.started_at,r.created_at)<=${to.toISOString()}::timestamptz
          union all
          select e.id,case when e.usage_kind='agent' then 'agent_cost' else e.usage_kind end,e.agent_id,a.name,e.issue_id,i.identifier,e.provider,e.model,e.usage_kind,
            'succeeded',e.occurred_at,false,false,e.input_tokens::bigint,e.cached_input_tokens::bigint,null::bigint,e.output_tokens::bigint,
            e.provider_request_id,e.billing_type,null::text
          from cost_events e left join agents a on a.id=e.agent_id and a.company_id=e.company_id
          left join issues i on i.id=e.issue_id and i.company_id=e.company_id
          where e.company_id=${companyId} and (e.usage_kind<>'agent' or not exists (
            select 1 from heartbeat_runs mirrored where mirrored.id=e.heartbeat_run_id and mirrored.company_id=e.company_id))
            and e.occurred_at>=${from.toISOString()}::timestamptz
            and e.occurred_at<=${to.toISOString()}::timestamptz
        ) select *, "occurredAt"::text as "cursorAt" from observations where true ${after} ${selected} order by "occurredAt",id,kind limit 500`);
      return rows.map((row) => ({
        ...row,
        occurredAt: new Date(String(row.occurredAt)).toISOString(),
        expectedNoUsage: row.expectedNoUsage === true,
        ...Object.fromEntries(
          [
            "inputTokens",
            "cachedInputTokens",
            "cacheWriteTokens",
            "outputTokens",
          ].map((key) => [key, row[key] == null ? null : Number(row[key])]),
        ),
      })) as unknown as UsageHealthRecord[];
    },
    async taskRunCount(companyId: string, issueId: string, at: string) {
      const rows =
        await db.execute(sql`select count(*)::int count from heartbeat_runs where company_id=${companyId}
        and issue_id=${issueId} and coalesce(started_at,created_at) between ${at}::timestamptz-interval '1 hour' and ${at}::timestamptz
        and (coalesce((usage_json->>'inputTokens')::bigint,0)>0 or coalesce((usage_json->>'outputTokens')::bigint,0)>0 or coalesce((usage_json->>'cachedInputTokens')::bigint,0)>0)`);
      return Number(rows[0]?.count ?? 0);
    },
    async recentAlerts(companyId: string, from: Date, to: Date) {
      return db
        .select({ flag: activityLog.details })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "usage.health_alert"),
            sql`${activityLog.createdAt} >= ${from.toISOString()}::timestamptz`,
            sql`${activityLog.createdAt} <= ${to.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(50)
        .then((rows) =>
          rows.map((row) => row.flag as unknown as UsageHealthFlag),
        );
    },
    async addAlert(companyId: string, flag: UsageHealthFlag) {
      const rows = await db
        .insert(activityLog)
        .values({
          id: flag.id,
          companyId,
          actorType: "system",
          actorId: "usage-health",
          action: "usage.health_alert",
          entityType: flag.kind === "agent" ? "heartbeat_run" : "cost_event",
          entityId: flag.runId,
          runId: flag.kind === "agent" ? flag.runId : null,
          agentId: flag.agentId,
          details: { ...flag },
        })
        .onConflictDoNothing()
        .returning({ id: activityLog.id });
      return rows.length > 0;
    },
  };
}
