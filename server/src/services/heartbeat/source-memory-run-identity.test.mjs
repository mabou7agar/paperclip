import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceMemoryRunIdentity,sourceReviewAssignedTo,sourceReviewCandidateSha} from './source-memory-run-state.ts';
const fresh={route:null,workMode:'standard',reviewAssigned:false,recovering:false,provider:'codex',model:'gpt-6.1-sol'};
test('fresh native planning and implementation have effective identity without a legacy route',()=>{
 for(const [workMode,phase] of [['planning','planning'],['standard','implementation']])
  assert.deepEqual(sourceMemoryRunIdentity({...fresh,workMode}),{phase,provider:'codex',model:'gpt-6.1-sol'});
 assert.deepEqual(sourceMemoryRunIdentity({...fresh,provider:'acpx',model:'claude-opus-5-5'}),{phase:'implementation',provider:'acpx',model:'claude-opus-5-5'});
});
test('an assigned pending reviewer requires review evidence',()=>{
 assert.equal(sourceMemoryRunIdentity({...fresh,reviewAssigned:true}).phase,'review');
});
test('phase-routed identity remains the selected profile',()=>{
 const route={phase:'review',provider:'anthropic',model:'claude-opus-5-5'};
 assert.deepEqual(sourceMemoryRunIdentity({...fresh,route}),route);
});
test('direct attribution retains resolved account and refuses missing model/provider',()=>{
 assert.deepEqual(sourceMemoryRunIdentity({...fresh,provider:'openai'}),{phase:'implementation',provider:'openai',model:'gpt-6.1-sol'});
 assert.deepEqual(sourceMemoryRunIdentity({...fresh,provider:null,model:null}),{phase:'implementation',provider:null,model:null});
});
test('ask, skill test and missing task do not acquire execution identity',()=>{
 for(const workMode of ['ask','skill_test',null])
  for(const reviewAssigned of [false,true])assert.equal(sourceMemoryRunIdentity({...fresh,workMode,reviewAssigned}).phase,null);
});
test('restart ignores edited live attribution and retains review obligation',()=>{
 for(const patch of [{},{reviewAssigned:true},{route:{phase:'review',provider:'edited',model:'edited'}}]) {
  const identity=sourceMemoryRunIdentity({...fresh,...patch,recovering:true,provider:'edited',model:'edited'});
  assert.equal(identity.provider,null);assert.equal(identity.model,null);
  if(patch.reviewAssigned||patch.route)assert.equal(identity.phase,'review');
 }

});

test('an assigned reviewer with absent or mismatched capture remains review and cannot acquire a candidate',()=>{
 const scope={companyId:'c',issueId:'i',workspaceId:'w',bindingRevision:0};
 const state={status:'pending',currentStageId:'stage',currentStageType:'review',currentParticipant:{agentId:'reviewer'},reviewRequest:{candidateSha:'a'.repeat(40)}};
 for(const sourceReviewCapture of [null,{schema:1,...scope,stageId:'wrong-stage',participantAgentId:'reviewer',candidateSha:'a'.repeat(40)}]) {
  const saved={...state,sourceReviewCapture};
  assert.equal(sourceReviewAssignedTo(saved,'reviewer'),true);
  assert.equal(sourceReviewCandidateSha(saved,'reviewer',scope),null);
  assert.equal(sourceMemoryRunIdentity({...fresh,reviewAssigned:sourceReviewAssignedTo(saved,'reviewer')}).phase,'review');
 }
 assert.equal(sourceReviewAssignedTo(state,'other'),false);
});

test('authoritative review assignment cannot be downgraded by an implementation route',()=>{
 assert.deepEqual(sourceMemoryRunIdentity({...fresh,reviewAssigned:true,route:{phase:'implementation',provider:'openai',model:'selected'}}),{phase:'review',provider:'openai',model:'selected'});
});

test('interaction-only review on an opted-in repository refuses missing writer capture before reading source',async()=>{
 const {registerHooks}=await import('node:module');const {existsSync}=await import('node:fs');
 const {fileURLToPath}=await import('node:url');
 const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL){
   const ts=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
   if(existsSync(fileURLToPath(ts)))return next(ts.href,context);
  }
  return next(specifier,context);
 }});
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'source-identity-refusal-')),saved=process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;
 try {
  const config=join(root,'config.json');process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG=config;
  await writeFile(config,JSON.stringify({version:1,state:join(root,'must-not-exist'),reader:join(root,'no-reader'),manifest:join(root,'no-manifest'),bindings:[{companyId:'c',projectId:'p',repositoryId:'github.com/synthetic/review',roots:[root]}]}));
  const {prepareHeartbeatSourceMemory}=await import('./source-memory.ts');let authorizations=0;
  const identity=sourceMemoryRunIdentity({...fresh,reviewAssigned:true});
  await assert.rejects(prepareHeartbeatSourceMemory({identity:{companyId:'c',projectId:'p',issueId:'i',runId:'r',...identity},
   workspace:{cwd:root,repoUrl:'https://github.com/synthetic/review'},persistedWorkspaceId:'w',recovering:false,frozenRevision:null,
   authorize:async admission=>{assert.equal(admission,true);authorizations++;return {companyId:'c',projectId:'p',repositoryId:'github.com/synthetic/review',frozenSha:''};},
   recordRevision:async()=>{throw Error('No snapshot may be created without capture');},authority:null,remote:null,assertOwned:async()=>{},readAuthority:async()=>null,
  }),/source_memory_review_candidate_missing/);
  assert.equal(authorizations,1);assert.equal(existsSync(join(root,'must-not-exist')),false);
 } finally {
  hooks.deregister();if(saved===undefined)delete process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG;else process.env.PAPERCLIP_SOURCE_MEMORY_CONFIG=saved;
  await rm(root,{recursive:true,force:true});
 }
});
