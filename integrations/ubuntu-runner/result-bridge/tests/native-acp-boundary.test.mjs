import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from '../../../../packages/adapter-utils/node_modules/acpx/dist/runtime.js';
import { localAgentProtocolGuard } from '../../../../packages/adapter-utils/src/local-agent-launch-policy.ts';

const peer = String.raw`
const {createInterface}=require('node:readline'),fs=require('node:fs');
const session='00000000-1111-4111-8111-000000000001';let pending;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+String.fromCharCode(10));
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(q.id===991&&!q.method){send({id:pending,result:{stopReason:'end_turn'}});return;}
 if(q.method==='initialize'){
  if(process.env.REQUIRE_CONFINED_CAPS==='1'&&(q.params.clientCapabilities.fs.readTextFile!==false||q.params.clientCapabilities.fs.writeTextFile!==false||q.params.clientCapabilities.terminal!==false))process.exit(91);
  return send({id:q.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:'boundary-fixture',version:'1'}}});
 }
 if(q.method==='session/new')return send({id:q.id,result:{sessionId:session}});
 if(q.method==='session/load')return send({id:q.id,result:{}});
 if(q.method==='session/prompt'){
  const text=q.params.prompt.map(x=>x.text??'').join('');
  if(text==='fs'){pending=q.id;return send({id:991,method:'fs/write_text_file',params:{sessionId:session,path:process.env.FIXTURE_MARKER,content:'parent-bypass'}});}
  if(text==='unexpected'){pending=q.id;return send({id:991,method:'client/private_data',params:{sessionId:session}});}
  if(text==='batch'){pending=q.id;return process.stdout.write(JSON.stringify([{jsonrpc:'2.0',id:991,method:'fs/write_text_file',params:{path:process.env.FIXTURE_MARKER,content:'bypass'}}])+String.fromCharCode(10));}
  if(text==='terminal'){pending=q.id;return send({id:991,method:'terminal/create',params:{sessionId:session,command:process.execPath,args:['-e','require("node:fs").writeFileSync('+JSON.stringify(process.env.FIXTURE_MARKER)+',"parent-bypass")']}});}
  send({method:'session/update',params:{sessionId:session,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'retained-original-plan:'+text}}}});
  return send({id:q.id,result:{stopReason:'end_turn'}});
 }
 if(q.id!==undefined)return send({id:q.id,result:{}});
});
`;

async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'paperclip-native-acp-policy-'));
  const file=path.join(root,'peer.cjs'),marker=path.join(root,'marker');await writeFile(file,peer);
  const children=[];let spawns=0;
  const create=(guard)=>createAcpRuntime({cwd:root,sessionStore:createRuntimeStore({stateDir:path.join(root,'state')}),
    agentRegistry:createAgentRegistry({overrides:{custom:[process.execPath,file].map(x=>JSON.stringify(x)).join(' ')}}),permissionMode:'approve-all',
    nonInteractivePermissions:'fail',timeoutMs:1500,inheritProcessEnv:false,
    spawnAgent:input=>{spawns++;const child=spawn(input.command,input.args,{...input.options,env:{...input.options.env,REQUIRE_CONFINED_CAPS:guard?'1':'0'},stdio:['pipe','pipe','pipe']});children.push(child);return child;},
    protocolGuardFactory:guard,
  });
  return {root,marker,create,get spawns(){return spawns;},async cleanup(){for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}};
}
const policy={kind:'apparmor',executable:'/not-executed-here',profile:'paperclip-agent'};
async function open(f,runtime,resumeSessionId) {
  return runtime.ensureSession({sessionKey:'stable-native-fixture',agent:'custom',mode:'persistent',resumeSessionId,
    sessionOptions:{env:{PATH:process.env.PATH,FIXTURE_MARKER:f.marker}}});
}
async function prompt(runtime,handle,text) {
  const turn=runtime.startTurn({handle,text,mode:'prompt',requestId:'fixture-'+text,timeoutMs:1500});
  const events=[];const collect=(async()=>{for await(const event of turn.events)events.push(event);})();
  const [outcome]=await Promise.all([turn.result,collect]);return {outcome,events};
}

test('real ACP spawn hook and restart load the same saved conversation with retained plan',async()=>{
  const f=await fixture();let runtime=f.create(localAgentProtocolGuard(policy));
  try {
    const first=await open(f,runtime);const initial=await prompt(runtime,first,'first');
    assert.equal(initial.outcome.status,'completed');
    await runtime.close({handle:first,reason:'fixture restart',discardPersistentState:false});
    runtime=f.create(localAgentProtocolGuard(policy));
    const second=await open(f,runtime,first.backendSessionId);
    const resumed=await prompt(runtime,second,'second');
    assert.equal(second.backendSessionId,first.backendSessionId);assert.equal(resumed.outcome.status,'completed');
    assert.match(JSON.stringify(resumed.events),/retained-original-plan:second/);assert.equal(f.spawns,2);
    await runtime.close({handle:second,reason:'finished'});
  } finally {await f.cleanup();}
});

test('the real ACP parent path works as a negative control with the optional policy absent',async()=>{
  const f=await fixture(),runtime=f.create(undefined);let handle;
  try {handle=await open(f,runtime);const value=await prompt(runtime,handle,'fs');
    assert.equal(value.outcome.status,'completed');assert.equal(await readFile(f.marker,'utf8'),'parent-bypass');
    assert.equal(f.spawns,1);
  }finally{if(handle)await runtime.close({handle,reason:'finished'});await f.cleanup();}
});

for(const operation of ['fs','terminal','unexpected','batch'])test(`required policy stops real ACP parent ${operation} dispatch without respawning`,async()=>{
  const f=await fixture(),runtime=f.create(localAgentProtocolGuard(policy));let handle;
  try {
    handle=await open(f,runtime);let failed=false;
    try{const value=await prompt(runtime,handle,operation);failed=value.outcome.status!=='completed';}catch{failed=true;}
    assert.equal(failed,true);await assert.rejects(access(f.marker));assert.equal(f.spawns,1);
  }finally{if(handle)await runtime.close({handle,reason:'finished'});await f.cleanup();}
});
