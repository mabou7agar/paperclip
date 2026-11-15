import { test, expect } from 'e2e';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BrokerClient } from '../plugin/broker-client.mjs';
import { ResultService } from '../plugin/result-service.mjs';

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(description)), 10000); timer.unref(); })]); }
  finally { clearTimeout(timer!); }
}
const here = path.dirname(fileURLToPath(import.meta.url));
test('real job service automatically delivers one HTTP result and survives lost ACK plus broker restart', async ({ app }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-ipc-'));
  const socket = path.join(root, 'broker.sock');
  let child: ReturnType<typeof spawn> | undefined;
  let service: ResultService | undefined, loseAck = true, hintCount = 0;
  let firstHint!: () => void, recoveredHint!: () => void;
  const first = new Promise<void>(resolve => { firstHint = resolve; });
  const recovered = new Promise<void>(resolve => { recoveredHint = resolve; });
  const callback = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks).toString()); hintCount++;
      await service!.deliver(value.jobId);
      response.writeHead(200); response.end('{}'); recoveredHint();
    } catch { response.writeHead(503); response.end('{}'); firstHint(); }
  });
  callback.listen(0, '127.0.0.1'); await once(callback, 'listening');
  const callbackUrl = `http://127.0.0.1:${(callback.address() as any).port}/completion`;
  async function start() {
    child = spawn('python3', ['-B', path.join(here, 'ipc_fixture.py'), path.join(root, 'state'), socket, callbackUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise<any>((resolve, reject) => {
      child!.stdout!.once('data', data => { try { resolve(JSON.parse(String(data))); } catch (error) { reject(error); } });
      child!.once('error', reject); child!.once('exit', code => reject(new Error('IPC fixture exited: ' + code)));
    });
  }
  async function stop() { if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  const evidence = path.resolve(here, '../.e2e/curl-receipts');
  await mkdir(evidence, { recursive: true });
  try {
    const boot = await bounded(start(), "fixture startup timed out"); const request = boot.request;
    const client = new BrokerClient(socket, () => 'c'.repeat(64));
    const issue = { id: request.taskId, companyId: request.companyId, projectId: request.projectId,
      assigneeAgentId: request.agentId, status: 'in_progress', plan: 'original-plan', sessionId: 'original-saved-session' };
    const documents = new Map(), receipts = new Map(); let wakes = 0;
    const ctx = { config: { get: async () => ({ profiles: ['example'] }) }, issues: {
      get: async () => issue, update: async (_: string, patch: any) => Object.assign(issue, patch),
      documents: { get: async (_: string, key: string) => documents.get(key), upsert: async (value: any) => documents.set(value.key, value) },
      requestWakeup: async (_: string, __: string, options: any) => {
        if (!receipts.has(options.idempotencyKey)) { wakes++; receipts.set(options.idempotencyKey, randomUUID()); }
        return { queued: true, runId: receipts.get(options.idempotencyKey) };
      },
    } };
    const lossy = { call: async (op: string, input: any) => {
      if (op === 'acknowledge' && loseAck) throw new Error('simulated ACK loss');
      return client.call(op, input);
    } };
    service = new ResultService(ctx, lossy);
    const submitted = await client.call('submit', request);
    const replay = await client.call('submit', request);
    expect(replay.jobId).toBe(submitted.jobId); expect(replay.replayed).toBe(true);
    await bounded(first, "automatic first callback timed out"); expect(wakes).toBe(1); expect(documents.size).toBe(1);
    await stop(); loseAck = false;
    service = new ResultService(ctx, lossy);
    await bounded(start(), "fixture restart timed out"); await bounded(recovered, "automatic recovered callback timed out");
    expect(documents.size).toBe(1); expect(wakes).toBe(1); expect(hintCount).toBe(2);
    const statusBody = JSON.stringify({ operation: 'status', input: { jobId: submitted.jobId, companyId: request.companyId, agentId: request.agentId } });
    const signature = createHmac('sha256', 'c'.repeat(64)).update('paperclip.ubuntu-runner-results\n' + statusBody).digest('hex');
    const { stdout } = await promisify(execFile)('curl', ['--silent', '--show-error', '--fail-with-body', '--unix-socket', socket,
      '-H', 'Content-Type: application/json', '-H', 'X-Paperclip-Runner-Plugin: paperclip.ubuntu-runner-results',
      '-H', 'X-Paperclip-Runner-Signature: ' + signature, '--data-binary', statusBody, 'http://localhost/api/v1/broker']);
    await writeFile(path.join(evidence, 'retained-job.json'), stdout);
    const current = JSON.parse(stdout);
    expect(current.result.result.dispatches).toBe(1); expect(current.state).toBe('terminal'); expect(current.waitCode).toBe(null);
    expect((await client.call('pending_deliveries', {})).jobs).toEqual([]);
    expect(issue.sessionId).toBe('original-saved-session'); expect(issue.plan).toBe('original-plan');
    const completed = await client.call('submit', request);
    expect(completed.state).toBe('terminal'); expect(completed.result.receiptSha256).toBe(current.result.receiptSha256);
    expect(completed.next).toContain('do not wait');
    const unauthorized = await promisify(execFile)('curl', ['--silent', '--show-error', '--unix-socket', socket,
      '-H', 'Content-Type: application/json', '--data-binary', statusBody, '-w', '\n%{http_code}', 'http://localhost/api/v1/broker']);
    expect(unauthorized.stdout.trim().split('\n').at(-1)).toBe('409');
    await writeFile(path.join(evidence, 'unsigned-denial.txt'), unauthorized.stdout);
  } finally { await stop(); await new Promise<void>(resolve => callback.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
