import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

const { resolveVersion } = vi.hoisted(() => ({ resolveVersion: vi.fn(async ({ material }) => material.value as string) }));
vi.mock("../secrets/provider-registry.js", () => ({ getSecretProvider: () => ({ resolveVersion }) }));
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("indexed issue secret registry lookup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("issue-redaction-index-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  it("retains both legacy/current registries, deduplicates dual identity, and isolates company/task scope", async () => {
    const companyId = randomUUID(), foreignCompanyId = randomUUID(), agentId = randomUUID(), foreignAgentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values([{ id: companyId, name: "Owner", issuePrefix: `R${companyId.slice(0, 6)}` }, { id: foreignCompanyId, name: "Other", issuePrefix: `R${foreignCompanyId.slice(0, 6)}` }]);
    await db.insert(agents).values([{ id: agentId, companyId, name: "Owner agent", role: "engineer", adapterType: "claude_local" },
      { id: foreignAgentId, companyId: foreignCompanyId, name: "Other agent", role: "engineer", adapterType: "claude_local" }]);
    const contexts = [
      { issueId }, { paperclipIssue: { id: issueId } }, { issueId, paperclipIssue: { id: issueId } },
      { issueId: randomUUID() }, { issueId },
    ];
    const values = contexts.map((_, i) => `fixture-private-value-${i}`);
    await db.insert(heartbeatRuns).values(contexts.map((identity, i) => ({
      companyId: i === 4 ? foreignCompanyId : companyId, agentId: i === 4 ? foreignAgentId : agentId,
      status: "succeeded", contextSnapshot: { ...identity, prompt: "large fixture ".repeat(20_000),
        paperclipSecretRedactions: [{ fingerprintSha256: `fixture-${i}`, material: { value: values[i] } }] },
    })));
    const registry = createRunSecretRedactionRegistry(db);
    expect(await registry.redactForIssue(companyId, issueId, values)).toEqual([
      REDACTED_EVENT_VALUE, REDACTED_EVENT_VALUE, REDACTED_EVENT_VALUE, values[3], values[4],
    ]);
    expect(resolveVersion).toHaveBeenCalledTimes(3);
    expect(await registry.redactForIssue(companyId, randomUUID(), values)).toEqual(values);
  });
});
