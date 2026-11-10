import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { managedAiSessionIdentityCompatible } from "@paperclipai/adapter-utils/managed-ai-session-fingerprint";

const MAX_LEGACY_HOMES = 128;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

export class CodexSessionHomeError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface CodexSessionHomeInput {
  defaultHome: string;
  identity: string;
  roots: readonly string[];
  sessionId?: string;
  saved: Record<string, unknown>;
  credentialIdentity: string;
  tokenCredentialIdentity?: string;
}

async function directory(candidate: string, root: string): Promise<string | null> {
  try {
    for (const ancestor of [root, path.dirname(root), path.resolve(root, "../..")]) {
      if ((await fs.lstat(ancestor)).isSymbolicLink()) return null;
    }
    const stat = await fs.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const [real, parent] = await Promise.all([fs.realpath(candidate), fs.realpath(root)]);
    return path.dirname(real) === parent ? real : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Inspect only the selected native index row and its bounded identity header.
 * Never rewrite an index, copy credentials, or read provider conversation items. */
async function ownsThread(home: string, threadId: string, strict = false): Promise<boolean> {
  const sqlite = path.join(home, "state_5.sqlite");
  try {
    const stat = await fs.lstat(sqlite);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let db: DatabaseSync | undefined;
  let row: Record<string, unknown> | undefined;
  try {
    db = new DatabaseSync(sqlite, { readOnly: true, allowExtension: false });
    db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=250");
    const schema = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name = 'threads'").get();
    if (schema?.type !== "table" || typeof schema.sql !== "string" || /CREATE\s+VIRTUAL/i.test(schema.sql)) return false;
    if (!db.prepare("PRAGMA table_info(threads)").all().some(column => column.name === "id" && column.pk === 1)) return false;
    row = db.prepare("SELECT id, rollout_path FROM threads WHERE id = ?").get(threadId);
  } catch {
    // No selected row was established. A corrupt unrelated sibling cannot
    // hide a valid retained home. Matched-row proof failures below still stop.
    if (strict) throw new CodexSessionHomeError("codex_session_home_unproven");
    return false;
  } finally { db?.close(); }
  if (!row) return false;
  if (typeof row.rollout_path !== "string") throw new CodexSessionHomeError("codex_session_home_unproven");
  const target = await fs.realpath(row.rollout_path);
  if (!["sessions", "archived_sessions"].some(part => target.startsWith(path.join(home, part) + path.sep)) ||
      !target.endsWith(`-${threadId}.jsonl`)) throw new CodexSessionHomeError("codex_session_home_unproven");
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new CodexSessionHomeError("codex_session_home_unproven");
    const buffer = Buffer.alloc(256 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) throw new CodexSessionHomeError("codex_session_home_unproven");
    const header = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    if (header.type !== "session_meta" || header.payload?.id !== threadId) throw new CodexSessionHomeError("codex_session_home_unproven");
    return true;
  } finally { await file.close(); }
}

/** A compatible server-authorized resume may retain its old private launch home.
 * The account/epoch and current skill/config identity still fence new sessions.
 * Legacy homes are discovered only inside this company's agent-specific roots. */
export async function selectCodexSessionHome(input: CodexSessionHomeInput): Promise<string> {
  if (!input.sessionId) return input.defaultHome;
  if (!UUID.test(input.sessionId) || !managedAiSessionIdentityCompatible(input.saved.paperclipAiCredentialIdentity,
      input.credentialIdentity, input.tokenCredentialIdentity ?? input.credentialIdentity)) {
    throw new CodexSessionHomeError("codex_session_home_identity_unproven");
  }
  if (input.saved.codexHome !== undefined) {
    if (input.saved.codexHomeIdentity !== input.identity || typeof input.saved.codexHome !== "string") {
      throw new CodexSessionHomeError("codex_session_home_identity_unproven");
    }
    for (const root of input.roots) {
      const realRoot = await fs.realpath(root).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const parent = path.dirname(path.resolve(input.saved.codexHome));
      if (!realRoot || (parent !== realRoot && parent !== path.resolve(root))) continue;
      const home = await directory(input.saved.codexHome, root);
      if (home && await ownsThread(home, input.sessionId, true)) return home;
    }
    throw new CodexSessionHomeError("codex_session_home_unavailable");
  }
  // Old releases saved a thread ID but omitted the launch home. Recover that
  // exact existing home; do not transplant a rollout into a different account.
  const candidates: string[] = [];
  let inspected = 0;
  for (const root of input.roots) {
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const legacy = entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
    if (inspected + legacy.length > MAX_LEGACY_HOMES) throw new CodexSessionHomeError("codex_session_home_lookup_limit");
    inspected += legacy.length;
    for (const entry of legacy) {
      const home = await directory(path.join(root, entry.name), root);
      if (home && await ownsThread(home, input.sessionId)) candidates.push(home);
    }
  }
  if (candidates.length !== 1) throw new CodexSessionHomeError(candidates.length ? "codex_session_home_ambiguous" : "codex_session_home_unavailable");
  return candidates[0]!;
}
