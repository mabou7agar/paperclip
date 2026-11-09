ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "connection_id" uuid;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Prebuild this exact index CONCURRENTLY on busy installations after adding the nullable archival column; the transactional migration adopts it.
CREATE INDEX IF NOT EXISTS "cost_events_company_connection_occurred_idx" ON "cost_events" USING btree ("company_id","connection_id","occurred_at");
--> statement-breakpoint
UPDATE cost_events e SET connection_id=(r.context_snapshot->'aiConnection'->>'connectionId')::uuid
FROM heartbeat_runs r WHERE e.connection_id IS NULL AND e.heartbeat_run_id=r.id AND e.company_id=r.company_id
AND r.context_snapshot->'aiConnection'->>'connectionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint
UPDATE cost_events e SET connection_id=d.connection_id FROM decision_invocations d
WHERE e.connection_id IS NULL AND d.cost_event_id=e.id AND d.company_id=e.company_id;
--> statement-breakpoint
UPDATE cost_events e SET connection_id=f.connection_id FROM fast_response_requests f
WHERE e.connection_id IS NULL AND f.cost_event_id=e.id AND f.company_id=e.company_id;
