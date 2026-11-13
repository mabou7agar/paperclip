/** Operator policy only. Resource limits do not change the reader's file plan. */
export type SourceIndexCapacity = {
  mode: "auto" | "fixed";
  maxStateBytes?: number; maxScopeBytes?: number;
  reserveDiskBytes?: number; diskFraction?: number;
  reserveMemoryBytes?: number; memoryFraction?: number;
  retrievalExpansionFactor?: number;
  maxBatchFiles?: number; sliceMs?: number; maxSlices?: number; maxDurationMs?: number;
};
export type CapacityResources = { freeDiskBytes: number; totalDiskBytes: number; availableMemoryBytes: number; stateBytes: number; scopeBytes: number };
export type IndexProgress = { revision: string; identity: string; cursor: number; totalFiles: number };
const MiB = 1024 * 1024;
export function capacityCheck(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`source_memory_${code}`);
}
export function validateIndexCapacity(value: unknown): asserts value is SourceIndexCapacity {
  capacityCheck(value && typeof value === "object" && !Array.isArray(value), "capacity_invalid");
  const p = value as SourceIndexCapacity;
  capacityCheck(p.mode === "auto" || p.mode === "fixed", "capacity_invalid");
  const limits = { maxStateBytes: Number.MAX_SAFE_INTEGER, maxScopeBytes: Number.MAX_SAFE_INTEGER,
    reserveDiskBytes: Number.MAX_SAFE_INTEGER, reserveMemoryBytes: Number.MAX_SAFE_INTEGER,
    retrievalExpansionFactor: 64, maxBatchFiles: 500, sliceMs: 120_000, maxSlices: 128, maxDurationMs: 3_600_000 };
  capacityCheck(Object.keys(p).every(k => k === "mode" || k in limits || k === "diskFraction" || k === "memoryFraction"), "capacity_invalid");
  for (const [key, max] of Object.entries(limits)) {
    const n = p[key as keyof SourceIndexCapacity];
    capacityCheck(n === undefined || typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= max, "capacity_invalid");
  }
  for (const n of [p.diskFraction, p.memoryFraction]) capacityCheck(n === undefined || Number.isFinite(n) && n > 0 && n <= 0.5, "capacity_invalid");
  capacityCheck(p.mode !== "fixed" || p.maxStateBytes !== undefined && p.maxScopeBytes !== undefined, "capacity_invalid");
}
/** Recomputed at each batch; explicit ceilings are never raised automatically.
 * Disk budgets are independent of RAM. Memory headroom sizes transient batches.
 * The allowance includes conservative SQLite/cache expansion plus fixed overhead. */
export function indexStorageCapacity(p: SourceIndexCapacity, r: CapacityResources) {
  validateIndexCapacity(p);
  capacityCheck(Object.values(r).every(n => Number.isSafeInteger(n) && n >= 0), "resources_unavailable");
  const diskHeadroom = Math.max(0, r.freeDiskBytes - (p.reserveDiskBytes ?? 1024 * MiB));
  // A share of total disk is stable as the index grows. A fraction of free
  // space added to current usage would ratchet toward consuming the whole disk.
  const automaticState = Math.floor(Math.min(r.stateBytes + diskHeadroom, r.totalDiskBytes * (p.diskFraction ?? 0.1)));
  const stateLimit = Math.min(p.maxStateBytes ?? Number.MAX_SAFE_INTEGER, p.mode === "auto" ? automaticState : Number.MAX_SAFE_INTEGER);
  const scopeLimit = Math.min(p.maxScopeBytes ?? Number.MAX_SAFE_INTEGER, r.scopeBytes + stateLimit - r.stateBytes);
  const growth = Math.min(diskHeadroom, stateLimit - r.stateBytes, scopeLimit - r.scopeBytes);
  capacityCheck(growth >= 0, "capacity_wait");
  return { stateLimit, scopeLimit, growth };
}
export function assertIndexRetrievalMemory(p: SourceIndexCapacity, r: CapacityResources, bytes: number) {
  const usable = Math.max(0, r.availableMemoryBytes - (p.reserveMemoryBytes ?? 256 * MiB)) * (p.memoryFraction ?? 0.2);
  capacityCheck(bytes <= usable / (p.retrievalExpansionFactor ?? 16), "capacity_wait");
}
export function sizeIndexCapacity(p: SourceIndexCapacity, r: CapacityResources, contentCeiling?: number, currentContentBytes = 0) {
  const { stateLimit, scopeLimit, growth } = indexStorageCapacity(p, r);
  const memory = Math.floor(Math.max(0, r.availableMemoryBytes - (p.reserveMemoryBytes ?? 256 * MiB)) * (p.memoryFraction ?? 0.2));
  const perFile = 256_000 * 16;
  capacityCheck(memory >= perFile, "capacity_wait");
  const batchFiles = Math.min(p.maxBatchFiles ?? 100, Math.floor((growth - 8 * MiB) / perFile), Math.floor(memory / perFile));
  capacityCheck(batchFiles >= 1, "capacity_wait");
  // Completion/retrieval materializes the full document set. Batch sizing alone
  // cannot protect that path. Keep room for strings, SQLite rows and two views.
  const maxContentBytes = Math.min(contentCeiling ?? Math.max(currentContentBytes, Math.floor(scopeLimit / 4)), scopeLimit, Math.floor(memory / (p.retrievalExpansionFactor ?? 16)));
  capacityCheck(currentContentBytes <= maxContentBytes, "capacity_wait");
  capacityCheck(maxContentBytes > 0, "capacity_wait");
  return { stateLimit, scopeLimit, maxContentBytes, batchFiles, sliceMs: p.sliceMs ?? 60_000 };
}
/** A worker completion is the only continuation trigger. No timers, provider
 * retries, or task wakes. An error never enters this loop a second time. */
export async function continueSourceIndex<T>(p: SourceIndexCapacity, run: (expected: IndexProgress | undefined, remainingMs: number) => Promise<T | { indexPending: IndexProgress }>, signal?: AbortSignal): Promise<T> {
  const started = performance.now();
  let previous: IndexProgress | undefined;
  for (let slice = 0; slice < (p.maxSlices ?? 32); slice++) {
    capacityCheck(!signal?.aborted, "cancelled");
    const remainingMs = (p.maxDurationMs ?? 600_000) - (performance.now() - started);
    capacityCheck(remainingMs > 0, "continuation_budget");
    const result = await run(previous, Math.ceil(remainingMs));
    if (!(result && typeof result === "object" && "indexPending" in result)) return result as T;
    const next = (result as { indexPending: IndexProgress }).indexPending;
    capacityCheck(/^[a-f0-9]{40}$/.test(next.revision) && /^[a-f0-9]{64}$/.test(next.identity) &&
      Number.isSafeInteger(next.cursor) && Number.isSafeInteger(next.totalFiles) && next.cursor > (previous?.cursor ?? 0) && next.cursor < next.totalFiles &&
      (!previous || next.revision === previous.revision && next.identity === previous.identity && next.totalFiles === previous.totalFiles), "index_no_progress");
    previous = next;
  }
  throw new Error("source_memory_continuation_budget");
}
