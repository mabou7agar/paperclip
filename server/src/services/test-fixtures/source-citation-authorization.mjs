// Dependency-free fixture loader: execute the REAL task/workspace, access and
// authorization services. Replace storage/SQL and unrelated notification/trace
// infrastructure only. Unexpected infrastructure calls throw, never grant access.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
import * as crypto from 'node:crypto';
import * as source from '../source-memory.ts';
import * as consumer from '../source-citation-consumer.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = ['source-citation-authorization.ts', 'task-workspace-access.ts', 'authorization.ts', 'access.ts',
  'native-runtime/completion-validation.ts','native-runtime/canonical.ts','native-runtime/paperclip-control-plane-port.ts', 'trust-preset-resolver.ts', 'task-repository-acquisition.ts', 'execution-identity.ts', '../errors.ts', '../lib/agent-permissions.ts'];
const files = new Map();
const names = new Map();
const resolve = (s, parent) => s.startsWith('.') ? path.resolve(path.dirname(parent), s.replace(/\.js$/, '.ts')) : s;
for (const file of real) {
  const id = path.resolve(root, file);
  const code = stripTypeScriptTypes(await readFile(id, 'utf8'));
  files.set(id, code);
  for (const m of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const key = resolve(m[2], id), set = names.get(key) ?? new Set();
    for (const name of m[1].split(',')) if (name.trim()) set.add(name.trim().split(/\s+as\s+/)[0]);
    names.set(key, set);
  }
}
const context = vm.createContext({ process, console, Buffer, Date, Set, Map, URL, structuredClone });
const modules = new Map();
const tables = new Map();
function table(name) {
  if (!tables.has(name)) tables.set(name, new Proxy({ table: name }, { get: (o, k) => k === 'table' ? o.table : { column: k, table: name } }));
  return tables.get(name);
}
const unexpected = name => () => { throw Error('Unexpected fixture dependency: ' + name); };
const sql = (strings, ...values) => ({ raw: strings.join(''), values });
sql.raw = raw => ({ raw });
const ops = {
  eq: (a, b) => row => row[a.column] === b,
  ne: (a, b) => row => row[a.column] !== b,
  and: (...conditions) => row => conditions.filter(Boolean).every(c => c(row)),
  or: (...conditions) => row => conditions.filter(Boolean).some(c => c(row)),
  inArray: (a, values) => row => values.includes(row[a.column]),
  isNull: a => row => row[a.column] == null, sql,
};
function synthetic(id, exports) {
  return new vm.SyntheticModule(Object.keys(exports), function () { for (const [k, v] of Object.entries(exports)) this.setExport(k, v); }, { context, identifier: id });
}
function load(id) {
  if (modules.has(id)) return modules.get(id);
  let module;
  if (files.has(id)) module = new vm.SourceTextModule(files.get(id), { context, identifier: id });
  else if (id === path.join(root, 'source-memory.ts')) module = synthetic(id, source);
  else if (id === path.join(root, 'source-citation-consumer.ts')) module = synthetic(id, consumer);
  else if (id === 'node:util') module = synthetic(id, util);
  else if (id === 'node:crypto') module = synthetic(id, crypto);
  else {
    const exports = {};
    for (const name of names.get(id) ?? []) {
      if (id === '@paperclipai/db') exports[name] = table(name);
      else if (id === 'drizzle-orm') exports[name] = ops[name] ?? unexpected(name);
      else if (name === 'measureRunPhase') exports[name] = (_phase, f) => f();
      else if (name === 'isRunPhaseActive') exports[name] = () => false;
      else if (name === 'DEFAULT_TRUST_PRESET') exports[name] = 'standard';
      else if (name === 'LOW_TRUST_REVIEW_PRESET') exports[name] = 'low_trust_review';
      else if (name === 'isConnectionManagementAction') exports[name] = action => action.startsWith('connection:');
      else if (name === 'createAgentIdentityRedactor') exports[name] = () => ({ redact: value => value });
      else if (name === 'redactRunnerApiPayloads') exports[name] = value => value;
      else if (name === 'normalizePrpResultSignals') exports[name] = () => ({ ignoredAttentionRequests: [] });
      else if (name === 'validatePrpStructuredRunResult') exports[name] = result => ({ ok: true, result });
      else if (name === 'nativeSha256') exports[name] = () => 'synthetic-fingerprint';
      else if (name === 'logger') exports[name] = { warn() {}, info() {} };
      else exports[name] = unexpected(name);
    }
    module = synthetic(id, exports);
  }
  modules.set(id, module); return module;
}
const entry = load(path.join(root, 'source-citation-authorization.ts'));
await entry.link((s, parent) => load(resolve(s, parent.identifier)));
await entry.evaluate();
export const authorizeSourceCitation = entry.namespace.authorizeSourceCitation;
export function syntheticAuthorizationStore(rows) {
  const reads = [];
  const db = { select(fields) { return { from(t) { return { where(condition) {
    reads.push(t.table);
    const selected = (rows[t.table] ?? []).filter(row => condition(row));
    return Promise.resolve(selected.map(row => {
      if (!fields) return { ...row };
      return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value?.column ? row[value.column] : row[key]]));
    }));
  } }; } }; } };
  return { db, reads };
}

const port = load(path.join(root, 'native-runtime/completion-validation.ts','native-runtime/canonical.ts','native-runtime/paperclip-control-plane-port.ts'));
await port.link((s, parent) => load(resolve(s, parent.identifier)));
await port.evaluate();
export const PaperclipControlPlanePort = port.namespace.PaperclipControlPlanePort;
