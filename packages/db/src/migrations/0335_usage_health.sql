CREATE TABLE "company_usage_health" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_usage_health" ADD CONSTRAINT "company_usage_health_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;