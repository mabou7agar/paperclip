import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import test from "node:test";
import { resolve } from "node:path";
import { decodeInventory } from "../scripts/lib/capability-inventory.mjs";
import { validateRows } from "../scripts/generate-capability-contract.mjs";

const phaseDirectory = resolve(import.meta.dirname, "../generated/capability");

async function readRows(file) {
  return JSON.parse(await readFile(resolve(phaseDirectory, file), "utf8")).rows;
}

test("generated Capability inventory has full source coverage", async () => {
  const [capabilities, tools, evals] = await Promise.all([
    readRows("capabilities.yaml"),
    readRows("mcp-tool-map.yaml"),
    readRows("eval-traceability.yaml"),
  ]);

  assert.equal(capabilities.length, 167);
  assert.equal(capabilities.filter(row => row.sourceAnchor.startsWith("skills/paperclip/references/issue-documents.md#")).length, 3);
  assert.equal(tools.length, 42);
  assert.equal(evals.length, 106);
  assert.equal(new Set(evals.map((row) => row.group)).size, 16);
  for (const row of [...capabilities, ...tools, ...evals]) {
    assert.match(row.sourceAnchor, /\S/);
    assert.match(row.semanticOperation, /\S/);
    assert.match(row.expectedMockState, /\S/);
  }
});

test("contract validation rejects missing, duplicate, and unclassified entries", () => {
  const row = {
    id: "example:1",
    sourceAnchor: "source.md#L1:example",
    primaryDisposition: "control_plane_owned",
  };

  assert.throws(() => validateRows([{ ...row, sourceAnchor: "" }], "fixture"), /source anchor/);
  assert.throws(() => validateRows([row, { ...row, id: "example:2" }], "fixture"), /duplicate source anchor/);
  assert.throws(() => validateRows([{ ...row, primaryDisposition: "unclassified" }], "fixture"), /valid primary disposition/);
});


test("conversational answer guidance has the same agent-operation classification in both inventories", async () => {
  const generated = (await readRows("capabilities.yaml")).filter(row => row.heading === "Conversational confirmation answers");
  const spec = decodeInventory(await readFile(resolve(import.meta.dirname, "../spec/capability/capabilities.yaml"), "utf8")).rows
    .filter(row => row.title === "Conversational confirmation answers");
  assert.equal(generated.length, 2);
  assert.equal(spec.length, 2);
  for (const row of [...generated, ...spec]) assert.equal(row.primaryDisposition, "always_agent_tool");
  for (const row of generated) assert.equal(row.semanticOperation, "call_api");
});

test("both capability inventories cover every declared skill source", async () => {
  const contract = JSON.parse(await readFile(resolve(import.meta.dirname, "../spec/capability/source-contract.json"), "utf8"));
  const generated = await readRows("capabilities.yaml");
  const normative = decodeInventory(await readFile(resolve(import.meta.dirname, "../spec/capability/capabilities.yaml"), "utf8"));
  assert.deepEqual(normative.generatedFrom, contract.skillSources);
  for (const source of contract.skillSources) {
    assert.ok(generated.some(row => row.sourceAnchor.startsWith(`${source}#`)), `Missing generated source ${source}`);
    assert.ok(normative.rows.some(row => row.sourceAnchor.startsWith(`${source}:`)), `Missing normative source ${source}`);
  }
  assert.equal(normative.rows.filter(row => row.sourceAnchor.startsWith("skills/paperclip/references/issue-documents.md:")).length, 3);
});


test("contract CLI checks and regenerates drift from a checkout path containing spaces", async t => {
  const fixture = await mkdtemp(resolve(tmpdir(), "paperclip contract space "));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = resolve(import.meta.dirname, "../../..");
  const contract = JSON.parse(await readFile(resolve(root, "packages/paperclip-runner/spec/capability/source-contract.json"), "utf8"));
  for (const file of [
    ...contract.skillSources,
    "packages/mcp-server/src/tools.ts",
    "packages/paperclip-runner/scripts/generate-capability-contract.mjs",
    "packages/paperclip-runner/spec/capability/source-contract.json",
  ]) {
    await mkdir(dirname(resolve(fixture, file)), { recursive: true });
    await cp(resolve(root, file), resolve(fixture, file));
  }
  const script = resolve(fixture, "packages/paperclip-runner/scripts/generate-capability-contract.mjs");
  await mkdir(resolve(fixture, "packages/paperclip-runner/generated/capability"), { recursive: true });
  const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });
  run();
  run("--check");
  const skill = resolve(fixture, contract.skillSources[0]);
  await writeFile(skill, await readFile(skill, "utf8") + "\n## Additional artifact guidance\n");
  const drift = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /Generated contract drift/);
  run();
  run("--check");
});
