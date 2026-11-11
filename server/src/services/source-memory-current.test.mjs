import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/source-memory.js') || specifier.endsWith('/source-memory-remote.js') || specifier.endsWith('/source-citation-consumer.js') || specifier.endsWith('/source-citation-reader.js')) specifier = specifier.slice(0, -3) + '.ts';
  return next(specifier, context);
} });
const actual = await import('./source-memory.ts');
const { assertCurrentSourceCitation, selectSourceCitations, sourceMemoryMarkdown } = actual;
const revision = 'a'.repeat(40);
const citation = { companyId: 'company', projectId: 'project', repositoryId: 'github.com/example/permitted', revision,
  path: 'src/example.ts', startLine: 1, endLine: 2, sha256: 'b'.repeat(64) };
const evidence = { schema: 1, scope: { companyId: 'company', projectId: 'project', repositoryId: citation.repositoryId }, revision,
  citations: [{ content: 'synthetic source\n', citation, standing: 'verified_source_range' }] };
let returned = evidence, reads = 0;
mock.module('./source-memory.ts', { namedExports: { ...actual, prepareSourceMemory: async () => { reads++; return structuredClone(returned); } } });
const { prepareHeartbeatSourceMemory } = await import('./heartbeat/source-memory.ts');

test('all phase admissions and dispatch reject unauthorized or changed evidence', async t => {
  const saved = process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
  process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = '/synthetic/not-read-by-fixture';
  try {
    for (const phase of ['planning', 'implementation', 'review']) await t.test(phase, async () => {
      let allowed = true;
      const input = { identity: { companyId: 'company', projectId: 'project', issueId: 'task', runId: 'run', phase },
        workspace: { cwd: '/synthetic', repoUrl: 'https://github.com/example/permitted' }, recovering: false,
        authority: null, remote: null, assertOwned: async () => {}, readAuthority: async () => null,
        recordRevision: async () => {}, frozenRevision: revision, authorize: async () => { if (!allowed) throw Error('revoked_access'); return { ...evidence.scope, frozenSha: revision }; } };
      returned = evidence;
      const prepared = await prepareHeartbeatSourceMemory(input);
      await prepared.beforeDispatch();
      const submitted = { repo: citation.repositoryId, fullSha: revision, path: citation.path, startLine: citation.startLine,
        endLine: citation.endLine, sha256: citation.sha256, mode: 'current' };
      const result = { resultJson: { sourceCitations: [submitted] } };
      await prepared.consumeResult(result);
      assert.equal(result.resultJson.sourceCurrentEvidenceSatisfied, true);
      const historical = { resultJson: { sourceCitations: [{ ...submitted, mode: 'historical' }] } };
      await prepared.consumeResult(historical);
      assert.equal(historical.resultJson.sourceCitationResults[0].reason, 'verified_historical');
      assert.equal(historical.errorCode, phase === 'review' ? 'source_citation_rejected' : undefined);
      const bad = { resultJson: { sourceCitations: [{ ...submitted, endLine: 3 }] } };
      await prepared.consumeResult(bad);
      assert.equal(bad.exitCode, 1);
      assert.equal(bad.resultJson.sourceCitationResults[0].reason, 'citation_mismatch');
      assert.match(sourceMemoryMarkdown(prepared.evidence), /Maintained source evidence/);
      for (const changed of [{ revision: 'c'.repeat(40) }, { sha256: 'c'.repeat(64) }, { endLine: 3 },
        { companyId: 'other' }, { repositoryId: 'github.com/example/unauthorized' }]) {
        assert.throws(() => assertCurrentSourceCitation(prepared.evidence, { ...citation, ...changed }));
      }
      // Malformed reader receipts are rejected on admission, not published into prompts.
      returned = { ...evidence, citations: [{ ...evidence.citations[0], citation: { ...citation, companyId: 'other' } }] };
      await assert.rejects(prepareHeartbeatSourceMemory(input), /stale_citation/);
      returned = evidence;
      if (phase === 'review') await assert.rejects(prepareHeartbeatSourceMemory({ ...input, frozenRevision: 'd'.repeat(40) }), /wrong_task_revision/);
      allowed = false;
      const before = reads;
      await assert.rejects(prepareHeartbeatSourceMemory(input), /revoked_access/);
      assert.equal(reads, before, 'authorization must precede retrieval');
      await assert.rejects(prepared.beforeDispatch(), /revoked_access/);
      assert.equal(reads, before, 'revocation must precede dispatch verification');
    });
    await t.test('recovery and disabled citations fail closed without reader I/O', async () => {
      const before = reads;
      for (const configured of [true, false]) {
        if (!configured) delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
        const prepared = await prepareHeartbeatSourceMemory({ recovering: true, identity: {phase:'review'} });
        const result = {resultJson:{sourceCitations:[{mode:'historical'}]}};
        await prepared.consumeResult(result);
        assert.equal(result.errorCode,'source_citation_rejected');
        assert.equal(result.resultJson.sourceCurrentEvidenceSatisfied,false);
      }
      assert.equal(reads,before);
      process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = '/synthetic/not-read-by-fixture';
    });
    await t.test('historical selection is explicit and cannot substitute another revision', () => {
      assert.equal(selectSourceCitations(evidence, { mode: 'historical', revision }).mode, 'historical');
      assert.throws(() => selectSourceCitations(evidence, { mode: 'current', revision: 'e'.repeat(40) }), /stale_citation/);
      assert.throws(() => selectSourceCitations(evidence, { mode: 'implicit', revision }), /retrieval_mode_invalid/);
    });
  } finally { if (saved === undefined) delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG; else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG = saved; }
});
