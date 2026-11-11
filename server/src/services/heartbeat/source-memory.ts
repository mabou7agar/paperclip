import { prepareSourceMemory, assertCurrentSourceCitation, sourceMemoryRepositoryId, sourceMemoryBindingEnabled, type SourceMemoryInput } from "../source-memory.js";
import { consumeSourceCitations, type CitationBinding } from "../source-citation-consumer.js";
import { createRemoteSourceReader } from "../source-memory-remote.js";

type Authority = {
  epoch: number; writerRunId: string | null;
  location?: { remoteCwd: string; providerLeaseId: string; leaseId: string } | null;
};
type Remote = Parameters<typeof createRemoteSourceReader>[0];
type Completion = { resultJson?: Record<string, unknown> | null; exitCode?: number | null; errorMessage?: string | null; errorCode?: string | null };

/** Phase evidence owns no execution authority: the existing run/workspace owners supply it. */
export async function prepareHeartbeatSourceMemory(input: {
  identity: Omit<SourceMemoryInput, "cwd" | "repoUrl" | "remoteAuthority">;
  workspace: { cwd: string; repoUrl: string | null };
  recovering: boolean;
  persistedWorkspaceId: string | null;
  authorize: (admission?: boolean) => Promise<CitationBinding>;
  recordRevision: (revision: string) => Promise<void>;
  frozenRevision?: string | null;
  frozenScope?: { companyId: string; projectId: string; repositoryId: string } | null;
  authority: Authority | null;
  remote: Pick<Remote, "execute" | "baseCwd"> | null;
  assertOwned: () => Promise<void>;
  readAuthority: () => Promise<Authority | null>;
}) {
  const unavailable = (reason: string) => ({
    evidence: null, beforeDispatch: async () => {}, observeCommit: async () => {},
    consumeResult: async (result: Completion) => {
      const submitted = result.resultJson?.sourceCitations;
      const required = reason === "recovery_snapshot_unverified" && input.identity.phase === "review";
      if (submitted === undefined && !required) return;
      if (Array.isArray(submitted) && submitted.length === 0 && !required) return;
      result.resultJson = { ...result.resultJson, sourceCurrentEvidenceSatisfied: false,
        sourceCitationResults: [{ index: 0, status: "rejected", reason, satisfiesCurrent: false }] };
      result.exitCode = 1; result.errorCode = "source_citation_rejected";
      result.errorMessage = "Required current source citations were not verified.";
    },
  });
  if (!process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG) return unavailable("source_memory_unconfigured");
  // Filter before task authorization: an opt-in for one repository cannot affect
  // unrelated companies, directory workspaces, or ephemeral workspace records.
  if (!input.persistedWorkspaceId || !await sourceMemoryBindingEnabled({ ...input.identity, repoUrl: input.workspace.repoUrl })) {
    return unavailable("source_memory_unbound");
  }
  // Recovery never trusts the new workspace as the completed run's old snapshot.
  // Until its saved reader/authority can be verified, citations fail closed.
  if (input.recovering) return unavailable("recovery_snapshot_unverified");
  const admitted = await input.authorize(true);
  if (admitted.companyId !== input.identity.companyId || admitted.projectId !== input.identity.projectId ||
      !input.workspace.repoUrl || admitted.repositoryId !== sourceMemoryRepositoryId(input.workspace.repoUrl)) {
    throw new Error("source_memory_binding_changed");
  }
  if (input.identity.phase === "review") {
    if (!input.frozenRevision) throw new Error("source_memory_review_candidate_missing");
    if (input.frozenScope && (input.frozenScope.companyId !== admitted.companyId || input.frozenScope.projectId !== admitted.projectId ||
        input.frozenScope.repositoryId !== admitted.repositoryId)) throw new Error("source_memory_binding_changed");
  }
  const source: SourceMemoryInput = { ...input.identity,
    cwd: input.authority?.location?.remoteCwd ?? input.workspace.cwd,
    repoUrl: input.workspace.repoUrl, remoteAuthority: Boolean(input.authority) };
  const expected = input.authority;
  let stopped = false;
  const remoteRead = expected?.location && input.remote ? createRemoteSourceReader({
    cwd: expected.location.remoteCwd, ...input.remote,
    assertOwned: async () => {
      input.identity.signal?.throwIfAborted();
      await input.assertOwned();
      const current = await input.readAuthority();
      if (expected.writerRunId !== input.identity.runId || !current || current.epoch !== expected.epoch ||
          (current.writerRunId !== input.identity.runId && !(stopped && current.writerRunId === null)) ||
          current.location?.leaseId !== expected.location!.leaseId ||
          current.location?.providerLeaseId !== expected.location!.providerLeaseId ||
          current.location?.remoteCwd !== expected.location!.remoteCwd) {
        throw new Error("source_memory_remote_authority_changed");
      }
    },
  }) : undefined;
  const evidence = await prepareSourceMemory(source, "phase", undefined, remoteRead);
  if (!evidence) return unavailable("source_memory_unbound");
  if (evidence) {
    if (input.identity.phase === "review" && input.frozenRevision && evidence.revision !== input.frozenRevision) throw new Error("source_memory_wrong_task_revision");
    await input.recordRevision(evidence.revision);
  }
  const binding = evidence ? await input.authorize() : admitted;
  const validate = () => {
    if (!evidence) return;
    if (evidence.revision !== binding.frozenSha || (input.identity.phase === "review" && input.frozenRevision && evidence.revision !== input.frozenRevision)) throw new Error("source_memory_wrong_task_revision");
    for (const hit of evidence.citations) assertCurrentSourceCitation(evidence, hit.citation);
  };
  validate();
  return { evidence, consumeResult: async (result: Completion) => {
    stopped = true;
    const report = await consumeSourceCitations({ submitted: result.resultJson?.sourceCitations, current: evidence,
      authorize: input.authorize,
      read: async (citation, currentBinding) => {
        if (currentBinding.repositoryId !== binding.repositoryId || currentBinding.projectId !== binding.projectId || currentBinding.companyId !== binding.companyId) throw new Error("source_memory_binding_changed");
        const receipt = await prepareSourceMemory(source, "citation", undefined, remoteRead, undefined,
          { revision: citation.fullSha, path: citation.path, startLine: citation.startLine, endLine: citation.endLine });
        const verified = receipt?.citations[0]?.citation;
        if (!verified) throw new Error("source_memory_citation_unverified");
        return verified;
      } });
    result.resultJson = { ...result.resultJson, sourceCitationResults: report.results, sourceCurrentEvidenceSatisfied: report.currentSatisfied };
    if (report.results.some(item => item.status === "rejected") ||
        (input.identity.phase === "review" && evidence && !report.currentSatisfied)) {
      result.exitCode = 1; result.errorCode = "source_citation_rejected";
      result.errorMessage = "Required current source citations were not verified.";
    }
  }, beforeDispatch: async () => {
    const currentBinding = await input.authorize(!evidence);
    if (JSON.stringify(currentBinding) !== JSON.stringify(binding)) throw new Error("source_memory_binding_changed");
    validate();
    if (evidence && !await prepareSourceMemory(source, "verify", undefined, remoteRead, evidence)) throw new Error("source_memory_configuration_changed");
  }, observeCommit: async () => { stopped = true; await input.authorize(!evidence); await prepareSourceMemory(source, "commit", undefined, remoteRead); } };
}
