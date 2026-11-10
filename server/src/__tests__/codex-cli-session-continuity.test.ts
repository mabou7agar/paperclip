import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execute, sessionCodec } from "@paperclipai/adapter-codex-local/server";
import { resolveHeartbeatAdapterSession } from "../services/heartbeat/session-preparation.js";
import { resolveNextSessionState } from "../services/heartbeat/run-state.js";
import { DatabaseSync } from "node:sqlite";
import * as directoryLocks from "@paperclipai/adapter-utils/workspace-restore-merge";
import { buildEffectiveRunSessionConfigMetadata } from "../services/heartbeat.js";
import { attachPaperclipSessionMetadataToSessionParams, resolveTaskSessionConfigFreshness } from "../services/heartbeat/workspaces.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it.each(["current", "explicit-id-only", "explicit-compaction", "reset-foreign", "no-row-foreign", "taskless", "foreign-explicit", "foreign-home", "unverified-manager", "lease-wait", "lease-abort", "cancel-before-launch", "compatible-config", "config-removed", "config-filesystem-error", "home-filesystem-error", "legacy", "token", "missing", "changed", "newer-refresh", "source-missing", "source-missing-link", "source-invalid", "source-filesystem-error", "source-missing-target", "accountless-residue", "damaged-residue", "wrong-account-residue"] as const)("preserves managed native state across disposable vends: %s", async mode => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-continuity-")); roots.push(root);
  const cwd = path.join(root, "workspace"); await fs.mkdir(cwd);
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip")); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "continuity");
  const command = path.join(root, "codex"), capture = path.join(root, "capture.jsonl"), control = path.join(root, "control");
  await fs.writeFile(control, "");
  await fs.writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const home = process.env.CODEX_HOME, args = process.argv.slice(2), resume = args.includes('resume');
