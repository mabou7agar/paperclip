import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { MonitoringPolicy } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const companyMonitoringPolicies = pgTable("company_monitoring_policies", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  policy: jsonb("policy").$type<MonitoringPolicy>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
