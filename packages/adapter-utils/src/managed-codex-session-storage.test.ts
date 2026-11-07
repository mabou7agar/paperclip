import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareManagedCodexSessionStorage } from "./managed-codex-session-storage.js";
import { DatabaseSync } from "node:sqlite";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function root() { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-storage-")); roots.push(directory); return directory; }
function envFor(root: string, run: string): Record<string, string> {
  const home = path.join(root, run); return { HOME: home, CODEX_HOME: path.join(home, "provider") };
}

it("retains rollouts and SQLite state across disposable homes without retaining credentials", async () => {
  const directory = await root(), stateDir = path.join(directory, "state");
  const first = envFor(directory, "first");
  await prepareManagedCodexSessionStorage({ stateDir, sessionIdentity: "account:epoch-1", env: first });
  await fs.writeFile(path.join(first.CODEX_HOME, "sessions", "rollout.jsonl"), "fixture rollout");
  await fs.writeFile(path.join(first.CODEX_SQLITE_HOME, "fixture.sqlite"), "fixture state");
  await fs.writeFile(path.join(first.CODEX_HOME, "auth.json"), "fixture private credentials");
  await fs.rm(first.HOME, { recursive: true, force: true });
  const second = envFor(directory, "second");
  await prepareManagedCodexSessionStorage({ stateDir, sessionIdentity: "account:epoch-1", env: second });
  expect(await fs.readFile(path.join(second.CODEX_HOME, "sessions", "rollout.jsonl"), "utf8")).toBe("fixture rollout");
  expect(second.CODEX_SQLITE_HOME).toBe(first.CODEX_SQLITE_HOME);
  expect(await fs.readFile(path.join(second.CODEX_SQLITE_HOME, "fixture.sqlite"), "utf8")).toBe("fixture state");
  await expect(fs.access(path.join(second.CODEX_HOME, "auth.json"))).rejects.toThrow();
  const other = envFor(directory, "other");
  await prepareManagedCodexSessionStorage({ stateDir, sessionIdentity: "account:epoch-2", env: other });
  expect(await fs.readdir(path.join(other.CODEX_HOME, "sessions"))).toEqual([]);
  expect(other.CODEX_SQLITE_HOME).not.toBe(first.CODEX_SQLITE_HOME);
});

it("preserves explicit homes and rejects foreign state paths", async () => {
  const directory = await root();
  const env = { HOME: path.join(directory, "home"), CODEX_HOME: path.join(directory, "operator") };
  await prepareManagedCodexSessionStorage({ stateDir: directory, sessionIdentity: "account", env });
  expect(await fs.readdir(directory)).toEqual([]);
  await expect(prepareManagedCodexSessionStorage({ stateDir: directory, sessionIdentity: "account", env: { ...envFor(directory, "managed"), CODEX_SQLITE_HOME: "/operator/state" } })).rejects.toThrow("conflicts");
  const managed = envFor(directory, "managed");
  await fs.mkdir(path.join(managed.CODEX_HOME, "sessions"), { recursive: true });
  await expect(prepareManagedCodexSessionStorage({ stateDir: directory, sessionIdentity: "account", env: managed })).rejects.toThrow("conflicts");
});

it.each(["valid", "wrong_header", "wrong_history", "update_trigger"])("relocates only the indexed immutable rollout with %s evidence", async mode => {
  const directory = await root(), stateDir = path.join(directory, "state");
  const first = envFor(directory, "first");
  await prepareManagedCodexSessionStorage({ stateDir, sessionIdentity: "account", env: first });
  const threadId = "11111111-1111-4111-8111-111111111111";
  const name = `rollout-indexed-${threadId}.jsonl`;
  const rollout = path.join(first.CODEX_HOME, "sessions", name);
  await fs.writeFile(rollout, JSON.stringify({ type: "session_meta", payload: { id: mode === "wrong_header" ? "other" : threadId, history_mode: "legacy" } }) + "\n");
  // A different rollout for the same thread must never replace the indexed one.
  await fs.writeFile(path.join(first.CODEX_HOME, "sessions", `rollout-other-${threadId}.jsonl`), "another immutable revision");
  const sqlite = path.join(first.CODEX_SQLITE_HOME, "state_5.sqlite");
  const database = new DatabaseSync(sqlite);
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, history_mode TEXT, title TEXT)");
  database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(threadId, rollout, mode === "wrong_history" ? "paginated" : "legacy", "Retain metadata");
  database.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run("other", "/unrelated/rollout", "legacy", "Other thread");
  if (mode === "update_trigger") database.exec("CREATE TRIGGER unexpected AFTER UPDATE OF rollout_path ON threads BEGIN DELETE FROM threads WHERE id = 'other'; END");
  database.close();
  await fs.rm(first.HOME, { recursive: true, force: true });
  const second = envFor(directory, "second");
  const resume = () => prepareManagedCodexSessionStorage({ stateDir, sessionIdentity: "account", env: second, resumeSessionId: threadId });
  if (mode === "valid") await resume();
  else await expect(resume()).rejects.toThrow("codex_session_index_path_unproven");
  const check = new DatabaseSync(sqlite, { readOnly: true });
  try {
    const row = check.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
    expect(row?.title).toBe("Retain metadata");
    expect(check.prepare("SELECT title FROM threads WHERE id = 'other'").get()?.title).toBe("Other thread");
    expect(row?.rollout_path).toBe(mode === "valid" ? await fs.realpath(path.join(second.CODEX_HOME, "sessions", name)) : rollout);
  } finally { check.close(); }
});
