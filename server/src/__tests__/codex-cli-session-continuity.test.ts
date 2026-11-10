import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execute } from "@paperclipai/adapter-codex-local/server";
import { DatabaseSync } from "node:sqlite";
import { buildEffectiveRunSessionConfigMetadata } from "../services/heartbeat.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it.each(["current", "legacy", "token", "missing", "changed", "newer-refresh", "source-missing"] as const)("preserves managed native state across disposable vends: %s", async mode => {
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
const authToken = JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8')).tokens.access_token;
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
db.close();
const returnedId = resume && mode === 'changed' ? crypto.randomUUID() : id;
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({home:fs.realpathSync(home),id,returnedId,resume,retained,authToken})+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:returnedId}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`); await fs.chmod(command, 0o755);
  const fingerprints: Array<{ identity: string; task: string; fingerprint: string }> = [];
  const invoke = async (generation: string, runtime: Parameters<typeof execute>[0]["runtime"], identity = "account:epoch:0", task = "task-one") => {
    const home = path.join(root, generation), provider = path.join(home, "provider"); await fs.mkdir(provider, { recursive: true });
    await fs.writeFile(path.join(provider, "auth.json"), JSON.stringify({ tokens: { account_id: "account", access_token: generation }, last_refresh: "2026-11-10T16:00:00Z" }));
    await fs.writeFile(path.join(provider, "config.toml"), "# Disposable vend metadata: " + generation + "\n");
    if (mode === "source-missing" && generation === "vend-two-refreshed-token") await fs.rm(path.join(provider, "auth.json"));
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
    await fs.rm(home, { recursive: true, force: true }); return result;
  };
  const fresh = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-one" };
  const first = await invoke("vend-one", fresh);
  expect(first.errorCode).toBeFalsy(); expect(first.exitCode).toBe(0);
  if (!first.sessionId) throw new Error("Fixture did not return a thread ID");
  const saved: Record<string, unknown> = { ...first.sessionParams,
    paperclipAiCredentialIdentity: mode === "token" ? "account-token-identity" : "account:epoch:0" };
  // Simulate a regular credential residue in a reused home. The current vend,
  // not this expired copy, must supply the next invocation's credential.
  await fs.rm(path.join(String(saved.codexHome), "auth.json"), { force: true });
  await fs.writeFile(path.join(String(saved.codexHome), "auth.json"), JSON.stringify({
    tokens: { account_id: "account", access_token: mode === "newer-refresh" ? "native-newer-refresh" : "expired-native-residue" },
    ...(mode === "newer-refresh" ? { last_refresh: "2026-11-10T16:10:00Z" } : {}),
  }));
  if (mode === "legacy" || mode === "token") {
    const source = String(saved.codexHome), old = path.join(path.dirname(source), "a".repeat(64)); await fs.rename(source, old);
    const db = new DatabaseSync(path.join(old, "state_5.sqlite"));
    db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(path.join(await fs.realpath(old), "sessions", `rollout-old-${first.sessionId}.jsonl`), first.sessionId); db.close();
    delete saved.codexHome; delete saved.codexHomeIdentity;
    await fs.mkdir(path.join(old, "skills"), { recursive: true });
    await fs.writeFile(path.join(old, "skills", "revoked-private-skill"), "old capability must not remain launchable");
  }
  await fs.writeFile(control, mode === "missing" || mode === "changed" ? mode : "");
  const second = await invoke("vend-two-refreshed-token", { ...fresh, sessionId: first.sessionId, sessionParams: saved });
  expect(fingerprints[1]!.fingerprint).toBe(fingerprints[0]!.fingerprint);
  const calls = (await fs.readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  if (mode === "source-missing") {
    expect(calls).toHaveLength(1); expect(second.exitCode).toBe(1);
    expect(second.errorCode).toBe("codex_session_credential_source_unavailable");
    expect(second.sessionParams).toEqual(saved); expect(second.clearSession).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(String(saved.codexHome), "auth.json"), "utf8")).tokens.access_token).toBe("expired-native-residue");
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
  expect(calls[1].retained).toBe(true); expect(second.sessionParams?.codexHome).toBe(calls[1].home);
  await expect(fs.access(path.join(calls[1].home, "skills", "revoked-private-skill"))).rejects.toThrow();
  if (mode === "current" || mode === "newer-refresh") expect(calls[1].home).toBe(calls[0].home);
  if (mode === "newer-refresh") expect(JSON.parse(await fs.readFile(path.join(calls[1].home, "auth.json"), "utf8")).tokens.access_token).toBe("native-newer-refresh");
  const taskOnly = await invoke("vend-other-task", { ...fresh, taskKey: "task-two" }, "account:epoch:0", "task-two");
  expect(taskOnly.sessionParams?.codexHome).not.toBe(second.sessionParams?.codexHome);
  const other = await invoke("vend-other-account", fresh, "account:epoch:1");
  expect(other.sessionParams?.codexHome).not.toBe(second.sessionParams?.codexHome);
  expect(fingerprints.at(-1)!.fingerprint).not.toBe(fingerprints[0]!.fingerprint);
});
