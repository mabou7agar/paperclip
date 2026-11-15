import { test, expect } from 'e2e';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { BrokerClient } from '../plugin/broker-client.mjs';
import { ResultService } from '../plugin/result-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
test('lost acknowledgement and broker restart deliver one unchanged task result through real Unix IPC', async ({ app }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'runner-ipc-'));
  const socket = path.join(root, 'broker.sock');
  let child: ReturnType<typeof spawn> | undefined;
  async function start() {
    child = spawn('python3', ['-B', path.join(here, 'ipc_fixture.py'), path.join(root, 'state'), socket], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => { child!.stdout!.once('data', () => resolve()); child!.once('error', reject);
      child!.once('exit', code => reject(new Error('IPC fixture exited: ' + code))); });
  }
  async function stop() { if (child?.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
  const evidence = path.resolve(here, '../.e2e/curl-receipts');
  await mkdir(evidence, { recursive: true });
  try {
    await start();
    const client = new BrokerClient(socket);
    const request = { taskId: randomUUID(), profile: 'example', kind: 'reviewed_controller', attachmentId: randomUUID(),
      packetSha256: 'c'.repeat(64), scopeIssueId: randomUUID(), scopeCommentId: randomUUID(), ackCommentId: randomUUID(), recipe: null,
      companyId: randomUUID(), projectId: randomUUID(), agentId: randomUUID(), sourceRunId: randomUUID() };
    const first = await client.call('submit', request);
    const replay = await client.call('submit', request);
    expect(replay.jobId).toBe(first.jobId); expect(replay.replayed).toBe(true);
    const issue = { id: request.taskId, companyId: request.companyId, projectId: request.projectId,
      assigneeAgentId: request.agentId, status: 'in_progress', plan: 'original-plan', sessionId: 'original-saved-session' };
    const documents = new Map(), receipts = new Map(); let wakes = 0;
    const ctx = { config: { get: async () => ({ profiles: ['example'] }) }, issues: {
      get: async () => issue,
      documents: { get: async (_: string, key: string) => documents.get(key), upsert: async (value: any) => documents.set(value.key, value) },
      requestWakeup: async (_: string, __: string, options: any) => {
        if (!receipts.has(options.idempotencyKey)) { wakes++; receipts.set(options.idempotencyKey, randomUUID()); }
        return { queued: true, runId: receipts.get(options.idempotencyKey) };
      },
    } };
    let loseAck = true;
    const lossy = { call: async (op: string, input: any) => {
      if (op === 'acknowledge' && loseAck) throw new Error('simulated ACK loss');
      return client.call(op, input);
    } };
    let failed = false;
    try { await new ResultService(ctx, lossy).deliver(first.jobId); } catch { failed = true; }
    expect(failed).toBe(true); expect(wakes).toBe(1);
    await stop(); await start(); loseAck = false;
    await new ResultService(ctx, lossy).drain();
    expect(documents.size).toBe(1); expect(wakes).toBe(1);
    const { stdout } = await promisify(execFile)('curl', ['--silent', '--show-error', '--fail-with-body', '--unix-socket', socket,
      '-H', 'Content-Type: application/json', '--data-binary', JSON.stringify({ operation: 'status', input: {
        jobId: first.jobId, companyId: request.companyId, agentId: request.agentId } }), 'http://localhost/api/v1/broker']);
    await writeFile(path.join(evidence, 'retained-job.json'), stdout);
    const current = JSON.parse(stdout);
    expect(current.result.result.executions).toBe(1); expect(current.state).toBe('terminal');
    expect((await client.call('pending_deliveries', {})).jobs).toEqual([]);
    expect(issue.sessionId).toBe('original-saved-session'); expect(issue.plan).toBe('original-plan');
  } finally { await stop(); await rm(root, { recursive: true, force: true }); }
});
