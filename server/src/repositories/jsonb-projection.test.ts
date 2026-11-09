import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { projectJsonb } from "./jsonb-projection.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("expanded JSON projections", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("json-projection-");
    db = createDb(fixture.connectionString);
    await db.execute(sql`create table projection_fixture (value jsonb)`);
  }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  it("preserves null, scalar, nested and fallback semantics", async () => {
    for (const input of [null, "null", "false", "123", '"text"', "[]", "{}",
      '{"a":null,"b":12,"nested":{"key":false}}', '{"b":"fallback"}']) {
      const source = sql`${input}::jsonb`;
      const projection = (value: typeof source) => sql`jsonb_build_object(
        'a', ${value}->'a', 'b', ${value}->>'b',
        'fallback', coalesce(${value}->'a', ${value}->'b'),
        'nested', ${value}#>'{nested,key}', 'null', ${value} is null)`;
      const [row] = await db.execute(sql`select ${projection(source)} as original,
        ${projectJsonb(source, projection)} as optimized`);
      expect(row.optimized).toEqual(row.original);
    }
  });

  it("reads a compressed record without changing or disclosing its saved context", async () => {
    const input = JSON.stringify({ issueId: "task", retries: 2, privateContext: "private".repeat(200_000) });
    await db.execute(sql`insert into projection_fixture values (${input}::jsonb)`);
    const value = sql`value`;
    const projection = projectJsonb(value, (expanded) => sql`jsonb_build_object(
      'issueId', ${expanded}->'issueId', 'retries', ${expanded}->'retries')`);
    const [before] = await db.execute(sql`select md5(value::text) as hash,
      pg_column_size(value) < octet_length(value::text) as compressed from projection_fixture`);
    const [row] = await db.execute(sql`select ${projection} as summary from projection_fixture`);
    const [after] = await db.execute(sql`select md5(value::text) as hash from projection_fixture`);
    expect(before.compressed).toBe(true);
    expect(row.summary).toEqual({ issueId: "task", retries: 2 });
    expect(after.hash).toBe(before.hash);
  });
});
