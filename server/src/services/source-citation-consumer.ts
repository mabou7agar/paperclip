import { assertCurrentSourceCitation, type SourceMemoryEvidence } from "./source-memory.js";

export type SubmittedSourceCitation = {
  repo: string; fullSha: string; path: string; startLine: number; endLine: number;
  sha256: string; mode: "current" | "historical"; receiptId?: string;
};
export type SourceCitationResult = {
  index: number; status: "accepted" | "rejected"; reason: string;
  mode?: "current" | "historical"; satisfiesCurrent: boolean;
};
export class SourceCitationError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}
export type CitationBinding = {
  companyId: string; projectId: string; repositoryId: string; frozenSha: string;
};
const fail = (reason: string): never => { throw new SourceCitationError(reason); };

/** The repository check is part of authorization, before the reader sees a path or SHA. */
export function assertSourceCitationBinding(binding: CitationBinding, citation: SubmittedSourceCitation) {
  if (binding.repositoryId !== citation.repo) fail("repository_denied");
  if (!/^[a-f0-9]{40}$/.test(binding.frozenSha)) fail("task_snapshot_unavailable");
  if (citation.mode === "current" && citation.fullSha !== binding.frozenSha) fail("wrong_task_sha");
}

function submitted(value: unknown): SubmittedSourceCitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_citation");
  const c = value as SubmittedSourceCitation;
  if ((c.mode !== "current" && c.mode !== "historical") || typeof c.repo !== "string" || c.repo.length > 512 ||
      typeof c.fullSha !== "string" || !/^[a-f0-9]{40}$/.test(c.fullSha) ||
      typeof c.path !== "string" || c.path.length > 1024 || c.path.includes("\0") || c.path.includes("\\") ||
      c.path.split("/").some(part => !part || part === "." || part === "..") ||
      !Number.isSafeInteger(c.startLine) || !Number.isSafeInteger(c.endLine) || c.startLine < 1 ||
      c.endLine < c.startLine || c.endLine - c.startLine >= 40 ||
      typeof c.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(c.sha256) ||
      (c.receiptId !== undefined && (typeof c.receiptId !== "string" || c.receiptId.length > 128))) fail("invalid_citation");
  return c;
}

/** Only structured resultJson.sourceCitations is consumed. Never scan provider text.
 * Authorization is invoked independently for each item, including historical items.
 * I/O failures are sanitized and fail closed; a failed batch never becomes current evidence.
 */
export async function consumeSourceCitations(input: {
  submitted: unknown;
  current: SourceMemoryEvidence | null;
  authorize: () => Promise<CitationBinding>;
  read: (citation: SubmittedSourceCitation, binding: CitationBinding) => Promise<Record<string, unknown>>;
}) {
  const results: SourceCitationResult[] = [];
  const values = input.submitted === undefined ? [] : Array.isArray(input.submitted) ? input.submitted : [null];
  if (values.length > 20) return { results: [{ index: 0, status: "rejected" as const, reason: "citation_budget", satisfiesCurrent: false }], currentSatisfied: false };
  for (const [index, raw] of values.entries()) {
    let mode: SubmittedSourceCitation["mode"] | undefined;
    try {
      const c = submitted(raw); mode = c.mode;
      const binding = await input.authorize();
      assertSourceCitationBinding(binding, c);
      const normalized = { companyId: binding.companyId, projectId: binding.projectId, repositoryId: binding.repositoryId,
        revision: c.fullSha, path: c.path, startLine: c.startLine, endLine: c.endLine, sha256: c.sha256 };
      if (mode === "current") {
        if (!input.current || input.current.revision !== binding.frozenSha ||
            input.current.scope.companyId !== binding.companyId || input.current.scope.projectId !== binding.projectId ||
            input.current.scope.repositoryId !== binding.repositoryId) fail("wrong_task_sha");
        try { assertCurrentSourceCitation(input.current, normalized); } catch { fail("citation_mismatch"); }
      }
      const verified = await input.read(c, binding);
      if (Object.entries(normalized).some(([key, value]) => verified[key] !== value)) fail("citation_mismatch");
      // Recheck revocation after the bounded read before accepting source bytes.
      const after = await input.authorize();
      assertSourceCitationBinding(after, c);
      if (JSON.stringify(after) !== JSON.stringify(binding)) fail("binding_changed");
      results.push({ index, status: "accepted", reason: mode === "current" ? "verified_current" : "verified_historical", mode, satisfiesCurrent: mode === "current" });
    } catch (error) {
      const reason = error instanceof SourceCitationError ? error.reason : "authorization_or_reader_denied";
      results.push({ index, status: "rejected", reason, ...(mode ? { mode } : {}), satisfiesCurrent: false });
    }
  }
  return { results, currentSatisfied: results.length > 0 && results.every(r => r.status === "accepted") && results.some(r => r.satisfiesCurrent) };
}
