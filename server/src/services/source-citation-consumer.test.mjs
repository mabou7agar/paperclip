import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(s, c, next) {
  if (s.endsWith('.js') && s.startsWith('.') && c.parentURL) {
    const candidate = new URL(s.slice(0, -3) + '.ts', c.parentURL);
    if (existsSync(fileURLToPath(candidate))) return next(candidate.href, c);
  }
  return next(s, c);
} });
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const path = (await import('node:path')).default;
const { execFileSync, execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const { createHash } = await import('node:crypto');
const { consumeSourceCitations } = await import('./source-citation-consumer.ts');
const { readSourceCitationFromGit } = await import('./source-citation-reader.ts');
const { authorizeSourceCitation, syntheticAuthorizationStore, PaperclipControlPlanePort } = await import('./test-fixtures/source-citation-authorization.mjs');

test('structured consumption uses real task/workspace/access authorization with synthetic storage and Git', async t => {
  const repo = await mkdtemp(path.join(tmpdir(), 'osa433-citations-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const saved = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = 'off';
  try {
    git('init', '-q');
    const commit = content => { git('add', '.'); git('-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', content); return git('rev-parse', 'HEAD'); };
    const old = 'old line\nsecond line\n'; await writeFile(path.join(repo, 'example.ts'), old); const historicalSha = commit('historical');
    const currentContent = 'current line\nsecond line\n'; await writeFile(path.join(repo, 'example.ts'), currentContent); const fullSha = commit('current');
    const companyId = 'synthetic-company', projectId = 'project', issueId = 'task', workspaceId = 'workspace', runId = 'run', agentId = 'agent';
    const rows = {
      agents: [{ id: agentId, companyId, permissions: null }],
      heartbeatRuns: [{ id: runId, companyId, agentId, issueId, responsibleUserId: null, contextSnapshot: { sourceSnapshot: { workspaceId, revision: fullSha } }, status: 'running' }],
      issues: [{ id: issueId, companyId, projectId, executionWorkspaceId: workspaceId, projectWorkspaceId: 'source', workspaceSelection: null, workspacePendingSelection: null, workspaceBindingRevision: 0, executionPolicy: null }],
      projects: [{ id: projectId, companyId, executionWorkspacePolicy: null }],
      executionWorkspaces: [{ id: workspaceId, companyId, projectId, projectWorkspaceId: 'source', baseRef: "main", repoUrl: 'https://github.com/example/permitted' }],
      projectWorkspaces: [{ id: 'source', companyId, projectId, repoUrl: 'https://github.com/example/permitted' }],
    };
    const { db, reads } = syntheticAuthorizationStore(rows);
    const actor = { type: 'agent', source: 'agent_jwt', agentId, runId, companyId, onBehalfOfUserId: null };
    const authorize = () => authorizeSourceCitation(db, actor, { companyId, issueId, workspaceId });
    const scope = { companyId, projectId, repositoryId: 'github.com/example/permitted' };
    const c = { repo: scope.repositoryId, fullSha, path: 'example.ts', startLine: 1, endLine: 2, sha256: createHash('sha256').update(currentContent).digest('hex'), mode: 'current' };
    const normalized = { ...scope, revision: fullSha, path: c.path, startLine: 1, endLine: 2, sha256: c.sha256 };
    const current = { scope, revision: fullSha, citations: [{ citation: normalized }] };
    let gitReads = 0;
    const read = (citation, binding) => readSourceCitationFromGit({ companyId: binding.companyId, projectId: binding.projectId, repositoryId: binding.repositoryId }, { revision: citation.fullSha, path: citation.path, startLine: citation.startLine, endLine: citation.endLine }, async (args, input, maxBuffer) => {
      gitReads++;
      return new Promise((resolve, reject) => {
        const child = execFile('git', ['-C', repo, ...args], { encoding: 'buffer', timeout: 15000, maxBuffer, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }, (error, out) => error ? reject(error) : resolve(out));
        child.stdin.end(input);
      });
    });
    const consume = submitted => consumeSourceCitations({ submitted, current, authorize, read });
    await t.test('fresh current passes through the real authorization gate and immutable Git reader', async () => {
      await authorize();
      const result = await consume([c]);
      assert.deepEqual(result.results, [{ index: 0, status: 'accepted', reason: 'verified_current', mode: 'current', satisfiesCurrent: true }]);
      assert.equal(result.currentSatisfied, true); assert.ok(reads.includes('agents') && reads.includes('issues') && reads.includes('projectWorkspaces'));
    });
    for (const [name, change, reason] of [
      ['stale SHA', { fullSha: historicalSha }, 'wrong_task_sha'],
      ['altered hash', { sha256: 'f'.repeat(64) }, 'citation_mismatch'],
      ['altered range', { endLine: 3 }, 'citation_mismatch'],
      ['same-company unauthorized repository', { repo: 'github.com/example/other' }, 'repository_denied'],
    ]) await t.test(name, async () => { const before = gitReads; const r = await consume([{ ...c, ...change }]); assert.equal(r.results[0].reason, reason); assert.equal(r.currentSatisfied, false); assert.equal(gitReads, before); });
    await t.test('wrong frozen task SHA fails', async () => {
      rows.heartbeatRuns[0].contextSnapshot.sourceSnapshot.revision = historicalSha;
      assert.equal((await consume([c])).results[0].reason, 'wrong_task_sha');
      rows.heartbeatRuns[0].contextSnapshot.sourceSnapshot.revision = fullSha;
    });
    await t.test('wrong company fails through the real authorization gate before Git', async () => {
      actor.companyId = 'other'; const before = gitReads;
      const r = await consume([c]); assert.equal(r.results[0].status, 'rejected'); assert.equal(gitReads, before);
      actor.companyId = companyId;
    });
    await t.test('revoked agent access fails at consumption', async () => {
      const agent = rows.agents.pop(), before = gitReads;
      assert.equal((await consume([c])).results[0].status, 'rejected'); assert.equal(gitReads, before); rows.agents.push(agent);
    });
    await t.test('revocation during the Git read rejects publication', async () => {
      let removed;
      const verdict = await consumeSourceCitations({ submitted: [c], current, authorize,
        read: async (...args) => { const result = await read(...args); removed = rows.agents.pop(); return result; } });
      assert.equal(verdict.results[0].status, 'rejected'); assert.equal(verdict.currentSatisfied, false);
      rows.agents.push(removed);
    });
    await t.test('explicit authorized historical lookup passes and cannot satisfy current requirement', async () => {
      const r = await consume([{ ...c, mode: 'historical', fullSha: historicalSha, sha256: createHash('sha256').update(old).digest('hex') }]);
      assert.equal(r.results[0].reason, 'verified_historical'); assert.equal(r.results[0].mode, 'historical'); assert.equal(r.currentSatisfied, false);
    });
    await t.test('native completion refuses rejected citations before accepted-result transaction', async () => {
      let transactions = 0, validations = 0;
      const db = { transaction: async () => { transactions++; throw Error('transaction-reached'); } };
      const terminal = { schema: 'paperclip.prp.terminal.v1', turnTerminalState: 'completed', runTerminalState: 'succeeded', reportedWorkDisposition: 'done' };
      const value = { result: { reportedWorkDisposition: 'done', sourceCitations: [{ ...c, sha256: 'f'.repeat(64) }] }, terminal };
      const port = new PaperclipControlPlanePort(db, {}, { beforeCompleteRun: async result => {
        validations++;
        const verdict = await consume(result.sourceCitations);
        if (!verdict.currentSatisfied) throw Error('source_citation_rejected');
      } });
      await assert.rejects(port.completeRun(value), /source_citation_rejected/);
      assert.equal(validations, 1); assert.equal(transactions, 0);
      // Old saved/recovered execution has no new hook and follows the existing
      // transaction path; no completion/schema migration is implied.
      const previous = new PaperclipControlPlanePort(db, {});
      await assert.rejects(previous.completeRun(value), /transaction-reached/);
      assert.equal(transactions, 1);
    });
    await t.test('missing/invalid mode, invalid path and oversized batch fail closed', async () => {
      for (const bad of [{ ...c, mode: undefined }, { ...c, path: '../example.ts' }, { ...c, fullSha: 'HEAD' }]) assert.equal((await consume([bad])).results[0].reason, 'invalid_citation');
      assert.equal((await consume(Array(21).fill(c))).results[0].reason, 'citation_budget');
    });
  } finally {
    if (saved === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE; else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = saved;
    await rm(repo, { recursive: true, force: true });
  }
});
