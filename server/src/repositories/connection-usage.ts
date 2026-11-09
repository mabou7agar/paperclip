import { and, eq, inArray, sql } from "drizzle-orm";
import { toolConnections, type Db } from "@paperclipai/db";
import type { ConnectionUsageObservation } from "../types/connection-usage.js";

/** Read each source once. Never add mirrored heartbeat totals to their ledger events. */
export function connectionUsageRepository(db: Db) {
  return {
    async owns(companyId: string, ids: string[]) {
      if (!ids.length) return true;
      const rows = await db
        .select({ id: toolConnections.id })
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, companyId),
            eq(toolConnections.connectionPurpose, "ai"),
            inArray(toolConnections.id, ids),
          ),
        );
      return rows.length === ids.length;
    },
    async observations(
      companyId: string,
      connectionId: string,
      from: Date,
      now: Date,
    ): Promise<ConnectionUsageObservation[]> {
      const rows = await db.execute(sql`
        with selected_runs as (
          select id,usage_json,result_json,error_code,started_at,created_at,finished_at,status
          from heartbeat_runs r where company_id=${companyId}
            and context_snapshot->'aiConnection'->>'connectionId'=${connectionId}
            and not exists(select 1 from cost_events accounted where accounted.company_id=${companyId} and accounted.heartbeat_run_id=r.id)
            and coalesce(finished_at,started_at,created_at)>=${from.toISOString()}::timestamptz
            and coalesce(finished_at,started_at,created_at)<=${now.toISOString()}::timestamptz
        ), ledger as (
          select e.id,e.occurred_at as at,
            case when e.cost_status='unpriced' and e.input_tokens=0 and e.cached_input_tokens=0 and e.output_tokens=0 then null else (case when e.receipt_hash is null and e.provider='openai' and e.model not like 'openai/_%'
              then greatest(0,e.input_tokens-e.cached_input_tokens) else e.input_tokens end)::bigint
              +e.cached_input_tokens::bigint+e.output_tokens::bigint end as tokens,
            case when e.billing_type='subscription_included' then '0'
              when e.billing_type in ('metered_api','subscription_overage') and e.cost_status<>'unpriced' then e.cost_cents::text
              else null end as cost
          from cost_events e where e.company_id=${companyId}
            and e.occurred_at>=${from.toISOString()}::timestamptz and e.occurred_at<=${now.toISOString()}::timestamptz
            and (e.connection_id=${connectionId}::uuid or (e.connection_id is null and (exists(select 1 from heartbeat_runs legacy where legacy.id=e.heartbeat_run_id and legacy.company_id=e.company_id and legacy.context_snapshot->'aiConnection'->>'connectionId'=${connectionId})
              or exists(select 1 from decision_invocations d where d.company_id=e.company_id and d.connection_id=${connectionId}::uuid and d.cost_event_id=e.id)
              or exists(select 1 from fast_response_requests f where f.company_id=e.company_id and f.connection_id=${connectionId}::uuid and f.cost_event_id=e.id))))
        )
        select at,tokens,cost from ledger
        union all
        select coalesce(r.finished_at,r.started_at,r.created_at),
          case when jsonb_typeof(r.usage_json->'inputTokens')='number' and jsonb_typeof(r.usage_json->'outputTokens')='number'
            then (r.usage_json->>'inputTokens')::bigint+coalesce((r.usage_json->>'cachedInputTokens')::bigint,0)+(r.usage_json->>'outputTokens')::bigint
            else null end,
          case when r.usage_json->>'billingType'='subscription_included' then '0' else null end
        from selected_runs r where not exists(select 1 from cost_events e where e.company_id=${companyId} and e.heartbeat_run_id=r.id)
          and (r.finished_at is not null or jsonb_typeof(r.usage_json->'inputTokens')='number')
          and r.error_code is distinct from 'phase_quota_cooldown'
          and r.error_code is distinct from 'connection_usage_cap'
          and coalesce(r.result_json#>>'{executionRecovery,providerWorkStarted}','true')<>'false'
          and coalesce(r.usage_json->>'accountingProviderWorkStarted','true')<>'false'
        union all
        select p.started_at,
          case when jsonb_typeof(p.usage->'inputTokens')='number' and jsonb_typeof(p.usage->'outputTokens')='number'
            then (p.usage->>'inputTokens')::bigint+coalesce((p.usage->>'cachedInputTokens')::bigint,0)+(p.usage->>'outputTokens')::bigint else null end,
          case when p.usage->>'inputTokens'='0' and p.usage->>'outputTokens'='0' then '0' else null end
        from provider_quota_probes p where p.company_id=${companyId} and p.connection_id=${connectionId}::uuid
          and p.started_at>=${from.toISOString()}::timestamptz and p.started_at<=${now.toISOString()}::timestamptz
        order by at
      `);
      return rows.map((r) => ({
        at: new Date(String(r.at)),
        tokens: r.tokens == null ? null : Number(r.tokens),
        apiCostCents: r.cost == null ? null : String(r.cost),
      }));
    },
  };
}
