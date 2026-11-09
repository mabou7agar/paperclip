import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, closeRegisteredClients, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { providerQuotaRepository } from "../repositories/provider-quota.js";
import { repairQuotaResetProvenance } from "../services/quota-reset-provenance-repair.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("quota reset provenance repair", () => {
  let connection: string | null = null;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  afterAll(async () => { if (connection) await closeRegisteredClients(connection); await fixture?.cleanup(); });
  it("uses the first trusted audit, preserves provider/usage evidence, and isolates companies", async () => {
    fixture = await startEmbeddedPostgresTestDatabase("quota-origin-"); connection = fixture.connectionString;
    const db = createDb(connection), companyId = randomUUID(), otherId = randomUUID();
    const agentId = randomUUID(), otherAgent = randomUUID();
    await db.insert(companies).values([{ id: companyId, name: "Origin", issuePrefix: "QORA" }, { id: otherId, name: "Other", issuePrefix: "QORB" }]);
    await db.insert(agents).values([{ id: agentId, companyId, name: "Reviewer" }, { id: otherAgent, companyId: otherId, name: "Other" }]);
    const original = { recoveryClassification: "provider_quota", retryNotBefore: "2026-11-08T02:00:00Z", usage: { inputTokens: 42 }, terminalSessionFailure: { category: "limit", title: "weekly quota" } };
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(heartbeatRuns).values(ids.map((id,index) => ({ id, companyId: index === 2 ? otherId : companyId,
      agentId: index === 2 ? otherAgent : agentId, status: "failed", errorCode: "provider_quota", resultJson: original })));
    for (let index=0; index<ids.length; index++) for (let event=0; event<2; event++) await db.insert(activityLog).values({
      companyId: index === 2 ? otherId : companyId, runId: ids[index], actorType: "system", actorId: "recovery",
      action: "issue.monitor_scheduled", entityType: "issue", entityId: "fixture",
      details: { source: "recovery.provider_quota", parsedResetTime: event === 0 ? index === 1 : true },
      createdAt: new Date(`2026-11-08T01:0${event}:00Z`),
    });
    expect(await providerQuotaRepository(db).unlabelledRecoveryResets(companyId)).toEqual(expect.arrayContaining([expect.objectContaining({runId:ids[0],parsedResetTime:false}),expect.objectContaining({runId:ids[1],parsedResetTime:true})]));
    expect(await repairQuotaResetProvenance(db,{ companyId,userId:"operator" })).toEqual({ repaired:2,provider:1,backoff:1,skipped:0 });
    for (const [index,id] of ids.entries()) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,id));
      const { providerQuotaResetSource,...rest } = row.resultJson!;
      expect(rest).toEqual(original);
      expect(providerQuotaResetSource).toBe(index === 0 ? "backoff" : index === 1 ? "provider" : undefined);
    }
    expect((await repairQuotaResetProvenance(db,{ companyId,userId:"operator" })).repaired).toBe(0);
    const audit = await db.select().from(activityLog).where(and(eq(activityLog.companyId,companyId),eq(activityLog.action,"heartbeat.quota_reset_provenance_repaired")));
    expect(audit).toHaveLength(2);
  }, 240_000);
});