const mode = fs.readFileSync(${JSON.stringify(control)},'utf8');
const auth = JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8'));
const authToken = auth.tokens?.access_token ?? auth.OPENAI_API_KEY;
const leaseProof = path.join(home,'fixture-active-cli'); fs.writeFileSync(leaseProof,'active',{flag:'wx'});
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,40);
const configText = fs.existsSync(path.join(home,'config.toml')) ? fs.readFileSync(path.join(home,'config.toml'),'utf8') : null;
const prompt = fs.readFileSync(0, 'utf8');
const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, history_mode TEXT)');
const id = resume ? args[args.length - 2] : crypto.randomUUID();
let retained = false;
if (resume) {
 const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(id);
 if (mode === 'missing' || !row || !fs.existsSync(row.rollout_path)) {
  fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({home:fs.realpathSync(home),id,resume,authToken,refused:true})+'\\n');
  console.error('state db missing rollout path for thread '+id); process.exit(1);
 }
 retained = fs.readFileSync(row.rollout_path,'utf8').includes('immutable-plan-marker');
} else {
 fs.mkdirSync(path.join(home,'sessions'),{recursive:true});
 const rollout = path.join(fs.realpathSync(home),'sessions','rollout-old-'+id+'.jsonl');
 fs.writeFileSync(rollout, JSON.stringify({type:'session_meta',payload:{id}})+'\\nimmutable-plan-marker\\n');
 db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(id,rollout,'legacy');
}
db.close(); fs.unlinkSync(leaseProof);
const returnedId = resume && mode === 'changed' ? crypto.randomUUID() : id;
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({home:fs.realpathSync(home),id,returnedId,resume,retained,authToken,configText,handoff:prompt.includes("immutable-plan-marker compaction handoff")})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:returnedId}));
if (resume && mode === 'changed') {
 setTimeout(() => fs.writeFileSync(path.join(home,'fixture-fresh-context-effect'),'must never execute'),500);
 setTimeout(() => process.exit(0),600);
} else console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`); await fs.chmod(command, 0o755);
  const fingerprints: Array<{ identity: string; task: string; fingerprint: string }> = [];
  let invocationSignal: AbortSignal | undefined;
  let launchCancellation: AbortController | undefined;
  let previousMetadata: Awaited<ReturnType<typeof buildEffectiveRunSessionConfigMetadata>> | undefined;
  const invoke = async (generation: string, runtime: Parameters<typeof execute>[0]["runtime"], identity = "account:epoch:0", task = "task-one") => {
    const home = path.join(root, generation), provider = path.join(home, "provider"); await fs.mkdir(provider, { recursive: true });
    await fs.writeFile(path.join(provider, "auth.json"), JSON.stringify({
      ...(mode === "accountless-residue" ? { OPENAI_API_KEY: generation } : { tokens: { account_id: "account", access_token: generation } }),
      last_refresh: "2026-11-10T16:00:00Z",
    }));
    await fs.writeFile(path.join(provider, "config.json"), "{}", { mode: 0o600 });
    await fs.writeFile(path.join(provider, "instructions.md"), "private fixture instructions", { mode: 0o600 });
    await fs.writeFile(path.join(provider, "config.toml"), "# Disposable vend metadata: " + generation + "\n");
    if (generation === "vend-two-refreshed-token") {
      if (mode === "config-removed") await fs.rm(path.join(provider, "config.toml"));
      if (["source-missing", "source-missing-link", "source-missing-target"].includes(mode)) await fs.rm(path.join(provider, "auth.json"));
      if (mode === "source-invalid") await fs.writeFile(path.join(provider, "auth.json"), "not JSON");
      if (mode === "source-filesystem-error") { await fs.rm(path.join(provider, "auth.json")); await fs.mkdir(path.join(provider, "auth.json")); }
    }
    const config = { engine: "cli", command, cwd, env: { HOME: home, CODEX_HOME: provider, ...(mode === "compatible-config" && generation === "vend-two-refreshed-token" ? { PAPERCLIP_TEST_COMPATIBLE_ENV: "updated" } : {}) }, managedAiConnection: { sessionIdentity: identity, identity: "account-token-identity" }, paperclipRuntimeSkills: [] };
    // Exercise the real server normalizer, not a constant or adapter-only hash.
    const metadata = await buildEffectiveRunSessionConfigMetadata({ adapterType: "codex_local", effectiveAdapterConfig: config, managedAiHome: home,
      agentRuntimeConfig: {}, agentConfigRevision: null, issueOverrides: null, workspaceConfig: { cwd }, environment: {},
      environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [],
    });
    fingerprints.push({ identity, task, fingerprint: metadata.fingerprint });
    if (mode === "compatible-config" && generation === "vend-two-refreshed-token") {
      expect(metadata.fingerprint).not.toBe(previousMetadata!.fingerprint);
      const input = { hasTaskSession: true, configuredModel: "gpt-6.1-sol", taskSessionParams: runtime.sessionParams, configMetadata: metadata };
      expect(resolveTaskSessionConfigFreshness(input).reset).toBe(true);
      expect(resolveTaskSessionConfigFreshness({ ...input, compatibleConfigMetadata: [previousMetadata!] }).reset).toBe(false);
    }
    const stored = runtime.sessionParams;
    const taskSession = stored && !(mode === "no-row-foreign" && generation !== "vend-one") && mode !== "taskless" ? { id: "checked-task-session", companyId: "company-one", agentId: "agent-one", adapterType: "codex_local", taskKey: runtime.taskKey,
      sessionParamsJson: stored, sessionDisplayId: runtime.sessionId } : null;
    let decoded = sessionCodec.deserialize(stored);
    if (generation === "vend-two-refreshed-token" && ["foreign-explicit", "foreign-home", "reset-foreign", "no-row-foreign"].includes(mode)) {
      const foreignId = mode === "foreign-home" ? runtime.sessionId! : "01935000-0000-7000-8000-000000000099";
      const foreignHome = path.join(path.dirname(String(stored?.codexHome)), "f".repeat(64));
      await fs.mkdir(path.join(foreignHome, "sessions"), { recursive: true });
      const rollout = path.join(await fs.realpath(foreignHome), "sessions", "rollout-foreign-" + foreignId + ".jsonl");
      await fs.writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: foreignId } }) + "\nforeign-account-history\n");
      const db = new DatabaseSync(path.join(foreignHome, "state_5.sqlite"));
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)"); db.prepare("INSERT INTO threads VALUES (?, ?)").run(foreignId, rollout); db.close();
      decoded = { ...decoded, sessionId: foreignId, codexHome: foreignHome };
    }
    if (generation === "vend-two-refreshed-token" && mode === "explicit-id-only") decoded = { sessionId: runtime.sessionId! };
    if (generation === "vend-two-refreshed-token" && mode === "unverified-manager") metadata.aiCredentialIdentity = identity; // stale current metadata is NOT proof

    const freshness = resolveTaskSessionConfigFreshness({ hasTaskSession: Boolean(stored), configuredModel: "gpt-6.1-sol",
      taskSessionParams: stored, configMetadata: metadata,
      ...(mode === "compatible-config" && generation === "vend-two-refreshed-token" ? { compatibleConfigMetadata: [previousMetadata!] } : {}),
    });
    // Actual preparation strips Paperclip metadata and verifies the raw saved
    // account before retaining a native resume. Database-only row fields below
    // are irrelevant to this pure preparation step.
    const context = { issueId: task };
    const prepared = await resolveHeartbeatAdapterSession({
      agent: { id: "agent-one", companyId: "company-one", adapterType: "codex_local" },
      task: { context, taskKey: runtime.taskKey, issueId: task, continuationSummary: null, executionContinuation: null },
      session: { runtime: { sessionId: runtime.sessionId }, taskSession, sessionCodec, explicitResumeSessionDisplayId: generation === "vend-two-refreshed-token" && ["explicit-id-only", "explicit-compaction", "foreign-explicit", "foreign-home", "reset-foreign", "no-row-foreign"].includes(mode) ? String(decoded?.sessionId) : null,
        runtimeSessionParams: decoded, managedAiRuntime: mode === "unverified-manager" && generation === "vend-two-refreshed-token" ? undefined : { sessionIdentity: identity, identity: "account-token-identity" },
        prepared: { sessionConfigMetadata: metadata, sessionConfigFreshness: freshness, resetTaskSession: freshness.reset || (mode === "reset-foreign" && generation !== "vend-one"),
          taskSessionForRun: freshness.reset || (mode === "reset-foreign" && generation !== "vend-one") ? null : taskSession, previousSessionParams: decoded },
      },
      workspace: { latestWorkspaceConfigMetadata: { version: 1, categories: [] }, workspaceConfigFreshness: {},
        reusedExecutionWorkspace: false, resolvedWorkspaceReusePolicy: { shouldRefreshWorkspaceConfigSnapshot: false },
        persistedExecutionWorkspace: null, runtimeWorkspaceWarnings: [], requestedShouldReuseExisting: false,
        workspaceReuseRequest: { requestedExecutionWorkspaceId: null },
      }, evaluateSessionCompaction: async () => mode === "explicit-compaction" && generation === "vend-two-refreshed-token"
        ? { rotate: true, reason: "qualified fixture compaction", handoffMarkdown: "immutable-plan-marker compaction handoff" } : { rotate: false },
    } as unknown as Parameters<typeof resolveHeartbeatAdapterSession>[0]);
    expect(prepared.runtimeForAdapter.sessionParams?.paperclipAiCredentialIdentity).toBeUndefined();
    expect(prepared.runtimeForAdapter.sessionParams?.__paperclipConfigFingerprint).toBeUndefined();
    if (prepared.runtimeForAdapter.sessionId && mode !== "no-row-foreign") expect(prepared.taskSessionCredentialCompatible).toBe(true);
    const result = await execute({ runId: generation, agent: { id: "agent-one", companyId: "company-one", name: "Sol", adapterType: "codex_local", adapterConfig: {} }, runtime: prepared.runtimeForAdapter,
      config, signal: invocationSignal, onMeta: async () => { launchCancellation?.abort(); }, sessionConfigFingerprint: metadata.fingerprint, context, onLog: async () => {},
    });
    const returnedHome = result.sessionParams?.codexHome, returnedHomeIdentity = result.sessionParams?.codexHomeIdentity;
    const persisted = resolveNextSessionState({ adapterType: "codex_local", codec: sessionCodec, adapterResult: result,
      outcome: result.exitCode === 0 && !result.errorMessage ? "succeeded" : "failed", previousParams: decoded,
      previousDisplayId: runtime.sessionDisplayId, previousLegacySessionId: runtime.sessionId,
    });
    result.sessionParams = result.preserveSession ? stored : attachPaperclipSessionMetadataToSessionParams(persisted.params, "gpt-6.1-sol", metadata);
    if (result.exitCode === 0) {
      expect(typeof returnedHome).toBe("string"); expect(typeof returnedHomeIdentity).toBe("string");
      expect(result.sessionParams?.codexHome).toBe(returnedHome);
      expect(result.sessionParams?.codexHomeIdentity).toBe(returnedHomeIdentity);
      expect(sessionCodec.deserialize(result.sessionParams)?.codexHome).toBe(returnedHome);
      expect(sessionCodec.deserialize(result.sessionParams)?.codexHomeIdentity).toBe(returnedHomeIdentity);
    }
    previousMetadata = metadata;
    await fs.rm(home, { recursive: true, force: true }); return result;
  };
  const fresh = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: mode === "taskless" ? null : "task-one" };
  const first = await invoke("vend-one", fresh);
  expect(first.errorCode).toBeFalsy(); expect(first.exitCode).toBe(0);
  if (!first.sessionId) throw new Error("Fixture did not return a thread ID");
  expect(first.sessionParams?.paperclipAiCredentialIdentity).toBe("account:epoch:0");
  const saved: Record<string, unknown> = { ...first.sessionParams };
  if (mode === "token") saved.paperclipAiCredentialIdentity = "account-token-identity"; // old-release migration fixture only
  // Simulate a regular credential residue in a reused home. The current vend,
  // not this expired copy, must supply the next invocation's credential.
  if (mode !== "source-missing-link") {
    await fs.rm(path.join(String(saved.codexHome), "auth.json"), { force: true });
    if (mode !== "source-missing-target") await fs.writeFile(path.join(String(saved.codexHome), "auth.json"), JSON.stringify({
    ...(mode === "accountless-residue" ? { OPENAI_API_KEY: "other-key-residue" } : {
      tokens: { account_id: mode === "wrong-account-residue" ? "other-account" : "account",
        ...(mode === "damaged-residue" ? {} : { access_token: mode === "newer-refresh" ? "native-newer-refresh" : "expired-native-residue" }) },
    }),
    ...(["newer-refresh", "accountless-residue", "damaged-residue", "wrong-account-residue"].includes(mode) ? { last_refresh: "2026-11-10T16:10:00Z" } : {}),
    }));
  }
  if (mode === "legacy" || mode === "token") {
    const source = String(saved.codexHome), old = path.join(path.dirname(source), "a".repeat(64)); await fs.rename(source, old);
    const db = new DatabaseSync(path.join(old, "state_5.sqlite"));
    db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(path.join(await fs.realpath(old), "sessions", `rollout-old-${first.sessionId}.jsonl`), first.sessionId); db.close();
    delete saved.codexHome; delete saved.codexHomeIdentity;
    await fs.mkdir(path.join(old, "skills"), { recursive: true });
    await fs.writeFile(path.join(old, "skills", "revoked-private-skill"), "old capability must not remain launchable");
  }
  await fs.writeFile(control, mode === "missing" || mode === "changed" ? mode : "");
  if (mode === "cancel-before-launch") {
    launchCancellation = new AbortController(); invocationSignal = launchCancellation.signal;
    try {
      await expect(invoke("vend-two-refreshed-token", { ...fresh, sessionId: first.sessionId, sessionParams: saved })).rejects.toMatchObject({ name: "AbortError" });
      expect((await fs.readFile(capture, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally { launchCancellation = undefined; invocationSignal = undefined; }
    return;
  }
  if (mode === "lease-wait" || mode === "lease-abort") {
    const home = String(saved.codexHome), env = { PAPERCLIP_HOME: path.join(root, "paperclip"), PAPERCLIP_INSTANCE_ID: "continuity" };
    await fs.mkdir(path.join(home, "skills"), { recursive: true });
    await fs.writeFile(path.join(home, "skills", "held-inventory"), "must remain");
    const before = await Promise.all(["auth.json", "config.toml", "skills/held-inventory"].map(name => fs.readFile(path.join(home, name))));
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { started = resolve; });
    const owner = directoryLocks.withDirectoryPublicationLock(home, async () => { started(); await gate; }, env);
    await held;
    const controller = new AbortController(); invocationSignal = controller.signal;
    let settled = false;
    const waitPolicy = vi.spyOn(directoryLocks, "withDirectoryPublicationLock");
    const pending = invoke("vend-two-refreshed-token", { ...fresh, sessionId: first.sessionId, sessionParams: saved });
    const outcome = pending.then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
    try {
      // Longer than the utility's isolated20ms timeout test, with the actual
      // production lifetime policy explicitly verified as an unbounded wait.
      await vi.waitFor(() => expect(waitPolicy.mock.calls.length).toBe(1), { timeout: 2_000, interval: 10 });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(waitPolicy.mock.calls.length).toBe(1);
      const [lockedPath, , , options] = waitPolicy.mock.calls[0]!;
      expect(await fs.realpath(lockedPath)).toBe(await fs.realpath(home));
      expect(options?.waitMs).toBe(Infinity); expect(options?.signal === controller.signal).toBe(true);
      expect(settled).toBe(false);
      expect(await Promise.all(["auth.json", "config.toml", "skills/held-inventory"].map(name => fs.readFile(path.join(home, name))))).toEqual(before);
      expect((await fs.readFile(capture, "utf8")).trim().split("\n")).toHaveLength(1);
      await expect(fs.stat(path.join(home, "fixture-active-cli"))).rejects.toMatchObject({ code: "ENOENT" });
      if (mode === "lease-abort") {
        controller.abort(); const value = await outcome;
        expect(value).toHaveProperty("error");
        expect((value as { error: Error }).error.name).toBe("AbortError");
        expect((await fs.readFile(capture, "utf8")).trim().split("\n")).toHaveLength(1);
      } else {
        release(); await owner; const value = await outcome;
        expect(value).toHaveProperty("result");
        expect((value as { result: Awaited<ReturnType<typeof execute>> }).result).toMatchObject({ exitCode: 0, sessionId: first.sessionId });
        expect((await fs.readFile(capture, "utf8")).trim().split("\n")).toHaveLength(2);
      }
    } finally {
      if (!settled) controller.abort();
      release(); await owner; await outcome;
      waitPolicy.mockRestore(); invocationSignal = undefined;
    }
    return;
  }
  if (mode === "home-filesystem-error") {
    const scope = path.dirname(String(saved.codexHome));
    await fs.rename(scope, scope + "-retained"); await fs.writeFile(scope, "unavailable directory");
    try { await expect(invoke("vend-two-refreshed-token", { ...fresh, sessionId: first.sessionId, sessionParams: saved })).rejects.toMatchObject({ code: "ENOTDIR" }); }
    finally { await fs.rm(scope); await fs.rename(scope + "-retained", scope); }
    expect((await fs.readFile(capture, "utf8")).trim().split("\n")).toHaveLength(1);
    return;
  }
  if (mode === "source-filesystem-error") {
    await expect(invoke("vend-two-refreshed-token", { ...fresh, sessionId: first.sessionId, sessionParams: saved })).rejects.toMatchObject({ code: "EISDIR" });
    expect((await fs.readFile(capture, "utf8")).trim().split("\n")).toHaveLength(1); return;
  }
  if (mode === "config-filesystem-error") {
    await fs.rm(path.join(String(saved.codexHome), "config.toml"));
    await fs.mkdir(path.join(String(saved.codexHome), "config.toml"));
    await expect(invoke("vend-two-refreshed-token", { ...fresh, sessionId: first.sessionId, sessionParams: saved })).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|EEXIST/) });
    expect((await fs.readFile(capture, "utf8")).trim().split("\n")).toHaveLength(1);
    return;
  }
  const second = await invoke("vend-two-refreshed-token", { ...fresh, sessionId: first.sessionId, sessionParams: saved });
  if (mode === "compatible-config") expect(fingerprints[1]!.fingerprint).not.toBe(fingerprints[0]!.fingerprint);
  else expect(fingerprints[1]!.fingerprint).toBe(fingerprints[0]!.fingerprint);
  const calls = (await fs.readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  if (mode === "explicit-compaction") {
    expect(calls).toHaveLength(2); expect(second.exitCode).toBe(0); expect(calls[1].resume).toBe(false); expect(calls[1].handoff).toBe(true);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await fs.readFile(path.join(calls[0].home, "sessions", `rollout-old-${first.sessionId}.jsonl`), "utf8")).toContain("immutable-plan-marker");
    return;
  }
  if (mode === "taskless") {
    expect(calls).toHaveLength(2); expect(second.exitCode).toBe(0);
    expect(calls[1].resume).toBe(false); expect(second.sessionId).not.toBe(first.sessionId);
    return;
  }
  if (mode === "reset-foreign" || mode === "no-row-foreign") {
    expect(calls).toHaveLength(1); expect(second.exitCode).toBe(1); expect(second.preserveSession).toBe(true);
    expect(second.sessionId).toBeNull(); expect(second.sessionParams).toEqual(saved);
    // A refused explicit request did not publish its home/account. The next
    // ordinary wake can only use the original record (or remain absent).
    const third = await invoke("vend-third", { ...fresh, sessionId: first.sessionId, sessionParams: second.sessionParams ?? null });
    const finalCalls = (await fs.readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    if (mode === "reset-foreign") { expect(third.exitCode).toBe(1); expect(finalCalls).toHaveLength(1); }
    else {
      expect(third.exitCode).toBe(0); expect(finalCalls).toHaveLength(2);
      expect(finalCalls[1].resume).toBe(false); expect(finalCalls[1].retained).toBe(false);
      expect(finalCalls[1].id).not.toBe(first.sessionId);
    }
    return;
  }
  if (["foreign-explicit", "foreign-home", "unverified-manager"].includes(mode)) {
    expect(calls).toHaveLength(1); expect(second.exitCode).toBe(1);
    expect(second.errorCode).toBe(mode === "unverified-manager" ? "codex_session_home_identity_unproven" : "codex_session_resume_provenance_mismatch");
    expect(second.sessionId).toBe(mode === "unverified-manager" ? null : first.sessionId); expect(second.sessionParams).toEqual(saved);
    expect(second.preserveSession).toBe(true); expect(second.clearSession).toBe(false);
    return;
  }
  if (["source-missing", "source-missing-link", "source-invalid", "source-filesystem-error", "source-missing-target"].includes(mode)) {
    expect(calls).toHaveLength(1); expect(second.exitCode).toBe(1);
    expect(second.errorCode).toBe("codex_session_credential_source_unavailable");
    expect(second.sessionParams).toEqual(saved); expect(second.clearSession).toBe(false);
    const auth = path.join(String(saved.codexHome), "auth.json");
    if (mode === "source-missing-link") expect((await fs.lstat(auth)).isSymbolicLink()).toBe(true);
    else if (mode === "source-missing-target") await expect(fs.lstat(auth)).rejects.toThrow();
    else expect(JSON.parse(await fs.readFile(auth, "utf8")).tokens.access_token).toBe("expired-native-residue");
    return;
  }
  expect(calls).toHaveLength(2); expect(calls[1]).toMatchObject({ resume: true, id: calls[0].id,
    authToken: mode === "newer-refresh" ? "native-newer-refresh" : "vend-two-refreshed-token" });
  if (mode === "missing" || mode === "changed") {
    expect(second.errorCode).toBe(mode === "missing" ? "codex_session_resume_unavailable" : "codex_session_identity_changed");
    expect(second.exitCode).toBe(1); expect(second.sessionId).toBe(first.sessionId); expect(second.sessionParams).toEqual(saved);
    expect(second.clearSession).toBe(false); expect(second.errorFamily).toBe("configuration");
    expect(second.resultJson).toHaveProperty("stdout"); expect(second.resultJson).toHaveProperty("stderr");
    if (mode === "changed") await expect(fs.stat(path.join(calls[1].home, "fixture-fresh-context-effect"))).rejects.toMatchObject({ code: "ENOENT" });
    return;
  }
  expect(second.errorCode).toBeFalsy(); expect(second.exitCode).toBe(0); expect(second.sessionId).toBe(first.sessionId);
  expect(calls[1].configText).toBe(mode === "config-removed" ? "" : "# Disposable vend metadata: vend-two-refreshed-token\n");
  for (const name of ["config.toml", "config.json", "instructions.md"]) {
    const stat = await fs.stat(path.join(calls[1].home, name)).catch(() => null);
    if (stat) expect(stat.mode & 0o077).toBe(0);
  }
  expect(calls[1].retained).toBe(true); expect(second.sessionParams?.codexHome).toBe(calls[1].home);
  await expect(fs.access(path.join(calls[1].home, "skills", "revoked-private-skill"))).rejects.toThrow();
  if (mode === "current" || mode === "newer-refresh") expect(calls[1].home).toBe(calls[0].home);
  if (mode === "newer-refresh") expect(JSON.parse(await fs.readFile(path.join(calls[1].home, "auth.json"), "utf8")).tokens.access_token).toBe("native-newer-refresh");
  if (mode === "current" || mode === "legacy") {
    const concurrent = await Promise.all([invoke("concurrent-a", { ...fresh, sessionId: first.sessionId, sessionParams: second.sessionParams ?? null }), invoke("concurrent-b", { ...fresh, taskKey: mode === "legacy" ? "task-legacy-other" : fresh.taskKey,
      sessionId: first.sessionId, sessionParams: mode === "legacy" ? saved : second.sessionParams ?? null }, "account:epoch:0", mode === "legacy" ? "task-legacy-other" : "task-one")]);
    expect(concurrent.map(result => result.sessionId)).toEqual([first.sessionId, first.sessionId]);
    expect(concurrent.map(result => result.exitCode)).toEqual([0, 0]);
  }
  const taskOnly = await invoke("vend-other-task", { ...fresh, taskKey: "task-two" }, "account:epoch:0", "task-two");
  expect(taskOnly.sessionParams?.codexHome).not.toBe(second.sessionParams?.codexHome);
  const other = await invoke("vend-other-account", fresh, "account:epoch:1");
  expect(other.sessionParams?.codexHome).not.toBe(second.sessionParams?.codexHome);
  expect(fingerprints.at(-1)!.fingerprint).not.toBe(fingerprints[0]!.fingerprint);
});

it.each(["explicit", "taskless"] as const)("keeps account-mismatch stripping and full context for %s launches", async kind => {
  const executionContinuation = { resumeDelta: { body: "delta without baseline" } };
  const old = { sessionId: "old-account-thread", cwd: "/workspace" };
  const prepared = await resolveHeartbeatAdapterSession({
    agent: { id: "agent", companyId: "company", adapterType: "codex_local" },
    task: { context: {}, taskKey: kind === "explicit" ? "task" : null, issueId: null, continuationSummary: null, executionContinuation },
    session: { runtime: { sessionId: old.sessionId }, taskSession: null, sessionCodec,
      explicitResumeSessionDisplayId: kind === "explicit" ? old.sessionId : null, runtimeSessionParams: old,
      managedAiRuntime: { sessionIdentity: "new-account:epoch:1", identity: "new-account-token" },
      prepared: { sessionConfigMetadata: { version: 1 }, sessionConfigFreshness: {}, resetTaskSession: false,
        taskSessionForRun: null, previousSessionParams: old } },
    workspace: { latestWorkspaceConfigMetadata: { version: 1, categories: [] }, workspaceConfigFreshness: {},
      reusedExecutionWorkspace: false, resolvedWorkspaceReusePolicy: { shouldRefreshWorkspaceConfigSnapshot: false },
      persistedExecutionWorkspace: null, runtimeWorkspaceWarnings: [], requestedShouldReuseExisting: false,
      workspaceReuseRequest: { requestedExecutionWorkspaceId: null } },
    evaluateSessionCompaction: async () => ({ rotate: false }),
  } as unknown as Parameters<typeof resolveHeartbeatAdapterSession>[0]);
  // This server input is identical for remote, caller-owned, ACP and generated
  // homes: the old account never reaches any adapter's resume arguments.
  expect(prepared.runtimeForAdapter.sessionId).toBeNull();
  expect(prepared.runtimeForAdapter.sessionParams).toBeNull();
  expect(prepared.runtimeForAdapter.retainedSession).toBeUndefined();
  expect(executionContinuation).not.toHaveProperty("resumeDelta");
  expect(prepared.runtimeForAdapter.unprovenExplicitResume).toBe(kind === "explicit" ? true : undefined);
});
