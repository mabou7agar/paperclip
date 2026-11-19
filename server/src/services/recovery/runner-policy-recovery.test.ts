import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, plugins, pluginState, runnerRecoveryPolicies,
  runnerRecoveryCompanySettings, runnerRecoveryResults } from "@paperclipai/db";
import { getRecoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres-fixture.js";
import { runnerEnvelopeDomain, runnerRecoverySourceCommentId } from "./runner-policy-contract.js";
import { runnerPolicyRecovery } from "./runner-policy-recovery.js";
const support = await getRecoveryPostgresSupport();
(support.supported ? describe : describe.skip)("runner recovery durable intent draft", () => {
  let db: ReturnType<typeof createDb>, cleanup: () => Promise<void>;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  beforeAll(async () => { const f = await startRecoveryPostgres("runner-policy-"); db = createDb(f.connectionString); cleanup = f.cleanup; }, 60_000);
  afterAll(async () => { await cleanup?.(); });
  const signed = (value: unknown) => { const bytes = Buffer.from(JSON.stringify(value)); return { payload: bytes.toString("base64"),
    signature: sign(null, Buffer.concat([Buffer.from(runnerEnvelopeDomain), bytes]), privateKey).toString("base64") }; };
  async function fixture(options: { enabled?: boolean; newEvidence?: boolean; status?: string; cleanupComplete?: boolean; review?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), pluginId = randomUUID(), jobId = randomUUID(), projectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery fixture", issuePrefix: "R" + companyId.slice(0, 7) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process", status: "idle" });
    // No project FK is needed for the verifier fixture; create an actual scoped project.
    const { projects } = await import("@paperclipai/db");
    await db.insert(projects).values({ id: projectId, companyId, name: "Recovery project" });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Original plan", assigneeAgentId: agentId,
      status: options.review ? "in_review" : "in_progress" });
    await db.insert(plugins).values({ id: pluginId, pluginKey: "runner-fixture-" + pluginId, packageName: "runner-fixture", version: "1", packagePath: "/tmp/fixture", manifestJson: { id: "runner-fixture", apiVersion: 1, version: "1.0.0", displayName: "Runner fixture", description: "Isolated recovery test", author: "Test", categories: [], capabilities: [], entrypoints: { worker: "worker.mjs" } } });
    const payload = { policyKey: "owner-recovery", sourceCommentId: runnerRecoverySourceCommentId,
      scope: { issueTreeRootId: issueId, profiles: ["reviewed"] }, statuses: ["failed"], allowedActions: ["route_recovery_wake"] };
    await db.insert(runnerRecoveryPolicies).values({ companyId, policyKey: "owner-recovery", revision: "a".repeat(64), sourceCommentId: runnerRecoverySourceCommentId,
      sourceAuthorUserId: "owner", sourceBodySha256: "b".repeat(64), rootIssueId: issueId, payload, registeredBy: "user:board", activatedBy: "user:board", activatedAt: new Date() });
    await db.insert(runnerRecoveryCompanySettings).values({ companyId, runnerPolicyRecovery: { enabled: options.enabled !== false }, updatedBy: "user:board" });
    const common = { schema: "paperclip.runner-envelope.v1", pluginKey: "paperclip.ubuntu-runner-results", pluginId, companyId, jobId, issueId, projectId, agentId, requestDigest: "c".repeat(64) };
    const data = { jobId, companyId, issueId, projectId, agentId, profile: "reviewed", status: options.status ?? "failed", receiptSha256: "d".repeat(64),
      fingerprint: "e".repeat(64), newEvidence: options.newEvidence ?? true, result: { cleanupComplete: options.cleanupComplete ?? true } };
    const envelope = signed({ ...common, kind: "result", sequence: 1, data });
    await db.insert(pluginState).values([ { pluginId, scopeKind: "issue", scopeId: issueId, namespace: "runner-admissions", stateKey: jobId,
      valueJson: signed({ ...common, kind: "admission", sequence: 0, data: { jobId, state: "queued" } }) },
      { pluginId, scopeKind: "issue", scopeId: issueId, namespace: "runner-results", stateKey: jobId, valueJson: envelope } ]);
    const wake = vi.fn(async () => ({ wakeupRequestId: randomUUID() })), guard = vi.fn(async () => true);
    const service = runnerPolicyRecovery(db, { trust: async () => ({ pluginId, publicKey }), wake, guard });
    return { companyId, issueId, pluginId, jobId, wake, service, input: { envelope, jobId, receiptSha256: data.receiptSha256 } };
  }
  it("T16 does not create an intent or wake when disabled", async () => {
    const f = await fixture({ enabled: false });
    expect(await f.service.routeRunnerResult(f, f.input)).toEqual({ enabled: false });
    expect(f.wake).not.toHaveBeenCalled();
    expect(await db.select().from(runnerRecoveryResults).where(eq(runnerRecoveryResults.companyId, f.companyId))).toHaveLength(0);
  });
  it.each([{ newEvidence: false, state: "no_new_evidence" }, { status: "cancelled", state: "not_terminal" },
    { cleanupComplete: false, state: "not_terminal" }, { review: true, state: "deferred" }])("retains an ineligible result without wake: %j", async options => {
    const f = await fixture(options);
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ enabled: true, state: options.state });
    expect(f.wake).not.toHaveBeenCalled();
    const rows = await db.select().from(runnerRecoveryResults).where(and(eq(runnerRecoveryResults.companyId, f.companyId), eq(runnerRecoveryResults.issueId, f.issueId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].envelopeBytes).toBe(JSON.stringify(f.input.envelope));
  });
});
