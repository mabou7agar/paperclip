import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingComment } from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

for (const login of ['commitperclip[bot]', 'commitperclip', 'github-actions[bot]']) {
  test(`findExistingComment: reuses the signed report from ${login}`, async () => {
    const existing = { id: 7, user: { login }, body: 'Status\n\n— commitperclip' };
    const result = await findExistingComment(async () => [existing], 'token', 'owner/repo', 3);
    assert.equal(result, existing);
  });
}

test('findExistingComment: ignores forged human signatures and unrelated bot reports', async () => {
  const result = await findExistingComment(async () => [
    { id: 1, user: { login: 'someone-else' }, body: '— commitperclip' },
    { id: 2, user: { login: 'github-actions[bot]' }, body: 'Another workflow report' },
    { id: 3, user: null, body: '— commitperclip' },
  ], 'token', 'owner/repo', 3);
  assert.equal(result, null);
});

// Exercise the real CLI against a stubbed GitHub transport, without publishing
// comments or using a credential/provider as a test fixture.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const scenario of ['new-failure', 'existing-failure', 'existing-success']) {
  test(`quality CLI: ${scenario} keeps one report and the correct exit status`, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'quality-cli-'));
    try {
      const receipts = join(scratch, 'receipts.json');
      const preload = join(scratch, 'github-stub.mjs');
      writeFileSync(preload, `
        import assert from 'node:assert/strict';
        import { writeFileSync } from 'node:fs';
        const calls = [];
        const scenario = process.env.TEST_SCENARIO;
        const validBody = [
          '## Thinking Path', '> - Paperclip coordinates work.',
          '> - Quality gates inspect pull requests.', '> - This change fixes authentication.',
          '## Linked Issues or Issue Description', 'Refs: #3.',
          '## What Changed', 'Use the repository token.',
          '## Verification', 'Run isolated CLI checks.',
          '## Risks', 'Preserve trusted execution.',
          '## Model Used', 'OpenAI Codex coding agent.',
          '## Checklist', '- [x] I searched for similar PRs.'
        ].join('\\n');
        globalThis.fetch = async (url, options) => {
          const path = new URL(url).pathname;
          assert.equal(new URL(url).origin, 'https://api.github.com');
          const method = options.method ?? 'GET';
          calls.push({ path, method, body: options.body ? JSON.parse(options.body) : undefined });
          let data;
          if (method === 'GET' && path === '/repos/owner/repo/pulls/3') {
            data = { body: scenario === 'existing-success' ? validBody : '',
              title: 'fix: quality authentication', user: { login: 'author' },
              head: { ref: 'fix/quality' }, base: { ref: 'master' } };
          } else if (method === 'GET' && path.endsWith('/files')) {
            data = [{ filename: 'scripts/quality.test.mjs', status: 'modified' }];
          } else if (method === 'GET' && path.endsWith('/commits')) {
            data = [];
          } else if (method === 'GET' && path.endsWith('/comments')) {
            data = scenario === 'new-failure' ? [] : [{ id: 42,
              user: { login: 'github-actions[bot]' }, body: 'Prior report\\n— commitperclip' }];
          } else if (method === 'POST' && path === '/repos/owner/repo/issues/3/comments') {
            data = { id: 43 };
          } else if (method === 'PATCH' && path === '/repos/owner/repo/issues/comments/42') {
            data = { id: 42 };
          } else { throw new Error('Unexpected GitHub request: ' + method + ' ' + path); }
          return new Response(JSON.stringify(data), { status: 200 });
        };
        process.on('exit', () => writeFileSync(process.env.TEST_RECEIPTS, JSON.stringify(calls)));
      `);
      const result = spawnSync(process.execPath, [
        '--import', preload, fileURLToPath(new URL('../run-quality-gates.mjs', import.meta.url)),
      ], {
        env: { ...process.env, GH_TOKEN: 'isolated-test-token', GH_REPO: 'owner/repo',
          PR_NUMBER: '3', PR_AUTHOR: 'author', PR_BRANCH: 'fix/quality',
          TEST_SCENARIO: scenario, TEST_RECEIPTS: receipts },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, scenario === 'existing-success' ? 0 : 1, result.stderr);
      const report = JSON.parse(result.stdout.trim());
      assert.equal(report.passed, scenario === 'existing-success');
      const mutations = JSON.parse(readFileSync(receipts, 'utf8')).filter(c => c.method !== 'GET');
      assert.equal(mutations.length, 1);
      assert.equal(mutations[0].method, scenario === 'new-failure' ? 'POST' : 'PATCH');
      assert.match(mutations[0].body.body, /— commitperclip/);
      assert.match(mutations[0].body.body,
        scenario === 'existing-success' ? /All checks passing/ : /Missing or incomplete/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
