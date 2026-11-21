import { dispatchRunnerRecoveryWake } from "./runner-policy-runtime.js";
import { mergeCoalescedContextSnapshot } from "../heartbeat/run-preparation.js";
import { createWakeQueue } from "../../modules/wake-queue/index.js";
import { shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "../heartbeat/queue.js";
import { createHeartbeatQueue } from "../heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
const native = vi.hoisted(() => ({ wakeup: vi.fn(), trust: vi.fn() }));
vi.mock("../heartbeat.js", () => ({ heartbeatService: () => native }));
vi.mock("./runner-policy-trust.js", () => ({ loadRunnerPolicyTrust: () => native.trust() }));
import { runnerPolicyAdministration } from "./runner-policy-administration.js";
import { projectRunnerCheckReferences, runnerSessionReceipt } from "./runner-policy-continuation.js";
import { claimRunnerPolicyRecovery } from "./runner-policy-claim.js";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, plugins, pluginState, runnerRecoveryPolicies,
  runnerRecoveryCompanySettings, runnerRecoveryResults, issueRecoveryActions, heartbeatRuns, agentWakeupRequests } from "@paperclipai/db";
import { getRecoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres-fixture.js";
import { runnerEnvelopeDomain, runnerRecoverySourceCommentId } from "./runner-policy-contract.js";
import { runnerPolicyRecovery } from "./runner-policy-recovery.js";
const support = await getRecoveryPostgresSupport();
(support.supported ? describe : describe.skip)("runner recovery remaining contract cases", () => {
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
    const wake = vi.fn(async (_row: import("./runner-policy-recovery.js").ResultRow): Promise<{ wakeupRequestId: string | null }> => ({ wakeupRequestId: randomUUID() })), guard = vi.fn(async () => true);
    const trust = vi.fn(async () => ({ pluginId, publicKey }));
    const service = runnerPolicyRecovery(db, { trust, wake, guard });
    return { companyId, issueId, pluginId, jobId, agentId, trust, guard, wake, service, input: { envelope, jobId, receiptSha256: data.receiptSha256 } };
  }

  async function row(f: Awaited<ReturnType<typeof fixture>>) { return (await db.select().from(runnerRecoveryResults).where(eq(runnerRecoveryResults.companyId, f.companyId)))[0]; }
  async function nativeRun(f: Awaited<ReturnType<typeof fixture>>) {
    const r = await row(f), id = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: r.wakeupRequestId!, companyId: f.companyId, agentId: f.agentId, source: "assignment", reason: "runner_policy_recovery", idempotencyKey: r.wakeIdempotencyKey });
    const [run] = await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment", status: "queued", wakeupRequestId: r.wakeupRequestId,
      contextSnapshot: { projectId: JSON.parse(Buffer.from(f.input.envelope.payload, "base64").toString("utf8")).projectId, issueId: f.issueId, runnerRecoveryResultId: r.id, wakeReason: "runner_policy_recovery" } }).returning();
    return run;
  }
  async function second(f: Awaited<ReturnType<typeof fixture>>, fingerprint = "f".repeat(64)) {
    const value = JSON.parse(Buffer.from(f.input.envelope.payload, "base64").toString("utf8"));
    value.jobId = randomUUID(); value.data = { ...value.data, jobId: value.jobId, receiptSha256: "a".repeat(64), fingerprint };
    const envelope = signed(value);
    await db.insert(pluginState).values([{ pluginId: f.pluginId, scopeKind: "issue", scopeId: f.issueId, namespace: "runner-results", stateKey: value.jobId, valueJson: envelope },
      { pluginId: f.pluginId, scopeKind: "issue", scopeId: f.issueId, namespace: "runner-admissions", stateKey: value.jobId, valueJson: signed({ ...value, kind: "admission", sequence: 0 }) }]);
    return { envelope, jobId: value.jobId, receiptSha256: value.data.receiptSha256 };
  }
  it("T1/T3/T12/T20 preserves one intent through concurrent deliveries and ACK replay", async () => {
    const f = await fixture();
    f.wake.mockImplementation(async r => ({ wakeupRequestId: r.wakeupRequestId! }));
    const outcomes = await Promise.all([f.service.routeRunnerResult(f, f.input), f.service.routeRunnerResult(f, f.input)]);
    if (!outcomes[0].enabled || !outcomes[1].enabled) throw new Error("Expected enabled recovery outcomes");
    expect(outcomes[0].id).toBe(outcomes[1].id);
    const run = await nativeRun(f);
    expect(await db.transaction(tx => claimRunnerPolicyRecovery(tx, run, f.trust))).toBe(true);
    expect((await row(f)).state).toBe("routed");
    const count = f.wake.mock.calls.length;
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "routed", id: outcomes[0].id });
    expect(f.wake).toHaveBeenCalledTimes(count);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(1);
  });
  it("T20 repairs a committed intent after a pre-enqueue crash with the same receipt identity", async () => {
    const f = await fixture(); f.wake.mockRejectedValueOnce(new Error("injected pre-enqueue crash"));
    await expect(f.service.routeRunnerResult(f, f.input)).rejects.toThrow("injected");
    const before = await row(f);
    await f.service.routeRunnerResult(f, f.input);
    const after = await row(f);
    expect(after.id).toBe(before.id); expect(after.wakeIdempotencyKey).toBe(before.wakeIdempotencyKey);
    expect(f.wake.mock.calls[0][0].wakeupRequestId).toBe(f.wake.mock.calls[1][0].wakeupRequestId);
  });
  it("T5 suppresses a different job with an identical lineage fingerprint", async () => {
    const f = await fixture(); await f.service.routeRunnerResult(f, f.input);
    const next = await second(f, "e".repeat(64));
    expect(await f.service.routeRunnerResult(f, next)).toMatchObject({ state: "identical_fingerprint" });
    expect(f.wake).toHaveBeenCalledTimes(1);
  });
  it("T11 leaves an unrelated active recovery untouched", async () => {
    const f = await fixture();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "missing_disposition", cause: "unrelated", fingerprint: "unrelated", nextAction: "Unchanged", ownerAgentId: f.agentId }).returning();
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "deferred", reason: "active_recovery_present" });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].cause).toBe("unrelated");
    expect(f.wake).not.toHaveBeenCalled();
  });
  it("T13/T23 serializes two concurrent last-slot reservations", async () => {
    const f = await fixture(), next = await second(f);
    const [policy] = await db.select().from(runnerRecoveryPolicies).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    await db.update(runnerRecoveryPolicies).set({ payload: { ...policy.payload, maxRecoveries: 1 } }).where(eq(runnerRecoveryPolicies.id, policy.id));
    const outcomes = await Promise.all([f.service.routeRunnerResult(f, f.input), f.service.routeRunnerResult(f, next)]);
    expect(outcomes.map(r => { if (!r.enabled) throw new Error("Expected enabled recovery"); return r.state; }).sort()).toEqual(["exhausted", "routing"]);
    expect(f.wake).toHaveBeenCalledTimes(1);
  });
  it("T14/T21 redelivery cannot release a hold; one native event can", async () => {
    const f = await fixture(); f.guard.mockResolvedValue(false);
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ reason: "guard_held" });
    f.guard.mockResolvedValue(true);
    await f.service.routeRunnerResult(f, f.input); expect(f.wake).not.toHaveBeenCalled();
    await f.service.reevaluateDeferred(f.companyId, f.issueId, "admission_released");
    expect(f.wake).toHaveBeenCalledTimes(1);
  });
  it("T18 keeps ordinary delivery available before policy activation without saving a replayable intent", async () => {
    const f = await fixture();
    await db.update(runnerRecoveryPolicies).set({ activatedAt: null }).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    expect(await f.service.routeRunnerResult(f, f.input)).toEqual({ enabled: false });
    expect((await db.select().from(runnerRecoveryResults).where(eq(runnerRecoveryResults.companyId, f.companyId)))).toEqual([]);
    await db.update(runnerRecoveryPolicies).set({ activatedAt: new Date() }).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    await f.service.reevaluateDeferred(f.companyId, f.issueId, "policy_activated");
    expect(f.wake).not.toHaveBeenCalled();
  });
  it("never uses a later policy to resume a result retained for a revoked policy", async () => {
    const f = await fixture();
    f.guard.mockResolvedValue(false);
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "deferred" });
    const [original] = await db.select().from(runnerRecoveryPolicies).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    const { id, ...replacement } = original;
    await db.update(runnerRecoveryPolicies).set({ revokedAt: new Date() }).where(eq(runnerRecoveryPolicies.id, id));
    await db.insert(runnerRecoveryPolicies).values({ ...replacement, revision: "8".repeat(64), activatedAt: new Date() });
    f.guard.mockResolvedValue(true);
    await f.service.reevaluateDeferred(f.companyId, f.issueId, "policy_activated");
    expect(await row(f)).toMatchObject({ state: "out_of_policy", reason: "original_policy_unavailable", policyId: id });
    expect(f.wake).not.toHaveBeenCalled();
  });
  it("blocks disabling pending recovery and keeps a routed receipt out of legacy delivery", async () => {
    const f = await fixture();
    f.wake.mockImplementation(async result => ({ wakeupRequestId: result.wakeupRequestId! }));
    const pending = await f.service.routeRunnerResult(f, f.input);
    expect(pending).toMatchObject({ state: "routing" });
    const admin = runnerPolicyAdministration(db);
    const actor = { type: "board", userId: "owner" } as const;
    await expect(admin.setEnabled(f.companyId, actor, false)).rejects.toThrow("runner_recovery_disable_requires_settlement");
    expect((await db.select().from(runnerRecoveryCompanySettings)
      .where(eq(runnerRecoveryCompanySettings.companyId, f.companyId)))[0].runnerPolicyRecovery.enabled).toBe(true);
    const run = await nativeRun(f);
    expect(await db.transaction(tx => claimRunnerPolicyRecovery(tx, run, f.trust))).toBe(true);
    await admin.setEnabled(f.companyId, actor, false);
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ enabled: true, state: "routed" });
    expect(f.wake).toHaveBeenCalledTimes(1);
  });
  it("serializes disablement against an in-flight recovery reservation", async () => {
    const f = await fixture();
    let reachedGuard!: () => void;
    let finishGuard!: () => void;
    const entered = new Promise<void>(resolve => { reachedGuard = resolve; });
    const release = new Promise<void>(resolve => { finishGuard = resolve; });
    f.guard.mockImplementationOnce(async () => {
      reachedGuard();
      await release;
      return true;
    });
    const result = f.service.routeRunnerResult(f, f.input);
    // Surface an unexpected early failure without leaving the other promise hanging.
    await Promise.race([entered, result.then(() => { throw new Error("Reservation did not reach its guard"); })]);
    const disable = runnerPolicyAdministration(db).setEnabled(f.companyId, { type: "board", userId: "owner" }, false);
    const refused = expect(disable).rejects.toThrow("runner_recovery_disable_requires_settlement");
    finishGuard();
    await expect(result).resolves.toMatchObject({ state: "routing" });
    await refused;
    expect(f.wake).toHaveBeenCalledTimes(1);
  });
  it("T22 a policy edit or overlap cannot replay a consumed receipt", async () => {
    const f = await fixture(); f.wake.mockImplementation(async r => ({ wakeupRequestId: r.wakeupRequestId! }));
    await f.service.routeRunnerResult(f, f.input); const run = await nativeRun(f);
    await db.transaction(tx => claimRunnerPolicyRecovery(tx, run, f.trust));
    await db.update(runnerRecoveryPolicies).set({ revision: "f".repeat(64) }).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "routed" }); expect(f.wake).toHaveBeenCalledTimes(1);
  });
  it.each(["assignee", "policy", "subtree", "review", "status"])("T15/T19/T24/T25/T26 claim refuses a changed %s fence", async change => {
    const f = await fixture(); f.wake.mockImplementation(async r => ({ wakeupRequestId: r.wakeupRequestId! }));
    await f.service.routeRunnerResult(f, f.input); const run = await nativeRun(f);
    if (change === "policy") await db.update(runnerRecoveryPolicies).set({ revokedAt: new Date() }).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    else if (change === "subtree") {
      const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other root" }).returning();
      await db.update(runnerRecoveryPolicies).set({ rootIssueId: other.id }).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    }
    else await db.update(issues).set(change === "assignee" ? { assigneeAgentId: null } : change === "review" ? { status: "in_review", executionState: { status: "pending", currentParticipant: { type: "user", userId: "owner" } } } : { statusVersion: 10 }).where(eq(issues.id, f.issueId));
    expect(await db.transaction(tx => claimRunnerPolicyRecovery(tx, run, f.trust))).toBe(false);
    expect((await row(f)).state).toBe("deferred");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("cancelled");
  });
  it("T27 keeps signed bytes when a newer sequence supersedes an unclaimed result", async () => {
    const f = await fixture(); f.wake.mockImplementation(async r => ({ wakeupRequestId: r.wakeupRequestId! }));
    await f.service.routeRunnerResult(f, f.input); const run = await nativeRun(f);
    const value = JSON.parse(Buffer.from(f.input.envelope.payload, "base64").toString("utf8")); value.sequence = 2;
    await db.update(pluginState).set({ valueJson: signed(value) }).where(and(eq(pluginState.pluginId, f.pluginId), eq(pluginState.namespace, "runner-results")));
    expect(await db.transaction(tx => claimRunnerPolicyRecovery(tx, run, f.trust))).toBe(false);
    expect(await row(f)).toMatchObject({ state: "superseded", envelopeBytes: JSON.stringify(f.input.envelope) });
  });
  it("T31 defers unavailable verification without granting unsigned authority", async () => {
    const f = await fixture(); f.trust.mockRejectedValue(new Error("unavailable"));
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "deferred", reason: "verification_unavailable" });
    expect(f.wake).not.toHaveBeenCalled();
  });
  it("T26 rejects signed wrong project, company or receipt", async () => {
    const f = await fixture(); const value = JSON.parse(Buffer.from(f.input.envelope.payload, "base64").toString("utf8"));
    value.projectId = randomUUID(); value.data.projectId = value.projectId;
    await expect(f.service.routeRunnerResult(f, { ...f.input, envelope: signed(value) })).rejects.toThrow();
    await expect(f.service.routeRunnerResult({ ...f, companyId: randomUUID() }, f.input)).resolves.toEqual({ enabled: false });
    await expect(f.service.routeRunnerResult(f, { ...f.input, receiptSha256: "f".repeat(64) })).rejects.toThrow();
    expect(f.wake).not.toHaveBeenCalled();
  });
  it("T32 protected policy writes refuse an ordinary agent", async () => {
    const f = await fixture(), admin = runnerPolicyAdministration(db);
    await expect(admin.register(f.companyId, { type: "agent", agentId: f.agentId }, {})).rejects.toThrow("Only CTO or board");
    const [policy] = await db.select().from(runnerRecoveryPolicies).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    await expect(admin.activate(f.companyId, { type: "agent", agentId: f.agentId }, policy.id)).rejects.toThrow("Only CTO or board");
  });
  it("activation never enables the separate company flag", async () => {
    const f = await fixture({ enabled: false }), admin = runnerPolicyAdministration(db);
    await db.update(agents).set({ role: "cto" }).where(eq(agents.id, f.agentId));
    const [policy] = await db.select().from(runnerRecoveryPolicies).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    await db.update(runnerRecoveryPolicies).set({ activatedAt: null }).where(eq(runnerRecoveryPolicies.id, policy.id));
    await admin.activate(f.companyId, { type: "agent", agentId: f.agentId }, policy.id);
    const [settings] = await db.select().from(runnerRecoveryCompanySettings).where(eq(runnerRecoveryCompanySettings.companyId, f.companyId));
    expect(settings.runnerPolicyRecovery.enabled).toBe(false);
  });
  it("T24 an owner hold never receives routing or stage credit", async () => {
    const f = await fixture();
    const state = { status: "pending", reviewEscalated: true, currentParticipant: { type: "user", userId: "owner" } };
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, f.issueId));
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "deferred", reason: "review_pending" });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionState).toEqual(state);
    expect(f.wake).not.toHaveBeenCalled();
  });
  it("T31 claim-time verifier unavailability is deferred without fallback", async () => {
    const f = await fixture(); f.wake.mockImplementation(async r => ({ wakeupRequestId: r.wakeupRequestId! }));
    await f.service.routeRunnerResult(f, f.input); const run = await nativeRun(f);
    f.trust.mockRejectedValueOnce(new Error("keys unavailable"));
    expect(await db.transaction(tx => claimRunnerPolicyRecovery(tx, run, f.trust))).toBe(false);
    expect(await row(f)).toMatchObject({ state: "deferred", reason: "verification_unavailable" });
  });
  it("T29 retains passing subchecks of a failed aggregate without stale pass credit", () => {
    const checks = { status: "failed", checks: [{ checkId: "preparation", status: "passed", candidateSha: "a", locale: "ar", device: "mobile" },
      { phase: "functional", status: "failed", candidateSha: "b", locale: "en", device: "desktop" }] };
    expect(projectRunnerCheckReferences(checks, "b")).toEqual([
      { checkId: "preparation", status: "passed", candidateSha: "a", locale: "ar", device: "mobile", validity: "stale_candidate", passCredit: false, rerunAuthority: false },
      { phase: "functional", status: "failed", candidateSha: "b", locale: "en", device: "desktop", validity: "current_candidate", passCredit: false, rerunAuthority: false }]);
    expect(projectRunnerCheckReferences(checks, "a")[0].passCredit).toBe(true);
  });
  it("T30 reports actual session IDs and does not infer a reset before settlement", () => {
    expect(runnerSessionReceipt("same", "same")).toMatchObject({ outcome: "reused" });
    expect(runnerSessionReceipt("old", "new")).toMatchObject({ before: "old", after: "new", outcome: "reset" });
    expect(runnerSessionReceipt("old", null).outcome).toBe("pending");
  });

  it("T9 records one lineage hold for out-of-policy results without an interaction", async () => {
    const f = await fixture();
    const [policy] = await db.select().from(runnerRecoveryPolicies).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    await db.update(runnerRecoveryPolicies).set({ payload: { ...policy.payload, scope: { issueTreeRootId: f.issueId, profiles: ["different"] } } }).where(eq(runnerRecoveryPolicies.id, policy.id));
    expect(await f.service.routeRunnerResult(f, f.input)).toEqual({ enabled: false });
    expect(await f.service.routeRunnerResult(f, await second(f))).toEqual({ enabled: false });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(1);
    expect(f.wake).not.toHaveBeenCalled();
  });
  it("T20 rolls back an uncommitted decision without a wake", async () => {
    const f = await fixture(); f.guard.mockRejectedValueOnce(new Error("crash before commit"));
    await expect(f.service.routeRunnerResult(f, f.input)).rejects.toThrow("before commit");
    expect(await db.select().from(runnerRecoveryResults).where(eq(runnerRecoveryResults.companyId, f.companyId))).toHaveLength(0);
    expect(f.wake).not.toHaveBeenCalled();
  });
  it("T15 a real plan revision change defers claim", async () => {
    const f = await fixture(); f.wake.mockImplementation(async r => ({ wakeupRequestId: r.wakeupRequestId! }));
    await f.service.routeRunnerResult(f, f.input); const run = await nativeRun(f);
    const { documents, issueDocuments } = await import("@paperclipai/db");
    const [doc] = await db.insert(documents).values({ companyId: f.companyId, title: "Accepted plan", latestBody: "revised", latestRevisionId: randomUUID() }).returning();
    await db.insert(issueDocuments).values({ companyId: f.companyId, issueId: f.issueId, key: "plan", documentId: doc.id });
    expect(await db.transaction(tx => claimRunnerPolicyRecovery(tx, run, f.trust))).toBe(false);
    expect(await row(f)).toMatchObject({ state: "deferred", reason: "fence_changed" });
  });
  it("T26 a foreign-company assignee is never a recovery target", async () => {
    const f = await fixture(), otherCompanyId = randomUUID(), otherAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Foreign", issuePrefix: "F" + otherCompanyId.slice(0, 7) });
    await db.insert(agents).values({ id: otherAgentId, companyId: otherCompanyId, name: "Foreign worker", status: "idle" });
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, f.issueId));
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "deferred", reason: "no_agent_responsible" });
    expect(f.wake).not.toHaveBeenCalled();
  });

  it("T22 enabling recovery cannot spend a result already delivered by the legacy path", async () => {
    const f = await fixture();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment", status: "completed",
      idempotencyKey: `runner-result:${f.jobId}:${f.input.receiptSha256}` });
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "replay_suppressed" });
    expect(f.wake).not.toHaveBeenCalled();
  });

  it("T26 a public policy root does not implicitly admit a private descendant", async () => {
    const f = await fixture();
    const [root] = await db.insert(issues).values({ companyId: f.companyId, title: "Public ancestor" }).returning();
    await db.update(issues).set({ parentId: root.id, visibility: "private", privacyRootIssueId: f.issueId }).where(eq(issues.id, f.issueId));
    const [policy] = await db.select().from(runnerRecoveryPolicies).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    await db.update(runnerRecoveryPolicies).set({ rootIssueId: root.id, payload: { ...policy.payload, scope: { issueTreeRootId: root.id, profiles: ["reviewed"] } } }).where(eq(runnerRecoveryPolicies.id, policy.id));
    expect(await f.service.routeRunnerResult(f, f.input)).toEqual({ enabled: false });
    expect((await db.select().from(runnerRecoveryResults).where(eq(runnerRecoveryResults.companyId, f.companyId)))).toEqual([]);
    expect(f.wake).not.toHaveBeenCalled();
  });

  it("T21 reconciles a cancelled unclaimed receipt within the same bounded release event", async () => {
    const f = await fixture(); f.wake.mockImplementation(async r => ({ wakeupRequestId: r.wakeupRequestId! }));
    await f.service.routeRunnerResult(f, f.input); const original = await row(f);
    f.wake.mockImplementationOnce(async r => {
      await db.transaction(async tx => {
        await tx.update(runnerRecoveryResults).set({ state: "deferred", reason: "guard_held", stateVersion: r.stateVersion + 1 }).where(eq(runnerRecoveryResults.id, r.id));
        await tx.update(issueRecoveryActions).set({ status: "cancelled", resolvedAt: new Date() }).where(eq(issueRecoveryActions.id, r.recoveryActionId!));
      });
      return { wakeupRequestId: r.wakeupRequestId! };
    });
    await f.service.reevaluateDeferred(f.companyId, f.issueId, "admission_released");
    const resumed = await row(f);
    expect(resumed.state).toBe("routing"); expect(resumed.id).toBe(original.id);
    expect(resumed.wakeupRequestId).not.toBe(original.wakeupRequestId);
    expect(resumed.wakeIdempotencyKey).toBe(original.wakeIdempotencyKey);
    expect(f.wake).toHaveBeenCalledTimes(3);
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.status, "active")))).toHaveLength(1);
  });

  it.each(["project_move", "queued_project", "missing_queued_project", "signed_project", "unchanged"])("B1 claim binds signed, current and queued project: %s", async change => {
    const f = await fixture();
    await f.service.routeRunnerResult(f, f.input);
    const run = await nativeRun(f), before = await row(f);
    const { projects } = await import("@paperclipai/db");
    const [other] = await db.insert(projects).values({ companyId: f.companyId, name: "Other open project" }).returning();
    if (change === "project_move") await db.update(issues).set({ projectId: other.id }).where(eq(issues.id, f.issueId));
    if (change === "queued_project" || change === "missing_queued_project") {
      run.contextSnapshot = { ...run.contextSnapshot, projectId: change === "queued_project" ? other.id : null };
      await db.update(heartbeatRuns).set({ contextSnapshot: run.contextSnapshot }).where(eq(heartbeatRuns.id, run.id));
    }
    if (change === "signed_project") {
      const value = JSON.parse(Buffer.from(f.input.envelope.payload, "base64").toString("utf8"));
      value.projectId = other.id; value.data.projectId = other.id;
      const envelope = signed(value);
      await db.update(runnerRecoveryResults).set({ envelopeBytes: JSON.stringify(envelope) }).where(eq(runnerRecoveryResults.id, before.id));
      await db.update(pluginState).set({ valueJson: envelope }).where(and(eq(pluginState.pluginId, f.pluginId), eq(pluginState.namespace, "runner-results")));
    }
    expect(await db.transaction(tx => claimRunnerPolicyRecovery(tx, run, f.trust))).toBe(change === "unchanged");
    const after = await row(f);
    expect(after.state).toBe(change === "unchanged" ? "routed" : "deferred");
    expect(after.id).toBe(before.id);
    if (change !== "unchanged") {
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("cancelled");
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!)))[0].status).toBe("skipped");
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, before.recoveryActionId!)))[0]).toMatchObject({ status: "cancelled", outcome: "not_admitted" });
      if (change !== "signed_project") expect(after.envelopeBytes).toBe(before.envelopeBytes);
    }
  });
  it("T2 defers a different valid same-company producer without changing assignment", async () => {
    const f = await fixture(), otherId = randomUUID();
    await db.insert(agents).values({ id: otherId, companyId: f.companyId, name: "Current responsible agent", adapterType: "process", status: "idle" });
    await db.update(issues).set({ assigneeAgentId: otherId }).where(eq(issues.id, f.issueId));
    expect(await f.service.routeRunnerResult(f, f.input)).toMatchObject({ state: "deferred", reason: "ownership_changed" });
    expect(f.wake).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].assigneeAgentId).toBe(otherId);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
  });

  async function nativeQueue(f: Awaited<ReturnType<typeof fixture>>) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false, enableCases: false } as never);
    deps.issuesSvc.getDependencyReadiness.mockResolvedValue({ ready: true, blockers: [] } as never);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    deps.resolveSessionBeforeForWakeup = vi.fn(async () => "preserved-session");
    const { authUsers, companyMemberships } = await import("@paperclipai/db");
    await db.insert(authUsers).values({ id: f.companyId, name: "Owner", email: f.companyId + "@test.invalid", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: f.companyId, status: "active", membershipRole: "member" });
    await db.update(companies).set({ defaultResponsibleUserId: f.companyId }).where(eq(companies.id, f.companyId));
    const wakeQueue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => f.companyId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => "preserved-session",
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: deps.filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined,
        escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("Unexpected stranded recovery escalation"); } },
    });
    deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(wakeQueue.createAdmissionTransactionScope);
    deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(wakeQueue.admitWakeBehindIssueExecution);
    const queue = createHeartbeatQueue(db, deps);
    native.trust.mockImplementation(f.trust);
    native.wakeup.mockImplementation((id, options) => queue.trackWakeup(id, options));
    const service = runnerPolicyRecovery(db, { trust: f.trust, guard: f.guard, wake: r => dispatchRunnerRecoveryWake(db, r) });
    return { queue, service };
  }
  it("TL1 pending comment remains separate and revoked policy cannot claim through the queue", async () => {
    const f = await fixture(), n = await nativeQueue(f), commentId = randomUUID();
    const [commentWake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment", reason: "issue_commented", status: "deferred_issue_execution",
      payload: { issueId: f.issueId, commentId, queuedCommentIds: [commentId], _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", commentId, wakeCommentIds: [commentId] } } }).returning();
    await n.service.routeRunnerResult(f, f.input);
    const r = await row(f);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, r.wakeupRequestId!));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    expect(native.wakeup.mock.calls.at(-1)![1].allowRunCoalescing).toBe(false);
    expect(run.contextSnapshot?.wakeCommentIds ?? []).toEqual([]);
    await db.update(runnerRecoveryPolicies).set({ revokedAt: new Date() }).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    expect(await n.queue.claimQueuedRun(run)).toBeNull();
    expect((await row(f)).state).toBe("deferred");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, commentWake.id)))[0].status).toBe("deferred_issue_execution");
  });
  it("TL1 existing queued native run and its wake remain intact", async () => {
    const f = await fixture(), n = await nativeQueue(f);
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment", reason: "issue_assigned", status: "queued" }).returning();
    const projectId = JSON.parse(Buffer.from(f.input.envelope.payload, "base64").toString()).projectId;
    const [q] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued", invocationSource: "assignment", wakeupRequestId: wake.id, contextSnapshot: { issueId: f.issueId, projectId, wakeReason: "issue_assigned" } }).returning();
    await db.update(agentWakeupRequests).set({ runId: q.id }).where(eq(agentWakeupRequests.id, wake.id));
    await n.service.routeRunnerResult(f, f.input);
    expect(native.wakeup.mock.calls.at(-1)![1].allowRunCoalescing).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, q.id)))[0]).toMatchObject({ status: "queued", wakeupRequestId: wake.id, contextSnapshot: q.contextSnapshot });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("queued");
  });
  it.each(["coalesced", "deferred_issue_execution"])("TL1 non-admitted %s receipt defers without cancelling a foreign run", async status => {
    const f = await fixture();
    await f.service.routeRunnerResult(f, f.input); const r = await row(f);
    const [foreign] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued" }).returning();
    native.wakeup.mockImplementation(async () => {
      await db.insert(agentWakeupRequests).values({ id: r.wakeupRequestId!, companyId: f.companyId, agentId: f.agentId, source: "assignment", reason: "runner_policy_recovery", idempotencyKey: r.wakeIdempotencyKey, status, runId: foreign.id });
      return foreign;
    });
    await dispatchRunnerRecoveryWake(db, r);
    expect((await row(f)).state).toBe("deferred");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, foreign.id)))[0].status).toBe("queued");
  });

  it("TL1 queued-comment claim still rechecks a retained recovery context", async () => {
    const f = await fixture(), n = await nativeQueue(f);
    // Force a dedicated enqueue even on the pre-fix dispatcher, then reconstruct
    // the legacy adopted-comment shape to exercise the actual alternative claim.
    native.wakeup.mockImplementation((id, options) => n.queue.trackWakeup(id, { ...options, allowRunCoalescing: false }));
    await n.service.routeRunnerResult(f, f.input); const r = await row(f);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, r.wakeupRequestId!));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    run.contextSnapshot = { ...run.contextSnapshot, wakeCommentIds: [randomUUID()] };
    await db.update(heartbeatRuns).set({ contextSnapshot: run.contextSnapshot }).where(eq(heartbeatRuns.id, run.id));
    await db.update(runnerRecoveryPolicies).set({ revokedAt: new Date() }).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    expect(await n.queue.claimQueuedRun(run)).toBeNull();
    expect((await row(f)).state).toBe("deferred");
  });
  it("TL1 a mismatched foreign receipt cannot be cancelled by recovery claim", async () => {
    const f = await fixture(); await f.service.routeRunnerResult(f, f.input); const own = await nativeRun(f);
    const [foreignWake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment", reason: "issue_assigned", status: "queued" }).returning();
    const [foreign] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued", wakeupRequestId: foreignWake.id, contextSnapshot: own.contextSnapshot }).returning();
    expect(await db.transaction(tx => claimRunnerPolicyRecovery(tx, foreign, f.trust))).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, foreign.id)))[0].status).toBe("queued");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, foreignWake.id)))[0].status).toBe("queued");
  });

  it.each(["revoked_merge", "cleared_context", "valid_merge"])("TL14 receipt identity survives ordinary wake context replacement: %s", async change => {
    const f = await fixture(), n = await nativeQueue(f);
    await n.service.routeRunnerResult(f, f.input);
    const r = await row(f);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, r.wakeupRequestId!));
    const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
    if (change !== "valid_merge") await db.update(runnerRecoveryPolicies).set({ revokedAt: new Date() }).where(eq(runnerRecoveryPolicies.companyId, f.companyId));
    await n.queue.trackWakeup(f.agentId, { source: "assignment", reason: "issue_assigned", contextSnapshot: {
      issueId: f.issueId, taskId: f.issueId, projectId: queued.contextSnapshot?.projectId, wakeReason: "issue_assigned" } });
    const [merged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
    expect(merged.contextSnapshot?.wakeReason).toBe("issue_assigned");
    expect(merged.wakeupRequestId).toBe(r.wakeupRequestId);
    if (change === "cleared_context") {
      const { runnerRecoveryResultId: _removed, ...ordinary } = merged.contextSnapshot!;
      merged.contextSnapshot = ordinary;
      await db.update(heartbeatRuns).set({ contextSnapshot: ordinary }).where(eq(heartbeatRuns.id, merged.id));
    }
    const claimed = await n.queue.claimQueuedRun(merged);
    if (change === "valid_merge") {
      expect(claimed?.id).toBe(queued.id);
      expect((await row(f)).state).toBe("routed");
    } else {
      expect(claimed).toBeNull();
      expect((await row(f)).state).toBe("deferred");
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, r.recoveryActionId!)))[0]).toMatchObject({ status: "cancelled", outcome: "not_admitted" });
    }
  });

});
