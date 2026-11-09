import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const cleanup: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

suite("run-context lookup migration", () => {
  it("keeps legacy and current scoped lookups identical and supports both indexed predicates", async () => {
    const db = await startEmbeddedPostgresTestDatabase("context-lookup-index-");
    cleanup.push(db.cleanup);
    const sql = postgres(db.connectionString, { max: 1 });
    cleanup.push(async () => { await sql.end(); });
    const company = "10000000-0000-4000-8000-000000000001";
    const other = "10000000-0000-4000-8000-000000000002";
    const agent = "20000000-0000-4000-8000-000000000001";
    const otherAgent = "20000000-0000-4000-8000-000000000002";
    await sql`insert into companies(id,name,issue_prefix) values (${company},'Fixture','CTXA'),(${other},'Other','CTXB')`;
    await sql`insert into agents(id,company_id,name) values (${agent},${company},'Fixture'),(${otherAgent},${other},'Other')`;
    const runs = [
      { id: "30000000-0000-4000-8000-000000000001", company_id: company, agent_id: agent, context_snapshot: { issueId: "target" } },
      { id: "30000000-0000-4000-8000-000000000002", company_id: company, agent_id: agent, context_snapshot: { paperclipIssue: { id: "target" }, aiConnection: { connectionId: "account" } } },
      { id: "30000000-0000-4000-8000-000000000003", company_id: other, agent_id: otherAgent, context_snapshot: { paperclipIssue: { id: "target" }, aiConnection: { connectionId: "account" } } },
    ];
    for (const row of runs) await sql`insert into heartbeat_runs ${sql(row)}`;
    await sql.unsafe('DROP INDEX heartbeat_runs_company_embedded_issue_idx');
    await sql.unsafe('DROP INDEX heartbeat_runs_company_connection_quota_idx');
    const lookup = () => sql`select id from heartbeat_runs where company_id=${company} and (context_snapshot->>'issueId'='target' or context_snapshot->'paperclipIssue'->>'id'='target') order by id`;
    const before = await lookup();
    expect(before.map(row => row.id)).toEqual(runs.slice(0,2).map(row => row.id));
    const migration = await readFile(new URL("./migrations/0455_run_context_lookup_indexes.sql", import.meta.url), "utf8");
    for (let replay=0; replay<2; replay++) for (const statement of migration.split("--> statement-breakpoint").filter(x=>x.trim())) await sql.unsafe(statement);
    expect(await lookup()).toEqual(before);
    expect((await sql`select id from heartbeat_runs where company_id=${company} and context_snapshot->'aiConnection'->>'connectionId'='account'`).map(row=>row.id)).toEqual([runs[1].id]);
    await sql.unsafe("SET enable_seqscan = off");
    for (const [predicate,index] of [
      ["context_snapshot->'paperclipIssue'->>'id'='target'", "heartbeat_runs_company_embedded_issue_idx"],
      ["context_snapshot->'aiConnection'->>'connectionId'='account' order by finished_at desc,id desc limit 1", "heartbeat_runs_company_connection_quota_idx"],
    ]) {
      const plan=await sql.unsafe(`EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id='${company}' AND ${predicate}`);
      expect(plan.map(row=>Object.values(row)[0]).join("\n")).toContain(index);
    }
  }, 240_000);
});
