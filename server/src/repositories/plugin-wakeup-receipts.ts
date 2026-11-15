import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

export async function findPluginWakeupReceipts(db: Db, companyId: string, pluginId: string, key: string) {
  return db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId),
    eq(agentWakeupRequests.requestedByActorType, "system"),
    eq(agentWakeupRequests.requestedByActorId, pluginId),
    eq(agentWakeupRequests.idempotencyKey, key),
  )).limit(2);
}
