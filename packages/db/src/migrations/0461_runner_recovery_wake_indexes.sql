-- Reserve keys separately so pre-upgrade duplicate receipts remain immutable.
-- A null owner is a permanent ambiguity fence, never a choice of one legacy row.
BEGIN;
LOCK TABLE "agent_wakeup_requests" IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE IF NOT EXISTS "runner_result_wake_keys" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "idempotency_key" text NOT NULL,
  "wakeup_request_id" uuid,
  PRIMARY KEY ("company_id", "idempotency_key")
);
INSERT INTO "runner_result_wake_keys" ("company_id", "idempotency_key", "wakeup_request_id")
SELECT "company_id", "idempotency_key",
  CASE WHEN count(*) = 1 THEN min("id"::text)::uuid ELSE NULL END
FROM "agent_wakeup_requests"
WHERE "idempotency_key" LIKE 'runner-result:%' AND "status" <> 'skipped'
GROUP BY "company_id", "idempotency_key"
ON CONFLICT ("company_id", "idempotency_key") DO NOTHING;
CREATE OR REPLACE FUNCTION "guard_runner_result_wake_key"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reserved uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.company_id IS NOT DISTINCT FROM NEW.company_id
     AND OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key
     AND (OLD.status <> 'skipped') = (NEW.status <> 'skipped') THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.idempotency_key LIKE 'runner-result:%' AND OLD.status <> 'skipped' THEN
    DELETE FROM runner_result_wake_keys WHERE company_id = OLD.company_id
      AND idempotency_key = OLD.idempotency_key AND wakeup_request_id = OLD.id;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.idempotency_key LIKE 'runner-result:%' AND NEW.status <> 'skipped' THEN
    INSERT INTO runner_result_wake_keys (company_id, idempotency_key, wakeup_request_id)
      VALUES (NEW.company_id, NEW.idempotency_key, NEW.id)
      ON CONFLICT (company_id, idempotency_key) DO UPDATE
        SET wakeup_request_id = runner_result_wake_keys.wakeup_request_id
      RETURNING wakeup_request_id INTO reserved;
    IF reserved IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'Runner result wake key already reserved' USING ERRCODE = '23505',
        CONSTRAINT = 'runner_result_wake_keys_pkey';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "guard_runner_result_wake_key" ON "agent_wakeup_requests";
CREATE TRIGGER "guard_runner_result_wake_key" BEFORE INSERT OR UPDATE OR DELETE ON "agent_wakeup_requests"
FOR EACH ROW EXECUTE FUNCTION "guard_runner_result_wake_key"();
COMMIT;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_runner_recovery_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'runner-recovery:%' AND "agent_wakeup_requests"."status" <> 'skipped';
