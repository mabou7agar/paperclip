import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import history from "./__fixtures__/fork-migration-history.json" with { type: "json" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? it : it.skip)("upgrades the old fork by SQL hash, retaining sessions, context and quota receipts without replaying renamed migrations", async () => {
  const database = await startEmbeddedPostgresTestDatabase("fork-upstream-upgrade-");
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => { await sql.end(); });
  // This is an isolated disposable cluster, never a configured application DB.
  await sql.unsafe('DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA public; CREATE SCHEMA drizzle;');
  await sql.unsafe('CREATE TABLE drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
  const journal = JSON.parse(await readFile(new URL("./migrations/meta/_journal.json", import.meta.url), "utf8"));
  const base = journal.entries.slice(0, history.baseEntryCount) as Array<{ tag: string; when: number }>;
  expect(base).toHaveLength(332);
  expect(base.at(-1)?.tag).toBe(history.baseLastTag);
  const oldMigrations = [...base.map(entry => ({ tag: entry.tag, when: entry.when, expectedHash: null as string | null })),
    ...history.renames.map(entry => ({ tag: entry.newTag, when: entry.oldWhen, expectedHash: entry.sqlSha256 }))];
  for (const entry of oldMigrations) {
    const content = await readFile(new URL(`./migrations/${entry.tag}.sql`, import.meta.url), "utf8");
    const hash = createHash("sha256").update(content).digest("hex");
    if (entry.expectedHash) expect(hash).toBe(entry.expectedHash);
    const apply = async (executor: Pick<typeof sql, "unsafe">) => {
      for (const statement of content.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) {
        await executor.unsafe(statement.replace(/^(\s*ALTER TABLE "[^"]+" DROP CONSTRAINT) (?!IF EXISTS\b)/i, "$1 IF EXISTS "));
      }
    };
    // Match the historical migrator's per-file transactions, including its
    // three explicit concurrent-index / committing-backfill exceptions.
    if (["0313_private_task_access", "0314_private_task_draft_assets", "0332_little_night_nurse"].includes(entry.tag)) await apply(sql);
    else await sql.begin(tx => apply(tx));
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash}, ${entry.when})`;
  }
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
  const sessionId = randomUUID(), connectionId = randomUUID(), grantId = randomUUID(), probeId = randomUUID();
  await sql`INSERT INTO companies(id,name,issue_prefix) VALUES (${companyId},'Cutover fixture','CUT')`;
  await sql`INSERT INTO agents(id,company_id,name,adapter_type) VALUES (${agentId},${companyId},'Saved worker','claude_local')`;
  await sql`INSERT INTO issues(id,company_id,title,identifier,status,assignee_agent_id) VALUES (${issueId},${companyId},'Saved task','CUT-1','in_progress',${agentId})`;
  await sql`INSERT INTO heartbeat_runs(id,company_id,agent_id,issue_id,status,error_code,context_snapshot,session_id_before,session_id_after)
    VALUES (${runId},${companyId},${agentId},${issueId},'failed','provider_quota',${sql.json({ issueId, plan: "frozen-plan", candidate: "frozen-candidate" })},${sessionId},${sessionId})`;
  await sql`INSERT INTO agent_task_sessions(company_id,agent_id,adapter_type,task_key,session_params_json,session_display_id,last_run_id,goal_json)
    VALUES (${companyId},${agentId},'claude_local',${issueId},${sql.json({ sessionId, connectionId, fingerprint: "saved-binding" })},${sessionId},${runId},${sql.json({ plan: "frozen-plan", candidate: "frozen-candidate" })})`;
  await sql`INSERT INTO company_phase_routing(company_id,policy) VALUES (${companyId},${sql.json({ enabled: true, planning: [], implementation: [], review: [], unknownResetCooldownSeconds: 0 })})`;
  await sql`INSERT INTO provider_quota_probes(id,company_id,connection_id,grant_id,source_run_id,model,next_check_at,outcome,recovery_delivered_at)
    VALUES (${probeId},${companyId},${connectionId},${grantId},${runId},'saved-model',now(),'available',now())`;
  const retained = async () => ({
    sessions: Array.from(await sql`SELECT to_jsonb(t) AS row FROM agent_task_sessions t WHERE company_id=${companyId}`),
    context: Array.from(await sql`SELECT context_snapshot,session_id_before,session_id_after FROM heartbeat_runs WHERE id=${runId}`),
    policy: Array.from(await sql`SELECT to_jsonb(t) AS row FROM company_phase_routing t WHERE company_id=${companyId}`),
    probes: Array.from(await sql`SELECT to_jsonb(t) AS row FROM provider_quota_probes t WHERE company_id=${companyId}`),
  });
  const before = await retained(), state = await inspectMigrations(database.connectionString);
  expect(state.status).toBe("needsMigrations");
  if (state.status !== "needsMigrations") throw new Error("Expected pending upstream migrations");
  for (const entry of history.renames) expect(state.pendingMigrations).not.toContain(`${entry.newTag}.sql`);
  await applyPendingMigrations(database.connectionString);
  expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  expect(await retained()).toEqual(before);
  const migrationRows = Array.from(await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`);
  await applyPendingMigrations(database.connectionString);
  expect(Array.from(await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)).toEqual(migrationRows);
  expect(await retained()).toEqual(before);
}, 240_000);
