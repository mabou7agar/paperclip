import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { NativeQueueClient } from '../plugin/native-queue-client.mjs';
import { canonical, digest, stableInput, ENVELOPE_DOMAIN } from '../plugin/native-contracts.mjs';
import { createTestHarness } from '../../../../packages/plugins/sdk/dist/testing.js';
import { pluginManifestV1Schema } from '../../../../packages/shared/dist/index.js';
import { createRunnerPlugin } from '../dist/plugin/worker.mjs';
import manifest from '../plugin/manifest.mjs';

test('built worker registers real SDK tools/jobs and persists a measured webhook result before native wake', async () => {
  assert.equal(pluginManifestV1Schema.safeParse(manifest).success, true);
  const harness = createTestHarness({ manifest });
  harness.setConfig({ profiles: ['example'] });
  const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), taskId = randomUUID(), runId = randomUUID(), jobId = randomUUID();
  harness.seed({ issues: [{ id: taskId, companyId, projectId, assigneeAgentId: agentId, checkoutRunId: runId,
    status: 'in_progress', title: 'Original task', description: 'Original accepted plan and candidate' }] });
  const outcome = { jobId, companyId, projectId, issueId: taskId, agentId, profile: 'example', status: 'failed',
    receiptSha256: 'a'.repeat(64), fingerprint: 'b'.repeat(64), newEvidence: true,
    result: { status: 'failed', code: 'fixture_contract_failed', cleanupComplete: true } };
  const requests = [];
  const broker = { call: async (operation, value) => {
    requests.push({ operation, value });
    if (operation === 'submit') return { jobId, state: 'queued' };
    if (operation === 'result') return outcome;
    if (operation === 'pending_deliveries') return { jobs: [jobId] };
    if (operation === 'acknowledge') return { acknowledged: true };
    throw new Error('Unexpected broker operation');
  } };
  const plugin = createRunnerPlugin(broker);
  await plugin.definition.setup(harness.ctx);
  const result = await harness.executeTool('submit-runner-job', { taskId, profile: 'example', kind: 'control_checks',
    attachmentId: randomUUID(), packetSha256: 'c'.repeat(64), scopeIssueId: null, scopeCommentId: null, ackCommentId: null,
    recipe: 'changed-input-new.py' }, { companyId, projectId, agentId, runId });
  assert.equal(result.data.jobId, jobId);
  assert.equal(JSON.parse(result.content).jobId, jobId);
  await plugin.definition.onWebhook({ endpointKey: 'terminal', rawBody: JSON.stringify({ jobId }) });
  assert.equal(requests.at(-1).operation, 'acknowledge');
  const document = await harness.ctx.issues.documents.get(taskId, `runner-${jobId}-${'a'.repeat(12)}`, companyId);
  assert.match(document.body, /fixture_contract_failed/);
  assert.equal((await harness.ctx.issues.get(taskId, companyId)).description, 'Original accepted plan and candidate');
  assert.equal((await plugin.definition.onHealth()).status, 'ok');
});


test('durable wake opt-in requires its declared host capability while legacy keyed wakes still work', async () => {
  const harness = createTestHarness({ manifest, capabilities: manifest.capabilities.filter(x => x !== 'issues.wakeup.durable') });
  const companyId = randomUUID(), issueId = randomUUID();
  harness.seed({ issues: [{ id: issueId, companyId, status: 'in_progress', assigneeAgentId: randomUUID(), title: 'Legacy keyed wake' }] });
  await harness.ctx.issues.requestWakeup(issueId, companyId, { idempotencyKey: 'legacy-key' });
  await assert.rejects(harness.ctx.issues.requestWakeup(issueId, companyId,
    { idempotencyKey: 'durable-key', durable: true }), /issues.wakeup.durable/);
  await assert.rejects(harness.ctx.issues.requestWakeups([issueId], companyId,
    { idempotencyKeyPrefix: 'durable-batch', durable: true }), /issues.wakeup.durable/);
});

