import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, runnerRecoveryResults, type Db } from "@paperclipai/db";
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** Only references leave private signed storage. Unknown validity never grants pass/rerun authority. */
export function projectRunnerCheckReferences(value: unknown, currentCandidate: string | null) {
  const result = object(value);
  const checks = [...(Array.isArray(result.checks) ? result.checks : []), ...(Array.isArray(result.phases) ? result.phases : [])];
  return checks.flatMap(raw => {
    const check = object(raw);
    if (typeof check.checkId !== "string" && typeof check.phase !== "string") return [];
    const ref: Record<string, unknown> = {};
    for (const key of ["documentId", "revisionId", "jobId", "receiptSha256", "candidateSha", "profile", "checkId", "phase", "status", "locale", "device", "scope"])
      if (typeof check[key] === "string" && (check[key] as string).length <= 256) ref[key] = check[key];
    const validity = typeof check.candidateSha !== "string" || !currentCandidate ? "unknown"
      : check.candidateSha === currentCandidate ? "current_candidate" : "stale_candidate";
    return [{ ...ref, validity, passCredit: validity === "current_candidate" && check.status === "passed", rerunAuthority: false }];
  });
}
export function runnerSessionReceipt(before: string | null, after: string | null) {
  return { before, after, outcome: !after ? "pending" : !before ? "new" : before === after ? "reused" : "reset" };
}
export async function runnerRecoveryOutcomes(db: Db, companyId: string, issueId: string, agentId: string) {
  const [issue] = await db.select({ state: issues.executionState }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  const candidate = object(issue?.state?.reviewRequest).candidateSha;
  const rows = await db.select({ result: runnerRecoveryResults, run: heartbeatRuns }).from(runnerRecoveryResults)
    .leftJoin(agentWakeupRequests, and(eq(agentWakeupRequests.id, runnerRecoveryResults.wakeupRequestId), eq(agentWakeupRequests.companyId, companyId)))
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.id, agentWakeupRequests.runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
    .where(and(eq(runnerRecoveryResults.companyId, companyId), eq(runnerRecoveryResults.issueId, issueId),
      eq(runnerRecoveryResults.targetAgentId, agentId), inArray(runnerRecoveryResults.state, ["routing", "routed"])));
  return Promise.all(rows.map(async ({ result: row, run }) => {
    const envelope = JSON.parse(row.envelopeBytes), payload = object(JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"))), data = object(payload.data);
    const superseded = await db.select({ id: runnerRecoveryResults.id, jobId: runnerRecoveryResults.jobId, receiptSha256: runnerRecoveryResults.receiptSha256 })
      .from(runnerRecoveryResults).where(and(eq(runnerRecoveryResults.companyId, companyId), eq(runnerRecoveryResults.issueId, issueId), eq(runnerRecoveryResults.supersededBy, row.id)));
    return { recoveryActionId: row.recoveryActionId!, decision: { schema: "paperclip.runner-policy-recovery.v1", resultId: row.id,
      policyId: row.policyId, policyRevision: row.policyRevision, jobId: row.jobId, receiptSha256: row.receiptSha256,
      envelopeSha256: row.envelopeSha256, planRevisionId: row.fence?.planRevisionId, superseded,
      evidence: projectRunnerCheckReferences(data.result, typeof candidate === "string" ? candidate : null),
      session: runnerSessionReceipt(run?.sessionIdBefore ?? null, run?.sessionIdAfter ?? null) } };
  }));
}
