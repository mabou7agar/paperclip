-- Optional company default for the agent that receives a capped review before
-- the responsible human. Null (the default) keeps the human-only escalation.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "default_review_escalation_agent_id" uuid;
