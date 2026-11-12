import { describe, it, expect, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { NativeCompletionValidationError } from "./completion-validation.js";
import { nativeSessionFailureSourceCode, nativeSessionFailureDisposition } from "./native-session-executor.js";
import { consumeSourceCitations } from "../source-citation-consumer.js";
import type { SourceMemoryEvidence } from "../source-memory.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";

// No paid/model driver. A fake controller drives the real completion port and
// executor failure classifier. Full dispatch/cleanup is a separate operator gate.
describe('native source completion rejection (never-paid controller)', () => {
  it('coalesces refused completion reads, inserts no accepted result and produces a terminal no-retry disposition', async () => {
    let reads = 0, guards = 0;
    const transaction = vi.fn(async () => { throw new Error('acceptance transaction must not run'); });
    const fullSha = 'a'.repeat(40), sha256 = 'b'.repeat(64), scope = { companyId: 'company', projectId: 'project', repositoryId: 'github.com/synthetic/completion' };
    const citation = { ...scope, revision: fullSha, path: 'example.ts', startLine: 1, endLine: 1, sha256 };
    const current = { schema: 1, scope, revision: fullSha, citations: [{ content: 'synthetic\n', standing: 'verified_source_range', citation }] } as SourceMemoryEvidence;
    const submitted = { repo: scope.repositoryId, fullSha, path: citation.path, startLine: 1, endLine: 1, sha256, mode: 'current' as const };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, sourceCitations: [
      ...Array.from({ length: 19 }, () => submitted), { ...submitted, sha256: 'c'.repeat(64) },
    ] };
    const port = new PaperclipControlPlanePort({ transaction } as unknown as Db,
      {} as ConstructorParameters<typeof PaperclipControlPlanePort>[1], { beforeCompleteRun: async value => {
        guards++;
        const verdict = await consumeSourceCitations({ submitted: value.sourceCitations, current,
          authorize: async () => ({ ...scope, frozenSha: fullSha }),
          read: async () => { reads++; return citation; } });
        if (!verdict.currentSatisfied) throw new NativeCompletionValidationError('source_citation_rejected');
      } });
    const value = { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL };
    const complete = () => port.completeRun(value);
    const attempts = await Promise.allSettled([complete(), complete()]);
    expect(attempts.every(attempt => attempt.status === 'rejected')).toBe(true);
    await expect(complete()).rejects.toBeInstanceOf(NativeCompletionValidationError);
    expect(guards).toBe(1); expect(reads).toBe(19); expect(transaction).not.toHaveBeenCalled();
    const refusal = (attempts[0] as PromiseRejectedResult).reason;
    const code = nativeSessionFailureSourceCode(refusal);
    expect(code).toBe('native_completion_validation_rejected');
    expect(nativeSessionFailureDisposition(1, new Date(0), code)).toEqual({
      phase: 'terminal_failure', failureCode: 'native_completion_validation_rejected', nextAttemptAt: null,
    });
    await expect(port.completeRun({ ...value, result: { ...result, sourceCitations: [] } })).rejects.toThrow('structured_result_replay_conflict');
    expect(reads).toBe(19);
  });
  it('classifies only a trusted validation error, including a bounded wrapped cause', () => {
    const error = new NativeCompletionValidationError('source_citation_rejected');
    expect(nativeSessionFailureSourceCode(error)).toBe('native_completion_validation_rejected');
    expect(nativeSessionFailureSourceCode(new Error('controller failed', { cause: error }))).toBe('native_completion_validation_rejected');
    expect(nativeSessionFailureSourceCode(new Error('source_citation_rejected native_completion_validation_rejected'))).toBe('native_session_interrupted');
  });
  it('aborted controller admits no read or acceptance transaction', async () => {
    const guard = vi.fn(async () => {}), transaction = vi.fn(async () => {});
    const port = new PaperclipControlPlanePort({ transaction } as unknown as Db,
      {} as ConstructorParameters<typeof PaperclipControlPlanePort>[1], { beforeCompleteRun: guard });
    const abort = new AbortController(); abort.abort(new Error('synthetic Stop'));
    await expect(port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL }, { signal: abort.signal })).rejects.toThrow('synthetic Stop');
    expect(guard).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
  });
});
