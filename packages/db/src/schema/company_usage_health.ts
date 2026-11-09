import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { UsageHealthPolicy } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const companyUsageHealth = pgTable("company_usage_health", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  policy: jsonb("policy").$type<UsageHealthPolicy>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
