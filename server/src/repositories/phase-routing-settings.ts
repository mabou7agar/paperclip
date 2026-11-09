import { eq } from "drizzle-orm";
import { companyPhaseRouting, type Db } from "@paperclipai/db";
import type { PhaseRouting } from "@paperclipai/shared";

export function phaseRoutingSettingsRepository(db: Pick<Db, "select" | "insert">) {
  function get(companyId: string, forUpdate = false): Promise<PhaseRouting | null> {
    const query = db.select({ policy: companyPhaseRouting.policy }).from(companyPhaseRouting)
      .where(eq(companyPhaseRouting.companyId, companyId)).limit(1);
    return (forUpdate ? query.for("update") : query).then(rows => rows[0]?.policy ?? null);
  }
  return {
    get: (companyId: string) => get(companyId),
    getForUpdate: (companyId: string) => get(companyId, true),
    async save(companyId: string, policy: PhaseRouting) {
      await db.insert(companyPhaseRouting).values({ companyId, policy }).onConflictDoUpdate({
        target: companyPhaseRouting.companyId, set: { policy, updatedAt: new Date() },
      });
      return policy;
    },
  };
}
