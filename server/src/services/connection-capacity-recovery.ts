import type { Db } from "@paperclipai/db";
import { aiConnectionBindingSchema } from "@paperclipai/shared";
import { providerQuotaProbeRepository } from "../repositories/provider-quota-probes.js";
import { phaseRoutingService } from "./phase-routing.js";
import { connectionUsageCapsService } from "./connection-usage-caps.js";
import { aiConnectionService } from "./ai-connections.js";
import type { heartbeatService } from "./heartbeat.js";

/** Re-evaluate saved capacity waits only. Unchanged limits never wake an agent. */
export function connectionCapacityRecoveryService(
  db: Db,
  retry: ReturnType<typeof heartbeatService>["retryScheduledRetryNow"],
) {
  const repository = providerQuotaProbeRepository(db);
  return {
    async reconcile(companyId?: string, now = new Date(), canContinue: () => boolean = () => true) {
      let promoted = 0;
      if (!canContinue()) return { promoted };
      for (const wait of await repository.capacityWaits(companyId)) {
        if (!canContinue()) break;
        const issueId =
          wait.issueId ??
          (typeof wait.contextSnapshot?.issueId === "string"
            ? wait.contextSnapshot.issueId
            : null);
        if (!issueId) continue;
        const current = await repository.waitContext(
          wait.companyId,
          issueId,
          wait.agentId,
        );
        if (
          !current ||
          current.issue.assigneeAgentId !== wait.agentId ||
          ["done", "cancelled"].includes(current.issue.status)
        )
          continue;
        const { agent, issue } = current;
        const route = await phaseRoutingService(db).resolve({
          companyId: wait.companyId,
          agentId: agent.id,
          userId: wait.responsibleUserId,
          adapterType: agent.adapterType,
          runtimeConfig: agent.runtimeConfig,
          agentRole: agent.role,
          workMode: issue.workMode,
          isConversation: !!issue.conversationAgentId,
          issueId,
          now,
        });
        if (route && !route.profile) continue;
        if (!route) {
          const binding = aiConnectionBindingSchema.safeParse(
            agent.runtimeConfig?.aiConnection,
          );
          if (!binding.success) continue;
          try {
            const account = await aiConnectionService(db).select({
              companyId: wait.companyId,
              agentId: agent.id,
              userId: wait.responsibleUserId,
              adapterType: agent.adapterType,
              model: agent.adapterConfig?.model,
              binding: binding.data,
            });
            if (
              (
                await connectionUsageCapsService(db).check(
                  wait.companyId,
                  account.connection.id,
                  now,
                )
              ).blocked
            )
              continue;
          } catch {
            continue;
          }
        }
        if (!canContinue()) break;
        const result = await retry({
          issueId,
          expectedRunId: wait.id,
          actor: { actorType: "system", actorId: "connection-capacity" },
          now,
        });
        if (result.outcome === "promoted") promoted++;
      }
      return { promoted };
    },
  };
}
