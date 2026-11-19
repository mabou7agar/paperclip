import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { runnerRecoveryPolicies } from "./runner_recovery_policies.js";

/** Exact signed bytes are private storage, never returned by the issue API. */
export const runnerRecoveryResults = pgTable("runner_recovery_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  pluginId: uuid("plugin_id").notNull(),
  jobId: uuid("job_id").notNull(),
  receiptSha256: text("receipt_sha256").notNull(),
  resultFingerprint: text("result_fingerprint").notNull(),
  policyId: uuid("policy_id").references(() => runnerRecoveryPolicies.id),
  policyKey: text("policy_key"),
  policyRevision: text("policy_revision"),
  state: text("state").notNull().default("ingested"),
  stateVersion: integer("state_version").notNull().default(0),
  reason: text("reason"),
  resumeOn: jsonb("resume_on").$type<string[]>(),
  envelopeBytes: text("envelope_bytes").notNull(),
  envelopeSha256: text("envelope_sha256").notNull(),
  sequence: integer("sequence").notNull(),
  fence: jsonb("fence").$type<Record<string, unknown>>(),
  targetAgentId: uuid("target_agent_id"),
  wakeIdempotencyKey: text("wake_idempotency_key"),
  wakeupRequestId: uuid("wakeup_request_id"),
  recoveryActionId: uuid("recovery_action_id"),
  supersededBy: uuid("superseded_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  ingestionUq: uniqueIndex("runner_recovery_results_ingestion_uq").on(t.companyId, t.issueId, t.jobId, t.receiptSha256),
  fingerprintUq: uniqueIndex("runner_recovery_results_fingerprint_uq").on(t.companyId, t.issueId, t.policyKey, t.resultFingerprint)
    .where(sql`${t.state} in ('routing', 'routed')`),
  deferredIdx: index("runner_recovery_results_deferred_idx").on(t.companyId, t.issueId, t.createdAt).where(sql`${t.state} = 'deferred'`),
}));
