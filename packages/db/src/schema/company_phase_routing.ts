import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { PhaseRouting } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const companyPhaseRouting = pgTable("company_phase_routing", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  policy: jsonb("policy").$type<PhaseRouting>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
