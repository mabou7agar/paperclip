import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants, closeSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { linkManagedSessionDirectory } from "./managed-session-directory.js";
import { relocateCodexRolloutIndex } from "./codex-rollout-index.js";

/** Persist native conversation state; leave auth.json in the disposable home. */
export async function prepareManagedCodexSessionStorage(input: {
  stateDir: string; sessionIdentity: string; env: Record<string, string>; resumeSessionId?: string;
}): Promise<void> {
  const home = input.env.HOME;
  const codexHome = input.env.CODEX_HOME;
  if (!home || codexHome !== path.join(home, "provider")) return;
  const namespace = createHash("sha256").update(input.sessionIdentity).digest("hex");
  const storage = path.join(input.stateDir, "codex-session-data", namespace);
  const sqliteHome = path.join(storage, "sqlite");
  if (input.env.CODEX_SQLITE_HOME && path.resolve(input.env.CODEX_SQLITE_HOME) !== sqliteHome) {
    throw new Error("Managed Codex session storage conflicts with a configured SQLite home");
  }
  await fs.mkdir(sqliteHome, { recursive: true, mode: 0o700 });
  for (const directory of ["sessions", "archived_sessions"]) {
    await linkManagedSessionDirectory(path.join(storage, directory), path.join(codexHome, directory));
  }
  input.env.CODEX_SQLITE_HOME = sqliteHome;
  if (!input.resumeSessionId) return;
  const databases = (await fs.readdir(sqliteHome)).filter(name => /^state_\d+\.sqlite$/.test(name));
  if (!databases.length) return;
  if (databases.length !== 1 || databases[0] !== "state_5.sqlite") throw new Error("codex_session_index_schema_unsupported");
  const sqlite = path.join(sqliteHome, databases[0]);
  if (!(await fs.lstat(sqlite)).isFile()) throw new Error("codex_session_index_path_unproven");
  const threadId = input.resumeSessionId;
  // Native Codex indexes the exact rollout path and does not fall back to a
  // directory scan. Keep that immutable file identity while relocating only
  // its disposable-home prefix into this account's private retained storage.
  relocateCodexRolloutIndex({ sqlitePath: sqlite, threadId, errorCode: "codex_session_index_path_unproven", plan: row => {
    const parts = path.normalize(row.rollout_path).split(path.sep);
    const directoryIndex = Math.max(parts.lastIndexOf("sessions"), parts.lastIndexOf("archived_sessions"));
    if (directoryIndex < 0 || !parts.at(-1)?.endsWith(`-${threadId}.jsonl`)) throw new Error("codex_session_index_path_unproven");
    const target = realpathSync(path.join(storage, ...parts.slice(directoryIndex)));
    if (!target.startsWith(realpathSync(storage) + path.sep)) throw new Error("codex_session_index_path_unproven");
    const file = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let first: { type?: unknown; payload?: { id?: unknown; history_mode?: unknown } };
    try {
      const buffer = Buffer.alloc(256 * 1024);
      const size = readSync(file, buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, size).indexOf(10);
      if (newline < 0) throw new Error("codex_session_index_path_unproven");
      first = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    } finally { closeSync(file); }
    if (first.type !== "session_meta" || first.payload?.id !== threadId) throw new Error("codex_session_index_path_unproven");
    return { target, allowedPaths: [row.rollout_path, target], historyMode: first.payload.history_mode ?? "legacy" };
  } });
}