test('built native webhook authenticates root output before real SDK evidence and one wake',async()=>{
  const harness=createTestHarness({manifest});harness.setConfig({profiles:['example']});
  const companyId=randomUUID(),projectId=randomUUID(),agentId=randomUUID(),taskId=randomUUID(),runId=randomUUID();
  harness.seed({issues:[{id:taskId,companyId,projectId,assigneeAgentId:agentId,checkoutRunId:runId,status:'in_progress',
    title:'Retained task',description:'Original shared planning context'}]});
  const pair=generateKeyPairSync('ed25519'),trust={pluginId:randomUUID(),brokerUserId:'fixture-operator',publicKey:pair.publicKey};
  const client=new NativeQueueClient(harness.ctx,async()=>trust,async()=>true),plugin=createRunnerPlugin(client);
  await plugin.definition.setup(harness.ctx);
  const args={taskId,profile:'example',kind:'control_checks',attachmentId:randomUUID(),packetSha256:'d'.repeat(64),
    scopeIssueId:null,scopeCommentId:null,ackCommentId:null,recipe:'changed-input-new.py'};
  const response=await harness.executeTool('submit-runner-job',args,{companyId,projectId,agentId,runId});
  assert.equal(response.data.state,'pending_admission');const jobId=response.data.jobId;
  const request={...args,companyId,projectId,agentId,sourceRunId:runId};
  const envelope=(kind,data)=>{
    const raw=Buffer.from(canonical({schema:'paperclip.runner-envelope.v1',pluginKey:manifest.id,pluginId:trust.pluginId,
      kind,companyId,projectId,agentId,issueId:taskId,jobId,requestDigest:digest(stableInput(request)),sequence:kind==='result'?1:0,data}));
    return {payload:raw.toString('base64'),signature:sign(null,Buffer.concat([Buffer.from(ENVELOPE_DOMAIN),raw]),pair.privateKey).toString('base64')};
  };
  const admission=envelope('admission',{jobId,state:'queued'});
  const receiver=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.authorization,undefined);
      assert.equal(req.url,`/api/plugins/${trust.pluginId}/webhooks/terminal`);
      let raw='';for await(const part of req)raw+=part;
      await plugin.definition.onWebhook({endpointKey:'terminal',rawBody:raw});
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'success'}));
    }catch{res.writeHead(502,{'Content-Type':'application/json'});res.end('{}');}
  });
  receiver.listen(0,'127.0.0.1');await once(receiver,'listening');
  const url=`http://127.0.0.1:${receiver.address().port}/api/plugins/${trust.pluginId}/webhooks/terminal`;
  const webhook=async envelope=>{
    const response=await promisify(execFile)('curl',['--silent','--show-error','--fail-with-body','--max-time','5',
      '-H','Content-Type: application/json','--data-binary',JSON.stringify(envelope),url],{timeout:8000});
    assert.equal(JSON.parse(response.stdout).status,'success');
  };
  try {
  await assert.rejects(webhook({...admission,signature:'A'.repeat(86)+'=='}));
  await assert.rejects(plugin.definition.onWebhook({endpointKey:'wrong',rawBody:JSON.stringify(admission)}));
  await webhook(admission);
  const result={jobId,companyId,projectId,agentId,issueId:taskId,profile:'example',status:'passed',
    receiptSha256:'e'.repeat(64),fingerprint:'f'.repeat(64),newEvidence:true,result:{status:'passed',cleanupComplete:true}};
  const signed=envelope('result',result);
  await Promise.all([webhook(signed),webhook(signed)]);
  await plugin.definition.setup(harness.ctx);await webhook(signed);
  const document=await harness.ctx.issues.documents.get(taskId,`runner-${jobId}-${'e'.repeat(12)}`,companyId);
  assert.match(document.body,/compatible provider session/);
  assert.equal((await harness.ctx.issues.get(taskId,companyId)).description,'Original shared planning context');
  assert.match((await plugin.definition.onHealth()).message,/native_webhook/);
  }finally{await new Promise(resolve=>receiver.close(resolve));}
});
