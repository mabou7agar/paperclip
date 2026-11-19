import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, documents, issueDocuments, issues, issueRecoveryActions, pluginState,
  runnerRecoveryCompanySettings, runnerRecoveryPolicies, runnerRecoveryResults, type Db } from "@paperclipai/db";
import { canonicalJson } from "@paperclipai/shared/portability-hash";
import { canActorReadIssuePrivacy } from "../authorization.js";
import { runnerRecoveryPolicySchema, verifyRunnerEnvelope, type RunnerTrust } from "./runner-policy-contract.js";

type ResultRow = typeof runnerRecoveryResults.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const dataSchema = z.object({ jobId: z.string().uuid(), companyId: z.string().uuid(), issueId: z.string().uuid(),
  projectId: z.string().uuid(), agentId: z.string().uuid(), receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), profile: z.string(), newEvidence: z.boolean(),
  status: z.enum(["passed", "failed", "unknown", "cancelled"]), result: z.record(z.string(), z.unknown()) }).strict();
export interface RunnerRecoveryDependencies {
  trust(): Promise<RunnerTrust>;
  /** Native eligibility checks remain owned by their existing services. */
  guard(companyId: string, issueId: string, agentId: string): Promise<boolean>;
  /** Enqueue through the existing durable plugin-wakeup path, after intent commit. */
  wake(row: ResultRow): Promise<{ wakeupRequestId: string | null }>;
}
const resumable = ["issue_blockers_resolved", "recovery_action_resolved", "execution_policy_return", "admission_released", "policy_activated"];

export async function runnerRecoveryEnabled(db: Db | Tx, companyId: string) {
  const [settings] = await db.select().from(runnerRecoveryCompanySettings).where(eq(runnerRecoveryCompanySettings.companyId, companyId));
  return settings?.runnerPolicyRecovery.enabled === true;
}

async function planRevision(db: Db | Tx, companyId: string, issueId: string) {
  const [plan] = await db.select({ revision: documents.latestRevisionId }).from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId)).where(and(eq(issueDocuments.companyId, companyId),
      eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, "plan"), eq(documents.companyId, companyId)));
  return plan?.revision ?? null;
}
async function inSubtree(db: Db | Tx, companyId: string, issueId: string, rootId: string) {
  // Bounded by the actual tree, cycle-safe; never follows a cross-company parent.
  const seen = new Set<string>(); let next: string | null = issueId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const [row] = await db.select({ id: issues.id, parentId: issues.parentId }).from(issues)
      .where(and(eq(issues.id, next), eq(issues.companyId, companyId)));
    if (!row) return false;
    if (row.id === rootId) return true;
    next = row.parentId;
  }
  return false;
}
async function currentFence(db: Db | Tx, issue: typeof issues.$inferSelect, policyRevision: string) {
  return { statusVersion: issue.statusVersion, assigneeAgentId: issue.assigneeAgentId,
    execStateHash: hash(issue.executionState), planRevisionId: await planRevision(db, issue.companyId, issue.id), policyRevision };
}
function publicDisposition(row: ResultRow) {
  return { id: row.id, state: row.state, reason: row.reason, wakeupRequestId: row.wakeupRequestId,
    recoveryActionId: row.recoveryActionId, jobId: row.jobId, receiptSha256: row.receiptSha256 };
}

