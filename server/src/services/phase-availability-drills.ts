import type { PhaseAvailabilityDrill, PhaseRouting } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { phaseAvailabilityDrillRepository } from "../repositories/phase-availability-drills.js";
import { unprocessable } from "../errors.js";

export const MAX_AVAILABILITY_DRILL_MS = 30 * 60 * 1_000;

/** A controlled eligibility fault exercises fallback without forging quota evidence. */
export function phaseAvailabilityDrillService(db: Db) {
  const repository = phaseAvailabilityDrillRepository(db);
  return {
    async validateNew(companyId: string, policy: PhaseRouting, previous: PhaseRouting | null, now = new Date()) {
      const ids = new Set<string>();
      for (const [issueId, override] of Object.entries(policy.taskOverrides ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        const drill = override.availabilityDrill;
        if (!drill) continue;
        const profiles = override[drill.phase] ?? policy[drill.phase] ?? [];
        if (ids.has(drill.id) || profiles.length < 2 || profiles[0]?.id !== drill.profileId) {
          throw unprocessable("A controlled availability drill needs a unique id, the primary profile and a fallback");
        }
        ids.add(drill.id);
        // PostgreSQL JSONB does not retain JavaScript property order.
        const old = previous?.taskOverrides?.[issueId]?.availabilityDrill;
        if (old?.id === drill.id && old.phase === drill.phase && old.profileId === drill.profileId && old.expiresAt === drill.expiresAt) continue;
        const remaining = Date.parse(drill.expiresAt) - now.getTime();
        if (!policy.enabled || remaining <= 0 || remaining > MAX_AVAILABILITY_DRILL_MS) {
          throw unprocessable("A new controlled availability drill must expire within 30 minutes and use enabled routing");
        }
        if (!await repository.isUnstartedTask(companyId, issueId)) {
          throw unprocessable("Arm a drill only on an unassigned, unstarted backlog task in this company");
        }
      }
    },
    async apply(companyId: string, issueId: string, drill: PhaseAvailabilityDrill) {
      return repository.apply(companyId, issueId, drill);
    },
  };
}
