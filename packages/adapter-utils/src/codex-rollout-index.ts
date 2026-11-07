import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

export interface CodexRolloutIndexRow extends Record<string, unknown> {
  rollout_path: string;
  history_mode: "legacy" | "paginated";
}

/** Relocate one proven immutable rollout path, preserving every other column. */
export function relocateCodexRolloutIndex(input: {
  sqlitePath: string; threadId: string; errorCode: string;
  plan: (row: CodexRolloutIndexRow) => { target: string; allowedPaths: string[]; historyMode: unknown };
}): void {
  const database = new DatabaseSync(input.sqlitePath, { allowExtension: false });
  const deny = () => new Error(input.errorCode);
  try {
    database.exec("PRAGMA busy_timeout=5000");
    database.exec("BEGIN IMMEDIATE");
    // Path-only updates must not invoke unknown/general update triggers.
    if (database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name COLLATE NOCASE = 'threads'").all().some(trigger =>
      typeof trigger.sql !== "string" || !/^CREATE\s+TRIGGER\s+[a-z_][a-z0-9_]*\s+AFTER\s+(?:INSERT|UPDATE\s+OF\s+(?:created_at|updated_at))\s+ON\s+threads\s/i.test(trigger.sql))) throw deny();
    if (database.prepare(`SELECT 1 FROM sqlite_schema AS s JOIN pragma_foreign_key_list(s.name) AS f
      WHERE s.type = 'table' AND f."table" COLLATE NOCASE = 'threads'
      AND f.on_update NOT IN ('NO ACTION', 'RESTRICT') LIMIT 1`).get()) throw deny();
    const row = database.prepare("SELECT * FROM threads WHERE id = ?").get(input.threadId);
    if (!row || typeof row.rollout_path !== "string" || !["legacy", "paginated"].includes(String(row.history_mode))) throw deny();
    const plan = input.plan(row as CodexRolloutIndexRow);
    if (!plan.allowedPaths.includes(row.rollout_path) || plan.historyMode !== row.history_mode) throw deny();
    if (row.rollout_path !== plan.target) {
      const changed = database.prepare("UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ? AND history_mode = ?")
        .run(plan.target, input.threadId, row.rollout_path, row.history_mode);
      if (changed.changes !== 1) throw deny();
    }
    const after = database.prepare("SELECT * FROM threads WHERE id = ?").get(input.threadId);
    if (!after || !isDeepStrictEqual({ ...after }, { ...row, rollout_path: plan.target })) throw deny();
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally { database.close(); }
}
