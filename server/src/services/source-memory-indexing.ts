import { capacityCheck, assertIndexRetrievalMemory, sizeIndexCapacity, type SourceIndexCapacity, type IndexProgress, type CapacityResources } from "./source-memory-capacity.js";

/** Narrow reader adapter: only committed batches advance the durable cursor. */
export async function refreshSourceIndex(memory: any, scope: unknown, revision: string, policy: SourceIndexCapacity,
  resources: { snapshot(): Promise<CapacityResources>; acquire(): Promise<() => void> }, contentCeiling?: number, expected?: IndexProgress, batchCeiling = 500, needsDocuments = true) {
  const started = performance.now();
  let manifest = memory.repository.manifest(scope, revision);
  if (expected) capacityCheck(manifest && revision === expected.revision && manifest.identity === expected.identity &&
    manifest.cursor >= expected.cursor && manifest.totalFiles === expected.totalFiles, "index_progress_changed");
  if (manifest?.status === "complete") {
    capacityCheck(contentCeiling === undefined || manifest.bytes <= contentCeiling, "index_budget");
    if (needsDocuments) {
      assertIndexRetrievalMemory(policy, await resources.snapshot(), manifest.bytes);
    }
    // Reading an immutable completed index neither grows it nor grants a new
    // content allocation. Avoid reverting an auto-sized manifest to 128 MiB.
    memory.knowledge.maxContentBytes = Math.max(manifest.bytes, manifest.maxContentBytes ?? 0);
    const result = await memory.refresh(scope, { oneBatch: true });
    return { blobReads: result.blobReads };
  }
  // Completed scopes never contend with another company's index growth. The
  // lease ends before full document retrieval and runtime observation writes.
  const release = await resources.acquire();
  try {
  let reads = 0;
  while (true) {
    const capacity = sizeIndexCapacity(policy, await resources.snapshot(), contentCeiling, manifest?.bytes ?? 0);
    memory.knowledge.maxContentBytes = capacity.maxContentBytes;
    const previousCursor = manifest?.cursor ?? 0;
    const result = await memory.refresh(scope, { batchSize: Math.min(capacity.batchFiles, batchCeiling), oneBatch: true });
    reads += result.blobReads;
    manifest = memory.repository.manifest(scope, revision);
    capacityCheck(manifest && manifest.revision === revision, "index_progress_changed");
    const after = await resources.snapshot();
    capacityCheck(after.stateBytes <= capacity.stateLimit && after.scopeBytes <= capacity.scopeLimit, "capacity_wait");
    if (manifest.status === "complete") return { blobReads: reads };
    capacityCheck(manifest.cursor > previousCursor, "index_no_progress");
    if (performance.now() - started >= capacity.sliceMs) return { indexPending: {
      revision, identity: manifest.identity, cursor: manifest.cursor, totalFiles: manifest.totalFiles,
    }, blobReads: reads };
  }
  } finally { release(); }
}
