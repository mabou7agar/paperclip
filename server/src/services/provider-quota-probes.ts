import { connectionCapacityRecoveryService } from "./connection-capacity-recovery.js";
import { connectionUsageCapsService } from "./connection-usage-caps.js";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "@paperclipai/db";
import { aiConnectionMetadataSchema } from "@paperclipai/shared";
import { providerQuotaProbeRepository } from "../repositories/provider-quota-probes.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { aiConnectionService } from "./ai-connections.js";
import {
  messagesQuotaDestination,
  probeMessagesQuota,
} from "./api-quota-probe.js";
import { phaseRoutingService } from "./phase-routing.js";
import { logActivity } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";

type RetryNow = ReturnType<typeof heartbeatService>["retryScheduledRetryNow"];
/** Account health is independent of agent wakes. Only a verified recovery delivers work. */
export function providerQuotaProbeService(
  db: Db,
  retryNow: RetryNow,
  request: typeof fetch = fetch,
  clock: () => Date = () => new Date(),
) {
  const repository = providerQuotaProbeRepository(db),
    quota = providerQuotaRepository(db),
    accounts = aiConnectionService(db);
  return {
    async sweep(now = clock(), canContinue: () => boolean = () => true) {
      let checked = 0,
        recovered = 0;
      if (!canContinue()) return { checked, recovered };
      for (const company of await repository.policies()) {
        if (!canContinue()) break;
        for (const connection of await repository.connections(
          company.companyId,
        )) {
          if (checked >= 4 || !canContinue()) break;
          const seconds =
            company.policy.apiQuotaRecheckOverrides?.[connection.id] ??
            company.policy.apiQuotaRecheckSeconds ??
            0;
          if (!Number.isInteger(seconds) || seconds < 300 || seconds > 86400)
            continue;
          const meta = aiConnectionMetadataSchema.safeParse(
            connection.metadata,
          );
          if (!meta.success || !messagesQuotaDestination(meta.data)) continue;
          const evidence = await quota.latestEvidence(
            company.companyId,
            connection.id,
            now,
            connection.grantId,
          );
          if (
            !evidence?.responsibleUserId ||
            !evidence.grantId ||
            !evidence.model ||
            evidence.model === "unknown"
          )
            continue;
          const caps=company.policy.connectionUsageCaps?.[connection.id];
          if(caps && (await connectionUsageCapsService(db).check(company.companyId,connection.id,now,caps)).blocked)continue;
          try {
            const summary = (
              await accounts.list(company.companyId, evidence.responsibleUserId)
            ).find(
              (a) =>
                a.id === connection.id &&
                a.grantId === evidence.grantId &&
                a.status === "connected",
            );
            if (!summary) continue;
            const selection = {
              companyId: company.companyId,
              userId: evidence.responsibleUserId,
              agentId: evidence.agentId,
              adapterType: "claude_local",
              model: evidence.model,
              binding: {
                mode:
                  summary.ownership === "shared"
                    ? ("shared" as const)
                    : ("delegated" as const),
                provider: meta.data.provider,
                method: meta.data.method,
                connectionId: connection.id,
                grantId: evidence.grantId,
              },
            };
            const row = await accounts.select(selection);
            const selectedMeta = aiConnectionMetadataSchema.safeParse(
              row.connection.config.ai,
            );
            const destination = selectedMeta.success
              ? messagesQuotaDestination(selectedMeta.data)
              : null;
            if (!destination || evidence.model.length > 200) continue;
            if (!canContinue()) break;
            const claim = await repository.claim({
              companyId: company.companyId,
              connectionId: connection.id,
              grantId: evidence.grantId,
              sourceRunId: evidence.id,
              model: evidence.model,
              intervalSeconds: seconds,
              now,
            });
            if (!claim) continue;
            let credential: string;
            try {
              credential = await accounts.credential(row);
            } catch {
              await repository.complete(
                claim.id,
                {
                  outcome: "configuration",
                  usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    cachedInputTokens: 0,
                    cacheWriteTokens: 0,
                  },
                  retryAfterSeconds: null,
                },
                clock(),
              );
              continue;
            }
            if (!canContinue()) {
              await repository.complete(claim.id, { outcome: "unavailable", usage: {
                inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
              }, retryAfterSeconds: null }, clock());
              break;
            }
            checked++;
            const result = await probeMessagesQuota(
              {
                ...destination,
                credential,
                model: evidence.model,
              },
              request,
            );
            // Rotation, revocation, sharing or installation changes cannot reuse
            // the response from a credential that is no longer authoritative.
            let unchanged = false;
            try {
              const current = await accounts.select(selection);
              unchanged =
                (await accounts.credential(current)) === credential &&
                isDeepStrictEqual(
                  current.connection.config.ai,
                  row.connection.config.ai,
                ) &&
                current.connection.updatedAt.getTime() ===
                  row.connection.updatedAt.getTime() &&
                current.grant.updatedAt.getTime() ===
                  row.grant.updatedAt.getTime() &&
                isDeepStrictEqual(
                  current.grant.credentialSecretRefs,
                  row.grant.credentialSecretRefs,
                );
            } catch {
              /* Remain held. */
            }
            const finished = await repository.complete(
              claim.id,
              unchanged ? result : { ...result, outcome: "unavailable" },
              clock(),
            );
            if (finished?.outcome === "available") {
              recovered++;
              await logActivity(db, {
                companyId: company.companyId,
                actorType: "system",
                actorId: "quota-health",
                action: "ai_connection.quota_probe_recovered",
                entityType: "tool_connection",
                entityId: connection.id,
                details: {
                  probeId: claim.id,
                  sourceRunId: evidence.id,
                  model: evidence.model,
                  usage: result.usage,
                },
              });
            }
          } catch {
            /* Credential/configuration failures never wake agents or expose provider text. */
          }
        }
      }
      for (const pending of await repository.pendingRecoveries()) {
        if (!canContinue()) break;
        const probe = await repository.claimRecovery(pending.id, clock());
        if (!probe?.recoveryClaimId) continue;
        let owned = true;
        for (const wait of await repository.waits(
          probe.companyId,
          probe.startedAt,
        )) {
          if (
            !(await repository.renewRecovery(
              probe.id,
              probe.recoveryClaimId,
              clock(),
            ))
          ) {
            owned = false;
            break;
          }
          const issueId =
            wait.issueId ??
            (typeof wait.contextSnapshot?.issueId === "string"
              ? wait.contextSnapshot.issueId
              : null);
          if (!issueId) continue;
          const context = await repository.waitContext(
            probe.companyId,
            issueId,
            wait.agentId,
          );
          if (
            !context ||
            context.issue.assigneeAgentId !== wait.agentId ||
            ["done", "cancelled"].includes(context.issue.status)
          )
            continue;
          const { issue, agent } = context;
          const route = await phaseRoutingService(db).resolve({
            companyId: probe.companyId,
            agentId: agent.id,
            userId: wait.responsibleUserId,
            adapterType: agent.adapterType,
            runtimeConfig: agent.runtimeConfig,
            agentRole: agent.role,
            workMode: issue.workMode,
            isConversation: !!issue.conversationAgentId,
            issueId,
          });
          if (
            route?.profile &&
            route.connectionId === probe.connectionId &&
            route.grantId === probe.grantId
          ) {
            if (
              !(await repository.renewRecovery(
                probe.id,
                probe.recoveryClaimId,
                clock(),
              ))
            ) {
              owned = false;
              break;
            }
            if (!canContinue()) { owned = false; break; }
            await retryNow({
              issueId,
              expectedRunId: wait.id,
              actor: { actorType: "system", actorId: "quota-health" },
              now: clock(),
            });
          }
        }
        if (owned)
          await repository.delivered(probe.id, probe.recoveryClaimId, clock());
      }
      if (canContinue()) await connectionCapacityRecoveryService(db,retryNow).reconcile(undefined, now, canContinue);
      return { checked, recovered };
    },
  };
}
