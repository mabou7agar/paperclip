/** Reference material never confers current-candidate or review standing. */
export type SourceReferenceScope = { companyId: string; projectId: string; repositoryId: string };
export type SourceReferenceTarget = SourceReferenceScope & { consumerProjectId: string; revision: string };
export type SourceReferenceHit = { path: string; startLine: number; endLine: number; content: string; indexedContentSha256: string };
export type SourceReferenceBundle = { schema: 1; standing: "reference"; indexedScope: SourceReferenceScope; revision: string; hits: SourceReferenceHit[]; blobReads: 0; indexRefreshes: 0 };
export type SourceReferenceLookup = { schema: 1; status: "available" | "partial" | "unavailable" | "no_matches"; references: SourceReferenceBundle[]; blobReads: 0; indexRefreshes: 0 };
export const SOURCE_REFERENCE_LIMITS = { targets: 4, terms: 6, hits: 2, contentBytes: 2048, lines: 35, durationMs: 6000, markdownBytes: 24576 } as const;
export function referenceCheck(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`source_memory_reference_${reason}`);
}
export function referenceTerms(query: string) {
  const stop = new Set(["the", "for", "with", "from", "that", "this", "task", "implement", "make", "using", "need", "should", "please", "review", "source", "after", "without"]);
  return [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_./-]+/gu) ?? [])
    .filter(word => word.length >= 3 && word.length <= 64 && !stop.has(word)))].slice(0, SOURCE_REFERENCE_LIMITS.terms);
}
export function referenceTargets(raw: unknown, consumer: {companyId: string; projectId: string}) {
  if (raw === undefined) return [];
  referenceCheck(Array.isArray(raw) && raw.length <= 1024, "configuration_invalid");
  const selected = raw.filter(value => value?.companyId === consumer.companyId && value?.consumerProjectId === consumer.projectId);
  referenceCheck(selected.length <= SOURCE_REFERENCE_LIMITS.targets, "target_budget");
  const ids = new Set<string>();
  for (const row of selected) {
    referenceCheck([row.companyId, row.projectId, row.consumerProjectId].every(v => typeof v === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(v)) &&
      typeof row.repositoryId === "string" && row.repositoryId.length<=512 && /^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(row.repositoryId) && typeof row.revision === "string" && /^[a-f0-9]{40}$/.test(row.revision), "configuration_invalid");
    const key = JSON.stringify([row.projectId, row.repositoryId]);
    referenceCheck(!ids.has(key), "ambiguous_target"); ids.add(key);
  }
  return selected as SourceReferenceTarget[];
}

export type SourceReferenceUsage = {schema:1;status:SourceReferenceLookup["status"];referenceTargets:number;hits:number;blobReads:0;indexRefreshes:0};
