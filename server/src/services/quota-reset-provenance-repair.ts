import type { Db } from "@paperclipai/db";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { logActivity } from "./activity-log.js";

/** Repair derived recovery metadata from its first trusted audit event; provider/usage evidence stays intact. */
export async function repairQuotaResetProvenance(db: Db, input: { companyId: string; userId: string }) {
  const repository = providerQuotaRepository(db);
  const result = { repaired: 0, provider: 0, backoff: 0, skipped: 0 };
  for (const row of await repository.unlabelledRecoveryResets(input.companyId)) {
    if (typeof row.parsedResetTime !== "boolean") { result.skipped++; continue; }
    const source = row.parsedResetTime ? "provider" : "backoff";
    if (!await repository.labelRecoveryReset(input.companyId, row.runId, source)) continue;
    result.repaired++; result[source]++;
    await logActivity(db, { companyId: input.companyId, actorType: "user", actorId: input.userId,
      action: "heartbeat.quota_reset_provenance_repaired", entityType: "heartbeat_run", entityId: row.runId,
      runId: row.runId, details: { providerQuotaResetSource: source, authority: "first_recovery_monitor_audit" } });
  }
  return result;
}
