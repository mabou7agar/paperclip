import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { withDirectoryMergeLock, withDirectoryPublicationLock, WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { afterEach, expect, it } from "vitest";
import { selectCodexSessionHome, type CodexSessionHomeInput } from "./session-home.js";

const roots: string[] = [];
const thread = "01935000-0000-7000-8000-000000000001";
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-resume-home-")); roots.push(root);
  const scope = path.join(root, "company", "skill-runtimes", "agent-one");
  const home = path.join(scope, "a".repeat(64));
  await fs.mkdir(path.join(home, "sessions"), { recursive: true });
  const real = await fs.realpath(home);
  const rollout = path.join(real, "sessions", `rollout-old-${thread}.jsonl`);
  await fs.writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: thread } }) + "\n");
  const index = path.join(real, "state_5.sqlite");
  const db = new DatabaseSync(index);
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, history_mode TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(thread, rollout, "legacy"); db.close();
  const input: CodexSessionHomeInput = { defaultHome: path.join(scope, "b".repeat(64)),
    identity: "current-config", roots: [scope], sessionId: thread,
    saved: { paperclipAiCredentialIdentity: "account:epoch:0" }, credentialIdentity: "account:epoch:0" };
  return { root, scope, home: real, rollout, index, input };
}

it("recovers an old-saved thread's exact existing home and persists the explicit binding without modifying native files", async () => {
  const f = await setup();
  const before = await fs.readFile(f.index);
  expect(await selectCodexSessionHome(f.input)).toBe(f.home);
  expect(await fs.readFile(f.index)).toEqual(before);
  const saved = { ...f.input.saved, codexHome: f.home, codexHomeIdentity: f.input.identity };
  expect(await selectCodexSessionHome({ ...f.input, saved })).toBe(f.home);
  expect(await fs.readFile(f.index)).toEqual(before);
});

it("new tasks use their new private home without reading unrelated saved indexes", async () => {
  const f = await setup(); await fs.writeFile(f.index, "broken index");
  expect(await selectCodexSessionHome({ ...f.input, sessionId: undefined })).toBe(f.input.defaultHome);
});

it("skips corrupt unrelated sibling indexes and ignores new versioned homes in the legacy scan limit", async () => {
  const f = await setup();
  const bad = path.join(f.scope, "c".repeat(64)); await fs.mkdir(bad); await fs.writeFile(path.join(bad, "state_5.sqlite"), "corrupt unrelated database");
  await Promise.all(Array.from({ length: 129 }, (_, n) => fs.mkdir(path.join(f.scope, "v1-" + String(n).padStart(64, "0")))));
  expect(await selectCodexSessionHome(f.input)).toBe(f.home);
});

it("accepts only the server's token-era epoch-zero migration and refuses absent identity", async () => {
  const f = await setup(); const input = { ...f.input, tokenCredentialIdentity: "old-token-id", saved: { paperclipAiCredentialIdentity: "old-token-id" } };
  expect(await selectCodexSessionHome(input)).toBe(f.home);
  await expect(selectCodexSessionHome({ ...input, credentialIdentity: "account:epoch:1" })).rejects.toThrow("codex_session_home_identity_unproven");
  await expect(selectCodexSessionHome({ ...input, saved: {} })).rejects.toThrow("codex_session_home_identity_unproven");
});

it("reports an explicitly bound corrupt native index as unproven, not missing", async () => {
  const f = await setup(); await fs.writeFile(f.index, "corrupt selected index");
  await expect(selectCodexSessionHome({ ...f.input, saved: { ...f.input.saved,
    codexHome: f.home, codexHomeIdentity: f.input.identity } })).rejects.toThrow("codex_session_home_unproven");
});

it("retains unknown native index versions and refuses them by name before any provider launch", async () => {
  const f = await setup(); await fs.rename(f.index, path.join(f.home, "state_6.sqlite"));
  await expect(selectCodexSessionHome({ ...f.input, saved: { ...f.input.saved,
    codexHome: f.home, codexHomeIdentity: f.input.identity } })).rejects.toThrow("codex_session_index_schema_unsupported");
  expect((await fs.stat(path.join(f.home, "state_6.sqlite"))).isFile()).toBe(true);
  expect((await fs.stat(f.rollout)).isFile()).toBe(true);
});

