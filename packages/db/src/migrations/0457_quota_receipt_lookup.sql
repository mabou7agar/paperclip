-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Transactional migration adopts the exact index prebuilt CONCURRENTLY on busy installations; fresh installations have no run history.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_quota_receipt_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'aiConnection' ->> 'connectionId'),"finished_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE ("heartbeat_runs"."error_code" = 'provider_quota'
      or ("heartbeat_runs"."error_code" = 'acpx_turn_failed'
        and "heartbeat_runs"."context_snapshot"->'aiConnection'->>'provider' = 'anthropic'
        and "heartbeat_runs"."result_json"->'terminalSessionFailure'->>'category' = 'limit'
        and coalesce("heartbeat_runs"."result_json"->'terminalSessionFailure'->>'title', '') ~* '(HTTP[[:space:]]+429|rejected[[:space:]]*[(]429[)])')
      or "heartbeat_runs"."result_json"->>'errorFamily' = 'provider_quota');
