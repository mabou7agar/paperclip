import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSourceMemoryRetention as initialize, cleanupSourceMemoryRetention as cleanup, SOURCE_MEMORY_RETENTION as policy } from './source-memory-retention.ts';
function ledger() {
 const db = new DatabaseSync(':memory:');
 db.exec('CREATE TABLE facts(key TEXT PRIMARY KEY,provenance TEXT); CREATE TABLE observations(key TEXT,run TEXT,operation TEXT,provenance TEXT,PRIMARY KEY(key,run,operation)); CREATE TABLE events(key TEXT PRIMARY KEY)');
 initialize(db); return db;
}
const now = 3 * policy.maxAgeMs;
test('age, deterministic ties and legacy reservations bound both independent ledgers', () => {
 const a=ledger(), b=ledger();
 try {
  const fact=a.prepare('INSERT INTO facts VALUES (?,?,?)');
  fact.run('legacy','keep',null); fact.run('expired','old',now-policy.maxAgeMs-1);
  a.exec('BEGIN');
  for(let n=policy.facts;n>=0;n--) fact.run(String(n).padStart(6,'0'),'source',now);
  const obs=a.prepare('INSERT INTO observations VALUES (?,?,?,?,?)');
  obs.run('legacy','run','phase','keep',null);
  obs.run('expired','run','phase','old',now-policy.maxAgeMs-1);
  for(let n=policy.observations;n>=0;n--) obs.run(String(n).padStart(6,'0'),'run','phase','source',now);
  a.exec("INSERT INTO events VALUES ('durable-replay-key')");
  b.prepare('INSERT INTO facts VALUES (?,?,?)').run('independent','keep',now);
  cleanup(a,now); a.exec('COMMIT');
  assert.equal(a.prepare('SELECT count(*) n FROM facts').get().n,policy.facts);
  assert.equal(a.prepare('SELECT count(*) n FROM observations').get().n,policy.observations);
  assert.equal(a.prepare("SELECT provenance FROM facts WHERE key='legacy'").get().provenance,'keep');
  assert.equal(a.prepare("SELECT key FROM facts WHERE key='expired'").get(),undefined);
  assert.equal(a.prepare("SELECT key FROM facts WHERE key='009998'").get().key,'009998');
  assert.equal(a.prepare("SELECT key FROM facts WHERE key='009999'").get(),undefined);
  assert.equal(a.prepare('SELECT count(*) n FROM events').get().n,1);
  const before=JSON.stringify(a.prepare('SELECT * FROM facts ORDER BY key').all());
  cleanup(a,now); assert.equal(JSON.stringify(a.prepare('SELECT * FROM facts ORDER BY key').all()),before);
  assert.equal(b.prepare('SELECT count(*) n FROM facts').get().n,1);
 } finally { a.close();b.close(); }
});
test('rollback restores provenance and migration; unknown-age overflow refuses before deletion', () => {
 const db=ledger();try {
  db.prepare('INSERT INTO facts VALUES (?,?,?)').run('expired','recover',0);
  db.exec('BEGIN');cleanup(db,now);assert.equal(db.prepare('SELECT count(*) n FROM facts').get().n,0);
  db.exec('ROLLBACK');assert.equal(db.prepare('SELECT count(*) n FROM facts').get().n,1);
  db.exec('BEGIN');const row=db.prepare('INSERT INTO observations VALUES (?,?,?,?,?)');
  for(let n=0;n<=policy.observations;n++)row.run(String(n),'run','phase','unknown',null);
  assert.throws(()=>cleanup(db,now),/source_memory_retention_legacy_budget/);
  assert.equal(db.prepare('SELECT count(*) n FROM facts').get().n,1);
  db.exec('ROLLBACK');
  assert.throws(()=>cleanup(db,NaN),/clock_invalid/);
 }finally{db.close();}
});
