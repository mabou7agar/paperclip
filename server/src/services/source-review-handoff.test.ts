import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { createDb, companies, agents, projects, projectWorkspaces, executionWorkspaces,
  executionWorkspaceRuntimeLeases, heartbeatRuns, nativeRunFinalizations, issues, activityLog, completionContracts, agentWakeupRequests, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import { prepareSourceReviewHandoff, hasConfiguredSourceReviewGate } from "./source-review-handoff.js";
import { sourceReviewCandidateSha } from "./heartbeat/source-memory-run-state.js";
import { PaperclipControlPlanePort } from "./native-runtime/paperclip-control-plane-port.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { SourceReviewCaptureUnavailable } from "./source-review-capture-error.js";
import { finalizeNativeRun, recordNativeFinalizationFailure } from "./native-runtime/native-run-finalizer.js";

// Exercise the actual emitted worker, not a TS-loader child. No authorization
// service is mocked: only select the operator-qualified production JS artifact.
vi.mock("./source-memory.js", async () => {
  const { isAbsolute } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const file = process.env.SOURCE_MEMORY_BUILT_SERVICE;
  if (!file || !isAbsolute(file) || !file.endsWith(".js")) throw new Error("SOURCE_MEMORY_BUILT_SERVICE must name the qualified emitted service");
  return import(/* @vite-ignore */ pathToFileURL(file).href);
});

// Always creates a new disposable database; never uses an external/private DB URL.
// Requires an approved built server artifact for the real spawned source worker.
describe('source review handoff transaction (synthetic only)', () => {
  let db: Db, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, root: string;
  const savedConfig = process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG, savedPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  beforeAll(async () => {
    if (!process.env.SOURCE_MEMORY_READER_FIXTURE) throw new Error('Verified reader fixture required');
    root = await mkdtemp(join(tmpdir(), 'source-review-handoff-'));
    database = await startEmbeddedPostgresTestDatabase('source-review-handoff-');
    db = createDb(database.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = 'off';
  }, 60_000);
  afterEach(() => { if (savedConfig === undefined) delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG; else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = savedConfig; });
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    if (savedPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE; else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = savedPrivacy;
  });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), reviewerId = randomUUID(), issueId = randomUUID(),
      runId = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), workspaceId = randomUUID(), stageId = randomUUID();
    const repo = join(root, issueId); await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '-q', '-b', 'candidate'); git('remote', 'add', 'origin', 'https://github.com/synthetic/review');
    await writeFile(join(repo, 'example.ts'), 'export const value = 1;\n'); git('add', '.');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'final writes');
    const sha = git('rev-parse', 'HEAD');
    await db.insert(companies).values({ id: companyId, name: 'Synthetic handoff', issuePrefix: 'SH'+companyId.slice(0, 6) });
    await db.insert(agents).values([{ id: agentId, companyId, name: 'Writer', adapterType: 'paperclip_runner' },
      { id: reviewerId, companyId, name: 'Reviewer', adapterType: 'paperclip_runner' }]);
    await db.insert(projects).values({ id: projectId, companyId, name: 'Synthetic' });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: 'Source', cwd: repo, repoUrl: 'https://github.com/synthetic/review' });
    await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId: sourceId, title: 'Review final source', status: 'in_progress', assigneeAgentId: agentId,
      executionPolicy: normalizeIssueExecutionPolicy({ stages: [{ id: stageId, type: 'review', participants: [{ type: 'agent', agentId: reviewerId, userId: null }] }] }) });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, projectWorkspaceId: sourceId, sourceIssueId: issueId,
      mode: 'isolated_workspace', strategyType: 'git_worktree', providerType: 'git_worktree', name: 'Synthetic', cwd: repo, providerRef: repo,
      repoUrl: 'https://github.com/synthetic/review', branchName: 'candidate' });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: 'native', status: 'running',
      contextSnapshot: { issueId, sourceSnapshot: { workspaceId, revision: 'a'.repeat(40) } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId, executionRunId: runId }).where(eq(issues.id, issueId));
    const leaseOwner = 'native-finalizer:synthetic';
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: 'observed', leaseOwner, leaseExpiresAt: new Date(Date.now()+60_000) });
    await db.insert(executionWorkspaceRuntimeLeases).values({ companyId, executionWorkspaceId: workspaceId, ownerKey: 'issue:'+issueId,
      ownerIssueId: issueId, ownerRunId: runId, ownerAgentId: agentId, lastAction: 'start', expiresAt: new Date(Date.now()+60_000) });
    const reader = process.env.SOURCE_MEMORY_READER_FIXTURE!;
    const config = join(root, issueId+'.json');
    await writeFile(config, JSON.stringify({ version: 1, state: join(root, issueId+'-unused-state'), reader,
      manifest: join(dirname(reader), 'tooling-9c477cebfff7-manifest.json'),
      bindings: [{ companyId, projectId, repositoryId: 'github.com/synthetic/review', roots: [repo] }] }));
    process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = config;
    const owner = { runId, agentId, leaseOwner };
    const enter = (candidate: string | null = null) => issueService(db).update(issueId, {
      status: 'in_review', sourceReviewHandoffOwner: owner, sourceReviewRequestedCandidate: candidate,
    });
    return { companyId, agentId, reviewerId, issueId, runId, projectId, workspaceId, stageId, sha, git, repo, owner, enter, config };
  }
  it.each(['omission', 'explicit'] as const)('%s captures final HEAD atomically and freezes task/stage/participant', async mode => {
    const f = await seed();
    expect(await hasConfiguredSourceReviewGate(db, f)).toBe(true);
    const entered = await f.enter(mode === 'explicit' ? f.sha : null);
    expect(entered?.executionState?.reviewRequest?.candidateSha).toBe(f.sha);
    expect(entered?.assigneeAgentId).toBe(f.reviewerId);
    expect(entered?.executionState?.sourceReviewCapture).toMatchObject({ issueId: f.issueId, stageId: f.stageId, participantAgentId: f.reviewerId, writerRunId: f.runId });
    const state = entered!.executionState!, scope = { companyId: f.companyId, issueId: f.issueId, workspaceId: f.workspaceId, bindingRevision: entered!.workspaceBindingRevision };
    expect(sourceReviewCandidateSha(state, f.reviewerId, scope)).toBe(f.sha);
    for (const badScope of [{ ...scope, issueId: randomUUID() }, { ...scope, workspaceId: randomUUID() }, { ...scope, bindingRevision: 99 }]) expect(sourceReviewCandidateSha(state, f.reviewerId, badScope)).toBeNull();
    expect(sourceReviewCandidateSha({ ...state, currentStageId: randomUUID() }, f.reviewerId, scope)).toBeNull();
    expect(sourceReviewCandidateSha(state, f.agentId, scope)).toBeNull();
    await writeFile(join(f.repo, 'example.ts'), 'advanced\n'); f.git('add', '.');
    f.git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'later HEAD');
    await issueService(db).update(f.issueId, { status: 'in_review' });
    const [after] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(after!.executionState?.reviewRequest?.candidateSha).toBe(f.sha);
    const events = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, 'issue.source_review_candidate_captured')));
    expect(events).toHaveLength(1);
  });
  it('explicit mismatch rolls back stage and event', async () => {
    const f = await seed(); await expect(f.enter('b'.repeat(40))).rejects.toMatchObject({ details: { code: 'review_candidate_capture_unavailable', reason: 'explicit_candidate_mismatch' } });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId)); expect(task!.status).toBe('in_progress'); expect(task!.executionState).toBeNull();
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, 'issue.source_review_candidate_captured')))).toHaveLength(0);
  });
  it.each(['remote', 'plugin', 'unbound', 'nonrepository', 'directory', 'dirty', 'detached', 'lease', 'nativeLease', 'binding', 'participant'] as const)('%s fails closed without committing a review', async mode => {
    const f = await seed();
    if (mode === 'remote') await db.update(executionWorkspaces).set({ providerType: 'remote' }).where(eq(executionWorkspaces.id, f.workspaceId));
    if (mode === 'plugin') await db.update(executionWorkspaces).set({ providerType: 'plugin' }).where(eq(executionWorkspaces.id, f.workspaceId));
    if (mode === 'unbound') await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    if (mode === 'nonrepository') await db.update(executionWorkspaces).set({ repoUrl: null }).where(eq(executionWorkspaces.id, f.workspaceId));
    if (mode === 'directory') await db.update(executionWorkspaces).set({ cwd: root }).where(eq(executionWorkspaces.id, f.workspaceId));
    if (mode === 'dirty') await writeFile(join(f.repo, 'example.ts'), 'unfinished\n');
    if (mode === 'detached') f.git('checkout', '--detach', f.sha);
    if (mode === 'lease') await db.update(executionWorkspaceRuntimeLeases).set({ ownerRunId: null }).where(eq(executionWorkspaceRuntimeLeases.executionWorkspaceId, f.workspaceId));
    if (mode === 'nativeLease') await db.update(nativeRunFinalizations).set({ leaseOwner: 'other' }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (mode === 'binding') await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    if (mode === 'participant') {
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const state = { status: 'pending', currentStageId: f.stageId, currentStageIndex: 0, currentStageType: 'review',
        currentParticipant: { type: 'agent', agentId: f.agentId, userId: null }, returnAssignee: null, reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
      await expect(prepareSourceReviewHandoff(db, { task: task!, patch: { status: 'in_review', executionState: state as never },
        agentId: f.agentId, runId: f.runId, nativeOwner: f.owner })).rejects.toBeInstanceOf(SourceReviewCaptureUnavailable);
    } else await expect(f.enter()).rejects.toBeInstanceOf(SourceReviewCaptureUnavailable);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId)); expect(task!.status).toBe('in_progress');
  });
  it('ordinary native done with omitted candidate enters the configured stage and wakes its participant once', async () => {
    const f = await seed(), contractId = randomUUID(), sessionId = randomUUID(), sourceInstanceId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: 'paperclip.completion-contract.v1', policyVersion: 'source-review-fixture', risk: 'standard',
      completionAuthority: 'server_arbiter', incompleteCriteriaPolicy: 'preserve_non_terminal',
      contractJson: { revision: 'standalone-v1', objective: 'Finish', criteria: [{ id: 'objective', requirement: 'Complete the task' }] },
      canonicalSha256: contractId, createdByActorType: 'system', createdByActorId: 'synthetic' });
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId, runnerInstanceId: sourceInstanceId,
      completionContractId: contractId, completionContractSha256: contractId }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
    const port = new PaperclipControlPlanePort(db, { ...f, sessionId, completionContractId: contractId,
      completionContractSha256: contractId, sourceInstanceId, controlPlaneSourceInstanceId: 'synthetic-controller' });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: f.runId+':result' });
    const finalize = () => finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: 'succeeded', projectRunStatus: true,
      skipNativeResponsePresentation: true, skipNativeReviewResponse: true, skipExternalConversationSettlement: true,
      skipExternalAgentSettlement: true, skipNativeRecoveryNotices: true });
    await finalize(); await finalize();
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: 'in_review', assigneeAgentId: f.reviewerId });
    expect(task!.executionState?.reviewRequest?.candidateSha).toBe(f.sha);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, 'issue.source_review_candidate_captured')))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.reviewerId)))).toHaveLength(1);
  });
  it('typed unsupported capture is terminal with no scheduled retry and preserves source context', async () => {
    const f = await seed();
    await recordNativeFinalizationFailure({ db, runId: f.runId, error: new SourceReviewCaptureUnavailable('workspace_writer_lease_mismatch') });
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: 'terminal_failure', failureCode: 'review_candidate_capture_unavailable', nextAttemptAt: null });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run!.contextSnapshot?.sourceSnapshot).toEqual({ workspaceId: f.workspaceId, revision: 'a'.repeat(40) });
    expect(await readFile(join(f.repo, 'example.ts'), 'utf8')).toBe('export const value = 1;\n');
  });
});
