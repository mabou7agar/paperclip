import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { NativeQueueClient } from '../plugin/native-queue-client.mjs';
import { ResultService } from '../plugin/result-service.mjs';
import { canonical, digest, stableInput, jobId, requestKey, ADMISSION_NAMESPACE, ENVELOPE_DOMAIN, PLUGIN_KEY } from '../plugin/native-contracts.mjs';

function fixture() {
  const pair = generateKeyPairSync('ed25519'), trust = { publicKey:pair.publicKey, pluginId:randomUUID(), brokerUserId:'operator-fixture' };
  const request = { companyId:randomUUID(), projectId:randomUUID(), agentId:randomUUID(), sourceRunId:randomUUID(),
    taskId:randomUUID(), profile:'fixture',kind:'control_checks',attachmentId:randomUUID(),packetSha256:'a'.repeat(64),
    scopeIssueId:null,scopeCommentId:null,ackCommentId:null,recipe:'fixture-new.py' };
  const state = new Map(), docs = new Map(), wakes = new Map(); let physicalWakes = 0, hints = 0;
  const ctx = { state:{ get:async key=>state.get(canonical(key))??null,
    set:async(key,value)=>state.set(canonical(key),structuredClone(value)),delete:async key=>state.delete(canonical(key)) },
    config:{get:async()=>({profiles:['fixture']})},issues:{
      get:async()=>({id:request.taskId,companyId:request.companyId,projectId:request.projectId,assigneeAgentId:request.agentId,status:'in_progress'}),
      assertCheckoutOwner:async()=>{}, documents:{get:async(_id,key)=>docs.get(key)??null,
        upsert:async value=>{docs.set(value.key,value);return value;}},
      requestWakeup:async(_id,_company,value)=>{
        if (!wakes.has(value.idempotencyKey)) {physicalWakes++;wakes.set(value.idempotencyKey,{runId:randomUUID()});}
        return wakes.get(value.idempotencyKey);
      },
    } };
  const client = new NativeQueueClient(ctx,async()=>trust,async()=>{hints++;return true;}), service = new ResultService(ctx,client);
  const actor = {companyId:request.companyId,actor:{type:'user',userId:trust.brokerUserId,companyId:request.companyId}};
  const envelope = (kind,data,patch={}) => {
    const raw = Buffer.from(canonical({schema:'paperclip.runner-envelope.v1',kind,pluginKey:PLUGIN_KEY,
      pluginId:trust.pluginId,companyId:request.companyId,projectId:request.projectId,issueId:request.taskId,
      agentId:request.agentId,jobId:jobId(request),requestDigest:digest(stableInput(request)),sequence:kind==='result'?1:0,data,...patch}));
    return {payload:raw.toString('base64'),signature:sign(null,Buffer.concat([Buffer.from(ENVELOPE_DOMAIN),raw]),pair.privateKey).toString('base64')};
  };
  const result = { jobId:jobId(request),companyId:request.companyId,projectId:request.projectId,issueId:request.taskId,
    agentId:request.agentId,profile:'fixture',status:'passed',receiptSha256:'b'.repeat(64),fingerprint:'c'.repeat(64),newEvidence:true,
    result:{status:'passed',kind:'control_checks',cleanupComplete:true} };
  return { request,ctx,client,service,actor,envelope,result,state,docs,wakes,get physicalWakes(){return physicalWakes;},get hints(){return hints;} };
}

test('startup and ambiguous committed intent notify recovery without a provider wake',async()=>{
  const f=fixture();await f.client.startup();assert.equal(f.hints,1);
  const set=f.ctx.state.set;
  f.ctx.state.set=async(key,value)=>{
    await set(key,value);
    if(key.namespace==='runner-requests')throw new Error('response lost after commit');
  };
  await assert.rejects(f.client.call('submit',f.request),/response lost/);
  assert.deepEqual(await f.ctx.state.get(requestKey(f.request.taskId,jobId(f.request))),f.request);
  assert.equal(f.hints,2);assert.equal(f.physicalWakes,0);
});

test('native intent survives a lost tool response; admission and result use one durable continuation', async()=>{
  const f = fixture(), first = await f.client.call('submit',f.request);
  assert.equal(first.state,'pending_admission');assert.equal(f.physicalWakes,0);
  assert.deepEqual(await f.ctx.state.get(requestKey(f.request.taskId,first.jobId)),f.request);
  const replay = await f.client.call('submit',{...f.request,sourceRunId:randomUUID()});
  assert.equal(replay.jobId,first.jobId);assert.equal(replay.replayed,true);
  assert.equal((await f.ctx.state.get(requestKey(f.request.taskId,first.jobId))).sourceRunId,f.request.sourceRunId);
  // The real native action route injects companyId into params.
  await f.client.receive({...f.envelope('admission',{jobId:first.jobId,state:'queued'}),companyId:f.request.companyId},f.actor,f.service);
  assert.equal(await f.ctx.state.get(requestKey(f.request.taskId,first.jobId)),null);
  const status=await f.client.call('status',{jobId:first.jobId,companyId:f.request.companyId,agentId:f.request.agentId});
  assert.equal(status.state,'queued');assert.equal(f.physicalWakes,0);
  const terminal = f.envelope('result',f.result);
  await Promise.all([f.client.receive(terminal,f.actor,f.service),f.client.receive(terminal,f.actor,f.service)]);
  await f.client.receive(terminal,f.actor,new ResultService(f.ctx,f.client));
  assert.equal(f.docs.size,1);assert.equal(f.physicalWakes,1);
  assert.equal((await f.client.call('status',{jobId:first.jobId,companyId:f.request.companyId,agentId:f.request.agentId})).state,'terminal');
  assert.match([...f.docs.values()][0].body,/compatible provider session/);
});

