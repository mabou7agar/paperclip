import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunResults } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { nativeSha256 } from "./canonical.js";

// Ordinary CI: a new disposable database, no source reader, built worker,
// environment URL, Git checkout, heartbeat service or paid backend.
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("native-standing-fields-");
  db = createDb(temporary.connectionString);
}, 60_000);
afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
it("strips native standing before PostgreSQL persistence and replay hashing", async () => {
  const companyId=randomUUID(), agentId=randomUUID(), issueId=randomUUID(), runId=randomUUID(),
    contractId=randomUUID(), sessionId=randomUUID(), sourceInstanceId=randomUUID();
  await db.insert(companies).values({ id:companyId,name:"Synthetic native standing",issuePrefix:"NS"+companyId.slice(0,6) });
  await db.insert(agents).values({ id:agentId,companyId,name:"Never-paid",adapterType:"paperclip_runner" });
  await db.insert(issues).values({ id:issueId,companyId,title:"Synthetic standing",status:"in_progress",assigneeAgentId:agentId });
  await db.insert(completionContracts).values({ id:contractId,companyId,issueId,revision:1,
    schemaVersion:"paperclip.completion-contract.v1",policyVersion:"synthetic",risk:"standard",
    completionAuthority:"server_arbiter",incompleteCriteriaPolicy:"preserve_non_terminal",
    contractJson:{ revision:"standalone-v1",objective:"Finish",criteria:[{ id:"objective",requirement:"Complete" }] },
    canonicalSha256:contractId,createdByActorType:"system",createdByActorId:"synthetic" });
  await db.insert(heartbeatRuns).values({ id:runId,companyId,agentId,issueId,nativeIssueId:issueId,
    runtimeMode:"native",status:"running",nativeSessionId:sessionId,runnerInstanceId:sourceInstanceId,
    completionContractId:contractId,completionContractSha256:contractId });
  const binding={ companyId,issueId,runId,agentId,sessionId,completionContractId:contractId,
    completionContractSha256:contractId,sourceInstanceId,controlPlaneSourceInstanceId:"synthetic-controller" };
  const port=new PaperclipControlPlanePort(db,binding);
  const submitted={ ...CONTROL_PLANE_CONFORMANCE_RESULT,sourceCurrentEvidenceSatisfied:true,sourceCitationResults:[{ standing:"forged" }] };
  const value={ result:submitted,terminal:CONTROL_PLANE_CONFORMANCE_TERMINAL,callerResultId:runId+":standing" };
  await port.completeRun(value);
  await port.completeRun({ ...value,result:{ ...submitted,sourceCurrentEvidenceSatisfied:false,sourceCitationResults:[] } });
  const accepted=await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId,runId));
  expect(accepted).toHaveLength(1);
  const stored=accepted[0]!.resultJson as { result:Record<string,unknown> };
  expect(stored.result).not.toHaveProperty("sourceCurrentEvidenceSatisfied");
  expect(stored.result).not.toHaveProperty("sourceCitationResults");
  expect(accepted[0]!.canonicalSha256).toBe(nativeSha256({ binding,result:stored.result,terminal:value.terminal,turnId:null }));
  expect(submitted.sourceCurrentEvidenceSatisfied).toBe(true);
  expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,companyId))).toHaveLength(0);
});
