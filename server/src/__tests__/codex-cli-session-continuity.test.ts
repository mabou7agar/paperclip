import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execute } from "@paperclipai/adapter-codex-local/server";
import { DatabaseSync } from "node:sqlite";
import { buildEffectiveRunSessionConfigMetadata } from "../services/heartbeat.js";
import { attachPaperclipSessionMetadataToSessionParams } from "../services/heartbeat/workspaces.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it.each(["current", "config-removed", "config-filesystem-error", "home-filesystem-error", "legacy", "token", "missing", "changed", "newer-refresh", "source-missing", "source-missing-link", "source-invalid", "source-filesystem-error", "source-missing-target", "accountless-residue", "damaged-residue", "wrong-account-residue"] as const)("preserves managed native state across disposable vends: %s", async mode => {
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
fs.readFileSync(0, 'utf8');
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
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({home:fs.realpathSync(home),id,returnedId,resume,retained,authToken,configText})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:returnedId}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`); await fs.chmod(command, 0o755);
  const fingerprints: Array<{ identity: string; task: string; fingerprint: string }> = [];
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
    const config = { engine: "cli", command, cwd, env: { HOME: home, CODEX_HOME: provider }, managedAiConnection: { sessionIdentity: identity, identity: "account-token-identity" }, paperclipRuntimeSkills: [] };
    // Exercise the real server normalizer, not a constant or adapter-only hash.
    const metadata = await buildEffectiveRunSessionConfigMetadata({ adapterType: "codex_local", effectiveAdapterConfig: config, managedAiHome: home,
      agentRuntimeConfig: {}, agentConfigRevision: null, issueOverrides: null, workspaceConfig: { cwd }, environment: {},
      environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [],
    });
    fingerprints.push({ identity, task, fingerprint: metadata.fingerprint });
    const result = await execute({ runId: generation, agent: { id: "agent-one", companyId: "company-one", name: "Sol", adapterType: "codex_local", adapterConfig: {} }, runtime,
      config, sessionConfigFingerprint: metadata.fingerprint, context: { issueId: task }, onLog: async () => {},
    });
    // Same persistence decorator used by runtime-execution and run-completion.
    // session-preparation supplies the resolved managed account epoch.
    result.sessionParams = attachPaperclipSessionMetadataToSessionParams(result.sessionParams, "gpt-6.1-sol", { ...metadata, aiCredentialIdentity: identity });
    await fs.rm(home, { recursive: true, force: true }); return result;
  };
  const fresh = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-one" };
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
  expect(fingerprints[1]!.fingerprint).toBe(fingerprints[0]!.fingerprint);
  const calls = (await fs.readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
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
  if (mode === "current") {
    const concurrent = await Promise.all([invoke("concurrent-a", { ...fresh, sessionId: first.sessionId, sessionParams: second.sessionParams }), invoke("concurrent-b", { ...fresh, sessionId: first.sessionId, sessionParams: second.sessionParams })]);
    expect(concurrent.map(result => result.sessionId)).toEqual([first.sessionId, first.sessionId]);
    expect(concurrent.map(result => result.exitCode)).toEqual([0, 0]);
  }
  const taskOnly = await invoke("vend-other-task", { ...fresh, taskKey: "task-two" }, "account:epoch:0", "task-two");
  expect(taskOnly.sessionParams?.codexHome).not.toBe(second.sessionParams?.codexHome);
  const other = await invoke("vend-other-account", fresh, "account:epoch:1");
  expect(other.sessionParams?.codexHome).not.toBe(second.sessionParams?.codexHome);
  expect(fingerprints.at(-1)!.fingerprint).not.toBe(fingerprints[0]!.fingerprint);
});