/** The only writer to routing state; it has no reference to policy administration. */
export function runnerPolicyRecovery(db: Db, deps: RunnerRecoveryDependencies) {
  async function routeRunnerResult(ctx: { companyId: string; pluginId: string }, input: { envelope: unknown; jobId: string; receiptSha256: string }) {
    // Off is observationally inert: no intent, recovery action, task mutation or wake.
    if (!await runnerRecoveryEnabled(db, ctx.companyId)) return { enabled: false as const };
    const envelopeBytes = JSON.stringify(input.envelope);
    if (Buffer.byteLength(envelopeBytes) > 192 * 1024) throw new Error("runner_envelope_invalid");
    const trust = await deps.trust();
    const value = verifyRunnerEnvelope(input.envelope, trust);
    const data = dataSchema.parse(value.data);
    if (value.kind !== "result" || value.companyId !== ctx.companyId || value.pluginId !== ctx.pluginId ||
      value.jobId !== input.jobId || data.receiptSha256 !== input.receiptSha256 ||
      ["companyId", "jobId", "issueId", "projectId", "agentId"].some(key => data[key as keyof typeof data] !== value[key])) {
      throw new Error("runner_result_scope_invalid");
    }
    // Retained host-owned state authenticates admission and latest sequence independently of the callback.
    const retained = await db.select().from(pluginState).where(and(eq(pluginState.pluginId, ctx.pluginId),
      eq(pluginState.scopeKind, "issue"), eq(pluginState.scopeId, value.issueId), eq(pluginState.stateKey, value.jobId),
      inArray(pluginState.namespace, ["runner-admissions", "runner-results"])));
    const admissionRow = retained.find(r => r.namespace === "runner-admissions");
    const latestRow = retained.find(r => r.namespace === "runner-results");
    if (!admissionRow || !latestRow) throw new Error("runner_retained_admission_required");
    const admission = verifyRunnerEnvelope(admissionRow.valueJson, trust), latest = verifyRunnerEnvelope(latestRow.valueJson, trust);
    for (const saved of [admission, latest]) if (["companyId", "pluginId", "jobId", "issueId", "projectId", "agentId", "requestDigest"].some(k => saved[k] !== value[k])) throw new Error("runner_retained_binding_invalid");
    if (admission.kind !== "admission" || latest.kind !== "result" || latest.sequence < value.sequence ||
      latest.sequence === value.sequence && hash(latest) !== hash(value)) throw new Error("runner_sequence_invalid");
    const row = await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, value.issueId), eq(issues.companyId, ctx.companyId))).for("update");
      if (!issue || issue.projectId !== value.projectId) throw new Error("runner_issue_scope_invalid");
      const [existing] = await tx.select().from(runnerRecoveryResults).where(and(eq(runnerRecoveryResults.companyId, ctx.companyId),
        eq(runnerRecoveryResults.issueId, issue.id), eq(runnerRecoveryResults.jobId, value.jobId), eq(runnerRecoveryResults.receiptSha256, input.receiptSha256))).for("update");
      if (existing && !["ingested", "deferred"].includes(existing.state)) return existing;
      const [created] = existing ? [existing] : await tx.insert(runnerRecoveryResults).values({ companyId: ctx.companyId,
        pluginId: ctx.pluginId, issueId: issue.id, jobId: value.jobId, receiptSha256: input.receiptSha256,
        resultFingerprint: data.fingerprint, sequence: value.sequence, envelopeBytes, envelopeSha256: hash(input.envelope) }).returning();
      const finish = async (state: string, reason: string, fields: Partial<typeof runnerRecoveryResults.$inferInsert> = {}) => {
        const [result] = await tx.update(runnerRecoveryResults).set({ ...fields, state, reason,
          stateVersion: created.stateVersion + 1, resumeOn: state === "deferred" ? resumable : null, updatedAt: new Date() })
          .where(and(eq(runnerRecoveryResults.id, created.id), eq(runnerRecoveryResults.stateVersion, created.stateVersion))).returning();
        if (!result) throw new Error("runner_result_state_conflict");
        return result;
      };
      if (latest.sequence > value.sequence) return finish("superseded", "newer_sequence");
      if (data.status !== "failed" || data.result.cleanupComplete !== true) return finish("not_terminal", "not_terminal");
      if (data.newEvidence !== true) return finish("no_new_evidence", "no_new_evidence");
      const policies = await tx.select().from(runnerRecoveryPolicies).where(and(eq(runnerRecoveryPolicies.companyId, ctx.companyId),
        isNotNull(runnerRecoveryPolicies.activatedAt), isNull(runnerRecoveryPolicies.revokedAt))).orderBy(desc(runnerRecoveryPolicies.activatedAt)).for("update");
      let matched: typeof runnerRecoveryPolicies.$inferSelect | undefined;
      for (const policy of policies) {
        const parsed = runnerRecoveryPolicySchema.safeParse(policy.payload);
        if (parsed.success && (!parsed.data.expiresAt || new Date(parsed.data.expiresAt) > new Date()) &&
          parsed.data.scope.profiles.includes(data.profile) && await inSubtree(tx, ctx.companyId, issue.id, policy.rootIssueId)) { matched = policy; break; }
      }
      if (!matched) return finish("deferred", "no_policy");
      const policy = runnerRecoveryPolicySchema.parse(matched.payload);
      const attribution = { policyId: matched.id, policyKey: matched.policyKey, policyRevision: matched.revision };
      const prior = await tx.select({ fingerprint: runnerRecoveryResults.resultFingerprint }).from(runnerRecoveryResults)
        .where(and(eq(runnerRecoveryResults.companyId, ctx.companyId), eq(runnerRecoveryResults.issueId, issue.id),
          eq(runnerRecoveryResults.policyKey, policy.policyKey), inArray(runnerRecoveryResults.state, ["routing", "routed"])));
      if (prior.some(r => r.fingerprint === data.fingerprint)) return finish("identical_fingerprint", "identical_fingerprint", attribution);
      if (policy.maxRecoveries !== undefined && prior.length >= policy.maxRecoveries) return finish("exhausted", "exhausted", attribution);
      if (issue.status === "in_review" || issue.executionState?.status === "pending" || issue.executionState?.reviewEscalated === true) return finish("deferred", "review_pending", attribution);
      if (["backlog", "done", "cancelled"].includes(issue.status)) return finish("not_routable", "not_routable", attribution);
      const target = issue.assigneeAgentId;
      const [agent] = target ? await tx.select().from(agents).where(and(eq(agents.id, target), eq(agents.companyId, ctx.companyId))) : [];
      if (!agent || !await canActorReadIssuePrivacy(tx, { type: "agent", agentId: agent.id, companyId: ctx.companyId }, issue)) return finish("deferred", "no_agent_responsible", attribution);
      if (!await deps.guard(ctx.companyId, issue.id, agent.id)) return finish("deferred", "guard_held", attribution);
      const [action] = await tx.insert(issueRecoveryActions).values({ companyId: ctx.companyId, sourceIssueId: issue.id,
        kind: "runner_result", cause: "runner_result_policy_recovery", fingerprint: data.fingerprint,
        ownerAgentId: agent.id, ownerType: "agent", nextAction: "Resume the accepted task within the registered recovery policy",
        evidence: { runnerRecoveryResultId: created.id, policyId: matched.id, policyRevision: matched.revision,
          jobId: value.jobId, receiptSha256: input.receiptSha256 }, status: "active" }).onConflictDoNothing().returning();
      if (!action) return finish("deferred", "active_recovery_present", attribution);
      return finish("routing", "intent_committed", { ...attribution, targetAgentId: agent.id,
        fence: await currentFence(tx, issue, matched.revision), recoveryActionId: action.id,
        wakeIdempotencyKey: `runner-recovery:${ctx.companyId}:${issue.id}:${value.jobId}:${input.receiptSha256}` });
    });
    if (row.state === "routing") {
      const wake = await deps.wake(row);
      await db.update(runnerRecoveryResults).set({ wakeupRequestId: wake.wakeupRequestId, updatedAt: new Date() })
        .where(and(eq(runnerRecoveryResults.id, row.id), eq(runnerRecoveryResults.state, "routing")));
      return { enabled: true as const, ...publicDisposition({ ...row, wakeupRequestId: wake.wakeupRequestId }) };
    }
    return { enabled: true as const, ...publicDisposition(row) };
  }
  async function reevaluateDeferred(companyId: string, issueId: string, event: string) {
    if (!resumable.includes(event) || !await runnerRecoveryEnabled(db, companyId)) return;
    const rows = await db.select().from(runnerRecoveryResults).where(and(eq(runnerRecoveryResults.companyId, companyId),
      eq(runnerRecoveryResults.issueId, issueId), eq(runnerRecoveryResults.state, "deferred"))).orderBy(desc(runnerRecoveryResults.createdAt), desc(runnerRecoveryResults.sequence));
    for (const row of rows) {
      const outcome = await routeRunnerResult({ companyId, pluginId: row.pluginId }, { envelope: JSON.parse(row.envelopeBytes), jobId: row.jobId, receiptSha256: row.receiptSha256 });
      if ("state" in outcome && ["routing", "routed"].includes(outcome.state)) break;
    }
  }
  return { routeRunnerResult, reevaluateDeferred };
}
