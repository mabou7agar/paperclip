import { quotaRecoveryRequestSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { aiConnectionService } from "./ai-connections.js";
import { logActivity } from "./activity-log.js";
import { notFound } from "../errors.js";

/** Explicit owner recovery evidence; immutable provider failures remain intact. */
export function providerQuotaRecoveryService(db: Db) {
  return {
    async acknowledge(input: {
      companyId: string;
      userId: string;
      connectionId: string;
      reason: string;
    }) {
      const { reason } = quotaRecoveryRequestSchema.parse({
        reason: input.reason,
      });
      const account = (
        await aiConnectionService(db).list(input.companyId, input.userId)
      ).find((item) => item.id === input.connectionId);
      if (!account) throw notFound("AI connection not found");
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "user",
        actorId: input.userId,
        action: "ai_connection.quota_recovery_acknowledged",
        entityType: "tool_connection",
        entityId: input.connectionId,
        details: { reason, source: "owner_confirmation" },
      });
      return {
        connectionId: input.connectionId,
        acknowledgedAt: new Date().toISOString(),
      };
    },
  };
}
