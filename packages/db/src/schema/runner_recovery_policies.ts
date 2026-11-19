import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/** Protected registration only. The router is a reader of this append-only authority ledger. */
export const runnerRecoveryPolicies = pgTable("runner_recovery_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  policyKey: text("policy_key").notNull(),
  revision: text("revision").notNull(),
  sourceCommentId: uuid("source_comment_id").notNull(),
  sourceAuthorUserId: text("source_author_user_id").notNull(),
  sourceBodySha256: text("source_body_sha256").notNull(),
  rootIssueId: uuid("root_issue_id").notNull().references(() => issues.id),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  registeredBy: text("registered_by").notNull(),
  activatedBy: text("activated_by"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ revisionUq: uniqueIndex("runner_recovery_policies_revision_uq").on(t.companyId, t.policyKey, t.revision) }));

/** Separate from policy activation and inaccessible to generic company updates. */
export const runnerRecoveryCompanySettings = pgTable("runner_recovery_company_settings", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id),
  runnerPolicyRecovery: jsonb("runner_policy_recovery").$type<{ enabled: boolean }>().notNull().default({ enabled: false }),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
