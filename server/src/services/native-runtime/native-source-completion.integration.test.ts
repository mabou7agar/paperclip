import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, statusDecisions } from "@paperclipai/db";
import type { NativeExecutionInputV1, NativeSession } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";

// Replace only the never-paid controller. The outer executor, port, consumer,
// persistence, cancellation, coordinator claims and finalizer are real.
const controller = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: controller.execute,
  createNativeSessionBackend: () => { throw new Error("Real provider backend forbidden in this fixture"); },
}));
import { executePaperclipNativeSession, cancelNativeSession, getNativeSessionSteeringState } from "./native-session-executor.js";
import { heartbeatService } from "../heartbeat.js";
import { activeNativeExecutionRunIds } from "./native-active-runs.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { NativeCompletionValidationError } from "./completion-validation.js";
import { consumeSourceCitations } from "../source-citation-consumer.js";
import type { SourceMemoryEvidence } from "../source-memory.js";

type ControllerInput = Parameters<typeof import("@paperclipai/paperclip-runner").executeNativeSession>[0];

describe("source completion through the outer native executor (synthetic only)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  beforeAll(async () => {
    home = createIsolatedTestHome();
    vi.stubEnv("PAPERCLIP_HOME", home.home);
    temporary = await startEmbeddedPostgresTestDatabase("native-source-rejection-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); home?.cleanup(); vi.unstubAllEnvs(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic citation rejection", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Never-paid fixture", status: "active", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "never-paid-synthetic", cwd: home.home } });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Reject stale completion", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, issueId, scopeKind: "issue", contextSnapshot: { issueId }, invocationSource: "on_demand" }).returning();
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "never-paid-synthetic" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Synthetic fixture only", workMode: "standard" },
      workspace: { cwd: home.home, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, issueId, runId, native, execution };
  }

  it.each(["rejection", "Stop"] as const)("terminalizes %s without accepting or spawning successor work and releases ownership", async scenario => {
    const f = await fixture();
    const identity = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, agentId: f.agentId, sessionId: f.native.normalizedSessionId };
    let resourceHeld = false, guards = 0, reads = 0;
    const close = vi.fn(async () => { resourceHeld = false; });
    const cancel = vi.fn(() => ({ cleanup: Promise.resolve().then(() => { resourceHeld = false; }) }));
    const unexpected = vi.fn(async () => { throw new Error("Real provider access forbidden"); });
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => ({ resume: false, typedEvents: true, steering: true, interruption: true, structuredResult: true }),
      async *events() { throw new Error("No provider event stream is admitted"); },
      startTurn: unexpected, steer: unexpected, result: unexpected,
      snapshot: async () => ({ identity, backendKind: "mock", sessionId: identity.sessionId, activeTurnId: f.native.turnId }),
      cancel, close,
    };
    const fullSha = "a".repeat(40), sha256 = "b".repeat(64);
    const scope = { companyId: f.companyId, projectId: "synthetic-project", repositoryId: "github.com/synthetic/native-completion" };
    const citation = { ...scope, revision: fullSha, path: "fixture.ts", startLine: 1, endLine: 1, sha256 };
    const current = { schema: 1, scope, revision: fullSha, citations: [{ content: "synthetic\n", standing: "verified_source_range", citation }] } as SourceMemoryEvidence;
    const submitted = { repo: scope.repositoryId, fullSha, path: citation.path, startLine: 1, endLine: 1, sha256, mode: "current" as const };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, completionClaim: {
      ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: f.execution.completionContract.contract.revision,
    }, sourceCitations: [...Array.from({ length: 19 }, () => submitted), { ...submitted, sha256: "c".repeat(64) }] };
    controller.execute.mockReset().mockImplementationOnce(async (options: ControllerInput) => {
      await options.controlPlane.openRun({ identity, backendKind: "mock", sourceInstanceId: f.native.runnerInstanceId });
      resourceHeld = true;
      try {
        await options.onSession?.(session);
        expect(activeNativeExecutionRunIds.has(f.runId)).toBe(true);
        expect(await getNativeSessionSteeringState(f.runId)).toEqual({ disposition: "available", activeTurnId: f.native.turnId });
        if (scenario === "Stop") {
          expect(await cancelNativeSession(f.runId, "Synthetic Stop", { db, scope: "run" })).toMatchObject({ dispatched: true });
          throw new Error("native_finalization_missing: session returned no semantic result");
        }
        const completion = { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: f.native.turnId };
        const outcomes = await Promise.allSettled([
          options.controlPlane.completeRun(completion), options.controlPlane.completeRun(completion),
        ]);
        expect(outcomes.every(value => value.status === "rejected")).toBe(true);
        await expect(options.controlPlane.completeRun(completion)).rejects.toBeInstanceOf(NativeCompletionValidationError);
        // Same result reordered after refusal must not acquire another read budget.
        await expect(options.controlPlane.completeRun({ ...completion, result: { ...result,
          sourceCitations: [...result.sourceCitations].reverse(),
        } })).rejects.toThrow("structured_result_replay_conflict");
        expect(guards).toBe(1); expect(reads).toBe(19);
        throw (outcomes[0] as PromiseRejectedResult).reason;
      } finally {
        // This disposable in-process controller owns its resource. The real
        // outer executor must independently remove active state and its lease.
        await session.close({ reason: "synthetic controller settled" });
      }
    });
    const execute = () => executePaperclipNativeSession({ db, execution: f.execution, runnerInstanceId: f.native.runnerInstanceId,
      backend: { descriptor: unexpected, openSession: unexpected }, beforeCompleteRun: async value => {
        guards++;
        const verdict = await consumeSourceCitations({ submitted: value.sourceCitations, current,
          authorize: async () => ({ ...scope, frozenSha: fullSha }), read: async () => { reads++; return citation; } });
        if (!verdict.currentSatisfied) throw new NativeCompletionValidationError("source_citation_rejected");
      } });
    await expect(execute()).rejects.toThrow(scenario === "Stop" ? "native_cancellation_pending_recovery" : "source_citation_rejected");
    if (scenario === "Stop") {
      // The normal heartbeat Stop boundary projects terminal run status after
      // the native execution-owned cancellation has settled.
      expect(await heartbeatService(db).cancelRun(f.runId, "Synthetic Stop settled")).toMatchObject({ status: "cancelled" });
    }
    expect(close).toHaveBeenCalledOnce(); expect(resourceHeld).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(scenario === "Stop" ? 1 : 0);
    expect(guards).toBe(scenario === "Stop" ? 0 : 1); expect(reads).toBe(scenario === "Stop" ? 0 : 19);
    expect(unexpected).not.toHaveBeenCalled();
    expect(activeNativeExecutionRunIds.has(f.runId)).toBe(false);
    expect(await getNativeSessionSteeringState(f.runId)).toEqual({ disposition: "temporarily_unavailable", activeTurnId: null });
    expect(await cancelNativeSession(f.runId, "Late Stop after cleanup")).toBe(false);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, resultId: null,
      failureCode: scenario === "Stop" ? "native_retry_cancelled" : "native_completion_validation_rejected",
      leaseOwner: null, leaseExpiresAt: null, controlDeadlineAt: null, attempt: 1 });
    if (scenario === "rejection") {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run).toMatchObject({ status: "failed", nativePhase: "terminal_failure", errorCode: "native_completion_validation_rejected" });
      expect(run.finishedAt).not.toBeNull();
      expect(await db.select().from(issues).where(eq(issues.id, f.issueId))).toMatchObject([{ status: "blocked", executionRunId: null, checkoutRunId: null }]);
    } else {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.status).toBe("cancelled"); expect(run.finishedAt).not.toBeNull();
      expect(run.resultJson?.nativeCancellation).toMatchObject({ dispatchState: "acknowledged", dispatched: true });
    }
    // No accepted result exists to finalize. Repeated real finalizer entry must
    // refuse, rather than manufacturing acceptance, status effects or a retry.
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded" })).rejects.toThrow("native_finalization_missing");
    }
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toHaveLength(0);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    // A board-owned diagnostic hold is not automatic recovery work. No recovery
    // task, wake policy or attempted successor may be created for a refusal.
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(holds.length).toBe(scenario === "Stop" ? 0 : 1);
    for (const hold of holds) expect(hold).toMatchObject({ ownerType: "board", ownerAgentId: null,
      recoveryIssueId: null, wakePolicy: null, monitorPolicy: null, attemptCount: 0 });
    expect(controller.execute).toHaveBeenCalledOnce();
  }, 30_000);
});
