CREATE TABLE "runner_recovery_company_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"runner_policy_recovery" jsonb DEFAULT '{"enabled":false}'::jsonb NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_recovery_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"policy_key" text NOT NULL,
	"revision" text NOT NULL,
	"source_comment_id" uuid NOT NULL,
	"source_author_user_id" text NOT NULL,
	"source_body_sha256" text NOT NULL,
	"root_issue_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"registered_by" text NOT NULL,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_recovery_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"receipt_sha256" text NOT NULL,
	"result_fingerprint" text NOT NULL,
	"policy_id" uuid,
	"policy_key" text,
	"policy_revision" text,
	"state" text DEFAULT 'ingested' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"resume_on" jsonb,
	"envelope_bytes" text NOT NULL,
	"envelope_sha256" text NOT NULL,
	"sequence" integer NOT NULL,
	"fence" jsonb,
	"target_agent_id" uuid,
	"wake_idempotency_key" text,
	"wakeup_request_id" uuid,
	"recovery_action_id" uuid,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runner_recovery_company_settings" ADD CONSTRAINT "runner_recovery_company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_recovery_policies" ADD CONSTRAINT "runner_recovery_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_recovery_policies" ADD CONSTRAINT "runner_recovery_policies_root_issue_id_issues_id_fk" FOREIGN KEY ("root_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_recovery_results" ADD CONSTRAINT "runner_recovery_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_recovery_results" ADD CONSTRAINT "runner_recovery_results_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_recovery_results" ADD CONSTRAINT "runner_recovery_results_policy_id_runner_recovery_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."runner_recovery_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_recovery_policies_revision_uq" ON "runner_recovery_policies" USING btree ("company_id","policy_key","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_recovery_results_ingestion_uq" ON "runner_recovery_results" USING btree ("company_id","issue_id","job_id","receipt_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_recovery_results_fingerprint_uq" ON "runner_recovery_results" USING btree ("company_id","issue_id","policy_key","result_fingerprint") WHERE "runner_recovery_results"."state" in ('routing', 'routed');--> statement-breakpoint
CREATE INDEX "runner_recovery_results_deferred_idx" ON "runner_recovery_results" USING btree ("company_id","issue_id","created_at") WHERE "runner_recovery_results"."state" = 'deferred';