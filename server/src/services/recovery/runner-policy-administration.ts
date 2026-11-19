import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { agents, issueComments, issues, runnerRecoveryPolicies, runnerRecoveryCompanySettings, activityLog, type Db } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { forbidden, conflict, notFound } from "../../errors.js";
import { runnerRecoveryPolicySchema } from "./runner-policy-contract.js";

type Actor = { type: "board"; userId: string } | { type: "agent"; agentId: string };
/** This writer is never passed to the router or plugin host. */
export function runnerPolicyAdministration(db: Db) {
  async function authority(companyId: string, actor: Actor) {
    if (actor.type === "board" && actor.userId) return `user:${actor.userId}`;
    if (actor.type === "agent") {
      const [agent] = await db.select().from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)));
      if (agent?.role === "cto" && !["terminated", "pending_approval", "paused"].includes(agent.status)) return `agent:${agent.id}`;
    }
    throw forbidden("Only CTO or board can register or activate runner recovery policies");
  }
  return {
    async register(companyId: string, actor: Actor, input: unknown) {
      const actorId = await authority(companyId, actor), payload = runnerRecoveryPolicySchema.parse(input);
      return db.transaction(async tx => {
        const [root] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, payload.scope.issueTreeRootId), eq(issues.companyId, companyId)));
        const [source] = await tx.select().from(issueComments).where(and(eq(issueComments.id, payload.sourceCommentId), eq(issueComments.companyId, companyId), isNull(issueComments.deletedAt)));
        if (!root || !source || source.authorType !== "user" || !source.authorUserId || source.createdByRunId) throw forbidden("Registered owner source and company scope are required");
        const sourceBodySha256 = createHash("sha256").update(source.body).digest("hex");
        const revision = createHash("sha256").update(canonicalJson({ payload, sourceAuthorUserId: source.authorUserId, sourceBodySha256 })).digest("hex");
        const [row] = await tx.insert(runnerRecoveryPolicies).values({ companyId, policyKey: payload.policyKey, revision,
          sourceCommentId: source.id, sourceAuthorUserId: source.authorUserId, sourceBodySha256, rootIssueId: root.id,
          payload, registeredBy: actorId }).onConflictDoNothing().returning();
        if (!row) throw conflict("Policy revision is already registered");
        await tx.insert(activityLog).values({ companyId, actorType: actor.type === "board" ? "user" : "agent", actorId,
          action: "runner_recovery.policy_registered", entityType: "runner_recovery_policy", entityId: row.id,
          details: { revision, sourceCommentId: source.id } });
        return row;
      });
    },
    async activate(companyId: string, actor: Actor, id: string) {
      const actorId = await authority(companyId, actor);
      return db.transaction(async tx => {
        const [row] = await tx.update(runnerRecoveryPolicies).set({ activatedBy: actorId, activatedAt: new Date() })
          .where(and(eq(runnerRecoveryPolicies.id, id), eq(runnerRecoveryPolicies.companyId, companyId),
            isNull(runnerRecoveryPolicies.activatedAt), isNull(runnerRecoveryPolicies.revokedAt))).returning();
        if (!row) throw conflict("Policy cannot be activated");
        await tx.insert(activityLog).values({ companyId, actorType: actor.type === "board" ? "user" : "agent", actorId,
          action: "runner_recovery.policy_activated", entityType: "runner_recovery_policy", entityId: id, details: { revision: row.revision } });
        // Deliberately no company flag write in this transaction.
        return row;
      });
    },
    async revoke(companyId: string, actor: Actor, id: string) {
      const [row] = await db.select().from(runnerRecoveryPolicies).where(and(eq(runnerRecoveryPolicies.id, id), eq(runnerRecoveryPolicies.companyId, companyId)));
      if (!row) throw notFound("Policy not found");
      const actorId = actor.type === "board" && actor.userId === row.sourceAuthorUserId ? `user:${actor.userId}` : await authority(companyId, actor);
      return db.transaction(async tx => {
        const [revoked] = await tx.update(runnerRecoveryPolicies).set({ revokedBy: actorId, revokedAt: new Date() })
          .where(and(eq(runnerRecoveryPolicies.id, id), eq(runnerRecoveryPolicies.companyId, companyId), isNull(runnerRecoveryPolicies.revokedAt))).returning();
        if (!revoked) return row;
        await tx.insert(activityLog).values({ companyId, actorType: actor.type === "board" ? "user" : "agent", actorId,
          action: "runner_recovery.policy_revoked", entityType: "runner_recovery_policy", entityId: id, details: { revision: row.revision } });
        return revoked;
      });
    },
    async setEnabled(companyId: string, actor: Actor, enabled: boolean) {
      const actorId = await authority(companyId, actor);
      return db.transaction(async tx => {
        await tx.insert(runnerRecoveryCompanySettings).values({ companyId, runnerPolicyRecovery: { enabled }, updatedBy: actorId })
          .onConflictDoUpdate({ target: runnerRecoveryCompanySettings.companyId,
            set: { runnerPolicyRecovery: { enabled }, updatedBy: actorId, updatedAt: new Date() } });
        await tx.insert(activityLog).values({ companyId, actorType: actor.type === "board" ? "user" : "agent", actorId,
          action: "runner_recovery.enabled_changed", entityType: "company", entityId: companyId, details: { enabled } });
      });
    },
  };
}