test('valid root signature still requires native user, company and plugin provenance',async()=>{
  const f=fixture();await f.client.call('submit',f.request);
  const signed=f.envelope('result',f.result);
  for(const context of [{...f.actor,actor:{...f.actor.actor,type:'agent'}},{...f.actor,companyId:randomUUID()},
    {...f.actor,actor:{...f.actor.actor,userId:'other-user'}}]) {
    await assert.rejects(f.client.receive(signed,context,f.service));
  }
  await assert.rejects(f.client.receive(f.envelope('result',f.result,{pluginId:randomUUID()}),f.actor,f.service));
  await assert.rejects(f.client.receive({...signed,companyId:randomUUID()},f.actor,f.service));
  const corrupted={...signed,payload:Buffer.from('{}').toString('base64')};
  await assert.rejects(f.client.receive(corrupted,f.actor,f.service));
  assert.equal(f.docs.size,0);assert.equal(f.physicalWakes,0);
});

test('same job with changed attachment is a conflict and other agents cannot read its status',async()=>{
  const f=fixture();const first=await f.client.call('submit',f.request);
  await assert.rejects(f.client.call('submit',{...f.request,attachmentId:randomUUID()}),/conflict/);
  await assert.rejects(f.client.call('status',{jobId:first.jobId,companyId:f.request.companyId,agentId:randomUUID()}));
  assert.equal(f.physicalWakes,0);
});

test('a late admission refusal is retained and wakes once without submitting execution again',async()=>{
  const f=fixture();const first=await f.client.call('submit',f.request);
  const signed=f.envelope('admission',{jobId:first.jobId,state:'not_admitted',code:'job_kind_not_enabled'});
  await f.client.receive(signed,f.actor,f.service);await f.client.receive(signed,f.actor,f.service);
  assert.equal(f.physicalWakes,1);
  const replay=await f.client.call('submit',f.request);assert.equal(replay.state,'not_admitted');
  assert.equal(await f.ctx.state.get(requestKey(f.request.taskId,first.jobId)),null);
  const admitted=await f.ctx.state.get(requestKey(f.request.taskId,first.jobId,ADMISSION_NAMESPACE));
  admitted.payload=Buffer.from('{}').toString('base64');
  await f.ctx.state.set(requestKey(f.request.taskId,first.jobId,ADMISSION_NAMESPACE),admitted);
  await assert.rejects(f.client.call('status',{jobId:first.jobId,companyId:f.request.companyId,agentId:f.request.agentId}));
});

test('Python and native JavaScript use the same job and durable wake identities',async()=>{
  const f=JSON.parse(await readFile(new URL('./fixtures/native-protocol-vectors.json',import.meta.url),'utf8'));
  assert.equal(jobId(f.request),f.jobId);assert.equal(digest(stableInput(f.request)),f.requestDigest);
  const hash=createHash('sha256').update(JSON.stringify(['paperclip.plugin-wakeup.v1',f.request.companyId,f.pluginId,f.wakeKey])).digest('hex');
  assert.equal(`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`,f.wakeId);
  assert.equal(createHash('sha256').update(JSON.stringify([f.request.companyId,f.pluginId,f.request.taskId,f.request.agentId,
    f.wakeKey,'runner_result_received','ubuntu.runner.result'])).digest('hex'),f.wakeDigest);
});

test('reconciled progress wins over a stale signed result and replay returns retained evidence',async()=>{
  const f=fixture();await f.client.call('submit',f.request);
  await f.client.receive(f.envelope('admission',{jobId:f.result.jobId,state:'queued'}),f.actor,f.service);
  const uncertain={...f.result,status:'unknown',result:{status:'unknown',cleanupComplete:false}};
  const old=f.envelope('result',uncertain);
  await f.client.receive(old,f.actor,f.service);
  const reconciled={...f.result,receiptSha256:'d'.repeat(64),fingerprint:'e'.repeat(64)};
  await f.client.receive(f.envelope('result',reconciled,{sequence:2}),f.actor,f.service);
  await f.client.receive(old,f.actor,f.service);
  assert.equal(f.docs.size,2);assert.equal(f.physicalWakes,2);
  const replay=await f.client.call('submit',f.request);
  assert.equal(replay.state,'terminal');assert.equal(replay.result.receiptSha256,'d'.repeat(64));assert.equal(replay.replayed,true);
  await assert.rejects(f.client.receive(f.envelope('result',{...reconciled,receiptSha256:'f'.repeat(64)},{sequence:2}),f.actor,f.service),/sequence_conflict/);
  assert.equal(f.physicalWakes,2);
});
