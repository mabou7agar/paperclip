import { and, desc, eq, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, statusDecisions, type Db } from "@paperclipai/db";
type Task = typeof issues.$inferSelect;
type Wake = typeof agentWakeupRequests.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type Comment = typeof issueComments.$inferSelect;
import type { CompletionReceipt } from "../services/task-completion-receipts.js";

export async function task(db: Db, companyId: string, id: string): Promise<Task | undefined> {
  return (await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, id)))).at(0);
}
export async function lockTask(db: Db, companyId: string, id: string): Promise<Task | undefined> {
  return (await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, id))).for("update")).at(0);
}
export async function byKey(db: Db, companyId: string, key: string): Promise<Wake | undefined> {
  return (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, key),
    eq(agentWakeupRequests.requestedByActorType, "system"), eq(agentWakeupRequests.requestedByActorId, "native-status-committer")))).at(0);
}
export async function statusSource(db: Db, task: Task): Promise<{ runId: string } | undefined> {
  return task.lastStatusDecisionId ? (await db.select({ runId: statusDecisions.runId }).from(statusDecisions)
    .where(and(eq(statusDecisions.companyId, task.companyId), eq(statusDecisions.issueId, task.id), eq(statusDecisions.id, task.lastStatusDecisionId)))).at(0) : undefined;
}
export async function latestWorkerRun(db: Db, task: Task): Promise<{ runId: string } | undefined> {
  if (!task.assigneeAgentId) return undefined;
  return (await db.select({ runId: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, task.companyId), eq(heartbeatRuns.agentId, task.assigneeAgentId),
    or(eq(heartbeatRuns.nativeIssueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`),
  )).orderBy(desc(heartbeatRuns.createdAt)).limit(1)).at(0);
}
export async function insert(db: Db, row: typeof agentWakeupRequests.$inferInsert): Promise<Wake | undefined> {
  return (await db.insert(agentWakeupRequests).values(row).returning()).at(0);
}
export async function receipt(db: Db, companyId: string, agentId: string, id: string): Promise<Wake | undefined> {
  return (await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.id, id)))).at(0);
}
export async function run(db: Db, id: string): Promise<Run | undefined> {
  return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id))).at(0);
}
export async function completionAcknowledgement(db: Db, receipt: CompletionReceipt): Promise<Comment | null> {
  if (!receipt.acknowledgementCommentId) return null;
  return (await db.select().from(issueComments).where(and(eq(issueComments.id, receipt.acknowledgementCommentId), eq(issueComments.companyId, receipt.companyId),
    eq(issueComments.issueId, receipt.issueId), eq(issueComments.authorAgentId, receipt.agentId)))).at(0) ?? null;
}

export async function acknowledgeCompletionReceipt(db: Db, receipt: CompletionReceipt, commentId: string): Promise<void> {
  await db.update(agentWakeupRequests).set({ payload: sql`${agentWakeupRequests.payload} || ${JSON.stringify({ completionAcknowledgementCommentId: commentId })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(agentWakeupRequests.id, receipt.wakeId), eq(agentWakeupRequests.companyId, receipt.companyId)));
}
