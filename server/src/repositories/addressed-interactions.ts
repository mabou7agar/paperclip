import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { issues, issueThreadInteractions, type Db } from "@paperclipai/db";

export function findAddressedInteraction(db: Db, input: {
  companyId: string; issueId: string; agentId: string; interactionId: string;
  excludeTaskOwnerAndCreator?: boolean;
}) {
  return db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.id, input.interactionId),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
    input.excludeTaskOwnerAndCreator ? or(isNull(issueThreadInteractions.createdByAgentId),
      ne(issueThreadInteractions.createdByAgentId, input.agentId)) : undefined,
    input.excludeTaskOwnerAndCreator ? sql`exists (select 1 from ${issues}
      where ${issues.id} = ${input.issueId} and ${issues.companyId} = ${input.companyId}
      and (${issues.assigneeAgentId} is null or ${issues.assigneeAgentId} <> ${input.agentId}))` : undefined,
  )).limit(1).then((rows) => rows[0] ?? null);
}
