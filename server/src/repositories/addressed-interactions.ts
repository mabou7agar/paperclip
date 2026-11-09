import { and, eq } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";

export function findAddressedInteraction(db: Db, input: {
  companyId: string; issueId: string; agentId: string; interactionId: string;
}) {
  return db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.id, input.interactionId),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
  )).limit(1).then((rows) => rows[0] ?? null);
}
