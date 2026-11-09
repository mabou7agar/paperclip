CREATE TABLE "provider_quota_probes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL CONSTRAINT "provider_quota_probes_company_id_companies_id_fk" REFERENCES "companies"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL,
  "grant_id" uuid NOT NULL,
  "source_run_id" uuid CONSTRAINT "provider_quota_probes_source_run_id_heartbeat_runs_id_fk" REFERENCES "heartbeat_runs"("id") ON DELETE SET NULL,
  "model" text NOT NULL,
  "trigger" text DEFAULT 'scheduled' NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "next_check_at" timestamp with time zone NOT NULL,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "outcome" text DEFAULT 'pending' NOT NULL,
  "usage" jsonb,
  "recovery_claim_id" uuid,
  "recovery_claim_expires_at" timestamp with time zone,
  "recovery_delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "provider_quota_probes_account_time_idx" ON "provider_quota_probes" ("company_id", "connection_id", "grant_id", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX "provider_quota_probes_source_idx" ON "provider_quota_probes" ("company_id", "source_run_id");
