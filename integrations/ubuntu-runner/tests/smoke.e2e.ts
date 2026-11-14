import { test, expect } from 'e2e';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';

test('Paperclip project TLS routes are isolated and revoke without agent work', async ({ app }) => {
  const host = process.env.PAPERCLIP_PREVIEW_SMOKE_HOST ?? '';
  const container = process.env.PAPERCLIP_PREVIEW_SMOKE_CONTAINER ?? '';
  const user = process.env.PAPERCLIP_PREVIEW_SMOKE_USER ?? '';
  const candidate = process.env.PAPERCLIP_PREVIEW_SMOKE_CANDIDATE ?? '';
  const playwright = process.env.PAPERCLIP_PREVIEW_PLAYWRIGHT ?? '';
  // SSH joins remote arguments into a shell command. Every value is a plain token.
  expect(/^[a-z0-9][a-z0-9.-]{0,120}$/u.test(host)).toBe(true);
  expect(/^[a-z0-9][a-z0-9_.-]{0,120}$/u.test(container)).toBe(true);
  expect(/^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$/u.test(user)).toBe(true);
  expect(/^\/tmp\/paperclip-ubuntu-preview-[a-f0-9]{16}$/u.test(candidate)).toBe(true);
  expect(/^\/[A-Za-z0-9_/.-]+\.mjs$/u.test(playwright)).toBe(true);
  const directory = '.e2e/ubuntu-preview-smoke';
  await mkdir(directory, { recursive: true });
  let stdout = '', stderr = '';
  try {
    ({ stdout, stderr } = await promisify(execFile)('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      `root@${host}`, 'docker', 'exec', '--user', user, '-e', `PAPERCLIP_PREVIEW_PLAYWRIGHT=${playwright}`,
      container, 'python3', '-B', `${candidate}/integrations/ubuntu-runner/tests/linux-smoke.py`],
    { timeout: 110000, maxBuffer: 1024 * 1024 }));
  } catch (error: any) {
    await writeFile(`${directory}/failure.log`, String(error.stdout ?? '') + String(error.stderr ?? ''));
    throw error;
  }
  await writeFile(`${directory}/runtime.log`, stdout + stderr);
  const receipt = JSON.parse(stdout.trim().split('\n').at(-1)!);
  await writeFile(`${directory}/runtime.json`, JSON.stringify(receipt, null, 2));
  expect(receipt.status).toBe('passed');
  expect(receipt.checks.length).toBe(6);
  expect(receipt.checks).toContain('cross-project-cookie-scope-isolation');
  expect(receipt.uid).toBeGreaterThan(0);
  expect(receipt.cleanup.leases).toBe(0);
  expect(receipt.cleanup.leafKeys).toBe(0);
  expect(receipt.applicationOrMcpTests).toBe(0);
});
