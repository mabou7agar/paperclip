import { eq } from "drizzle-orm";
import { companyPhaseRouting, type Db } from "@paperclipai/db";
import type { PhaseRouting } from "@paperclipai/shared";

export function phaseRoutingSettingsRepository(db: Db) {
  return {
    async get(companyId: string): Promise<PhaseRouting | null> {
      return db.select({ policy: companyPhaseRouting.policy }).from(companyPhaseRouting)
        .where(eq(companyPhaseRouting.companyId, companyId)).limit(1).then(rows => rows[0]?.policy ?? null);
    },
    async save(companyId: string, policy: PhaseRouting) {
      await db.insert(companyPhaseRouting).values({ companyId, policy }).onConflictDoUpdate({
        target: companyPhaseRouting.companyId, set: { policy, updatedAt: new Date() },
      });
      return policy;
    },
  };
}
