import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/** Bounded, connection-scoped health requests; never agent turns or prompt storage. */
export const providerQuotaProbes = pgTable(
  "provider_quota_probes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull(),
    grantId: uuid("grant_id").notNull(),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    model: text("model").notNull(),
    trigger: text("trigger").notNull().default("scheduled"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    outcome: text("outcome").notNull().default("pending"),
    usage: jsonb("usage").$type<{
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      cacheWriteTokens: number | null;
    }>(),
    recoveryClaimId: uuid("recovery_claim_id"),
    recoveryClaimExpiresAt: timestamp("recovery_claim_expires_at", {
      withTimezone: true,
    }),
    recoveryDeliveredAt: timestamp("recovery_delivered_at", {
      withTimezone: true,
    }),
  },
  (table) => ({
    accountTime: index("provider_quota_probes_account_time_idx").on(
      table.companyId,
      table.connectionId,
      table.grantId,
      table.startedAt.desc().nullsFirst(),
    ),
    source: index("provider_quota_probes_source_idx").on(
      table.companyId,
      table.sourceRunId,
    ),
  }),
);