it.each(["account", "config", "foreign-home", "missing", "header", "symlink-file", "symlink-root", "view", "duplicate", "bound-limit"])("refuses %s evidence without modifying or deleting retained state", async mode => {
  const f = await setup(); let input = f.input;
  if (mode === "account") input = { ...input, credentialIdentity: "another-account" };
  if (mode === "config") input = { ...input, saved: { ...input.saved, codexHome: f.home, codexHomeIdentity: "stale" } };
  if (mode === "foreign-home") input = { ...input, saved: { ...input.saved, codexHome: path.join(f.root, "another-agent"), codexHomeIdentity: input.identity } };
  if (mode === "missing") input = { ...input, sessionId: "01935000-0000-7000-8000-000000000002" };
  if (mode === "header") await fs.writeFile(f.rollout, JSON.stringify({ type: "session_meta", payload: { id: "another-thread" } }) + "\n");
  if (mode === "symlink-file") { const outside = path.join(f.root, "foreign.jsonl"); await fs.copyFile(f.rollout, outside); await fs.rm(f.rollout); await fs.symlink(outside, f.rollout); }
  if (mode === "symlink-root") { await fs.rename(f.scope, f.scope + "-actual"); await fs.symlink(f.scope + "-actual", f.scope); }
  if (mode === "view") { const db = new DatabaseSync(f.index); db.exec("ALTER TABLE threads RENAME TO data; CREATE VIEW threads AS SELECT * FROM data"); db.close(); }
  if (mode === "duplicate") { const other = path.join(f.scope, "c".repeat(64)); await fs.cp(f.home, other, { recursive: true }); const rollout = path.join(await fs.realpath(other), "sessions", path.basename(f.rollout)); const db = new DatabaseSync(path.join(other, "state_5.sqlite")); db.prepare("UPDATE threads SET rollout_path = ?").run(rollout); db.close(); }
  if (mode === "bound-limit") await Promise.all(Array.from({ length: 128 }, (_, n) => fs.mkdir(path.join(f.scope, String(n).padStart(64, "0")))));
  await expect(selectCodexSessionHome(input)).rejects.toThrow("codex_session_home_");
  // Refusal is observational; original records remain available for recovery.
  if (mode !== "symlink-root") expect((await fs.stat(f.index)).isFile()).toBe(true);
});


it.each([false, true])("propagates a transient locked native index (bound=%s)", async bound => {
  const f = await setup();
  const db = new DatabaseSync(f.index); db.exec("BEGIN EXCLUSIVE");
  const input = bound ? { ...f.input, saved: { ...f.input.saved, codexHome: f.home, codexHomeIdentity: f.input.identity } } : f.input;
  try { await expect(selectCodexSessionHome(input)).rejects.toMatchObject({ errcode: 5 }); }
  finally { db.exec("ROLLBACK"); db.close(); }
});

it("propagates root filesystem failures instead of declaring native evidence invalid", async () => {
  const f = await setup();
  // A non-directory root deterministically fails on every supported uid/OS.
  await expect(selectCodexSessionHome({ ...f.input, roots: [f.rollout] })).rejects.toMatchObject({ code: "ENOTDIR" });
});


it("retains a proven bound home when the control plane explicitly permits compatible config migration", async () => {
  const f = await setup(); const saved = { ...f.input.saved, codexHome: f.home,
    codexHomeIdentity: "a".repeat(64), __paperclipConfigFingerprint: "v1:sha256:" + "b".repeat(64) };
  await expect(selectCodexSessionHome({ ...f.input, saved })).rejects.toThrow("codex_session_home_identity_unproven");
  expect(await selectCodexSessionHome({ ...f.input, saved, allowCompatibleRebind: true })).toBe(f.home);
  await expect(selectCodexSessionHome({ ...f.input, saved, credentialIdentity: "other-account", allowCompatibleRebind: true })).rejects.toThrow("codex_session_home_identity_unproven");
});


it("a contender timeout never expires the selected home's existing lifetime lease", async () => {
  const f = await setup(), env = { PAPERCLIP_HOME: f.root, PAPERCLIP_INSTANCE_ID: "native-lease-test" };
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { started = resolve; });
  const owner = withDirectoryPublicationLock(f.home, async () => { started(); await gate; }, env);
  await held; let entered = false;
  try {
    await expect(withDirectoryMergeLock(f.home, async () => { entered = true; }, env, undefined, 20)).rejects.toMatchObject({ code: WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE });
    expect(entered).toBe(false);
  } finally { release(); await owner; }
  await withDirectoryPublicationLock(f.home, async () => { entered = true; }, env);
  expect(entered).toBe(true);
});


it.each(["legacy", "mixed"])("names an unsupported native index for %s records without deleting evidence", async mode => {
  const f = await setup();
  await fs.copyFile(f.index, path.join(f.home, "state_6.sqlite"));
  if (mode === "legacy") await fs.rm(f.index);
  const input = mode === "legacy" ? f.input : { ...f.input, saved: { ...f.input.saved, codexHome: f.home, codexHomeIdentity: f.input.identity } };
  await expect(selectCodexSessionHome(input)).rejects.toThrow("codex_session_index_schema_unsupported");
  expect((await fs.stat(path.join(f.home, "state_6.sqlite"))).isFile()).toBe(true);
  expect((await fs.stat(f.rollout)).isFile()).toBe(true);
});
