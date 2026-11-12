import type { DatabaseSync } from "node:sqlite";

/** Private runtime provenance only. Git objects, reader history and events are
 * not removed: they remain available to authenticate citations and deduplicate. */
export const SOURCE_MEMORY_RETENTION = { maxAgeMs: 30 * 24 * 60 * 60 * 1000, facts: 10_000, observations: 2_000 };
const tables = ["facts", "observations"] as const;
const timestamp = "runtime_created_at_ms";

/** Called inside the worker's existing transaction. Unknown-age legacy rows
 * retain NULL timestamps; opening a ledger never invents their creation time. */
export function initializeSourceMemoryRetention(db: DatabaseSync) {
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === timestamp)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${timestamp} INTEGER`);
    }
  }
}

/** Transactional, deterministic bounds. Unknown-age rows are never deleted. If
 * they alone exceed a bound, refuse rather than claim that retention succeeded. */
export function cleanupSourceMemoryRetention(db: DatabaseSync, now: number) {
  if (!Number.isSafeInteger(now) || now < SOURCE_MEMORY_RETENTION.maxAgeMs) {
    throw new Error("source_memory_retention_clock_invalid");
  }
  // Preflight both scopes before deleting from either table.
  const legacy = Object.fromEntries(tables.map(table => [table,
    Number((db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${timestamp} IS NULL`).get() as { n: number }).n),
  ])) as Record<typeof tables[number], number>;
  for (const table of tables) {
    if (legacy[table] > SOURCE_MEMORY_RETENTION[table]) throw new Error("source_memory_retention_legacy_budget");
  }
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table} WHERE ${timestamp} IS NOT NULL AND ${timestamp} < ?`)
      .run(now - SOURCE_MEMORY_RETENTION.maxAgeMs);
    // rowid is only a delete address; stable primary-key ordering breaks ties.
    const tie = table === "facts" ? "key" : "key,run,operation";
    db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}
      WHERE ${timestamp} IS NOT NULL ORDER BY ${timestamp} DESC,${tie}
      LIMIT -1 OFFSET ?)`)
      .run(SOURCE_MEMORY_RETENTION[table] - legacy[table]);
  }
}
