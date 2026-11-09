import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../workflows/commitperclip-review.yml', import.meta.url), 'utf8');

test('quality checks use the built-in token with only required permissions', () => {
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /permissions:\n  pull-requests: write\n  contents: read\n/);
  assert.doesNotMatch(workflow, /COMMITPERCLIP_KEY|secrets\.|get-bot-token\.mjs|checks: write|contents: write/);
});

test('privileged quality checks execute only the trusted base snapshot', () => {
  assert.match(workflow, /pull_request_target:\n    types: \[opened, synchronize, reopened, edited\]/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false/);
  assert.match(workflow, /run: node \.github\/scripts\/run-quality-gates\.mjs/);
  assert.doesNotMatch(workflow, /^\s+ref: .*head|npm (?:install|ci)|pnpm install|refs\/pull/m);
  for (const [, ref] of workflow.matchAll(/uses: \S+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
});

test('quality checks serialize reports and still fail on a failed gate', () => {
  assert.match(workflow, /group: pr-quality-\$\{\{ github\.event\.pull_request\.number \}\}\n  cancel-in-progress: false/);
  assert.match(workflow, /steps\.quality\.outcome == 'failure'/);
  assert.match(workflow, /exit 1/);
});
