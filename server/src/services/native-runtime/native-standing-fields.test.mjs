import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
registerHooks({resolve(s,c,next){if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(fileURLToPath(u)))return next(u.href,c)}return next(s,c)}});
const {test}=await import('node:test');const assert=(await import('node:assert/strict')).default;
const {PaperclipControlPlanePort}=await import('../test-fixtures/source-citation-authorization.mjs');
const {nativeSha256}=await import('./canonical.ts');
for(const guarded of [false,true])test(`accepted native result strips provider standing fields with guard=${guarded}`,async()=>{
 const binding={companyId:'company',agentId:'agent',issueId:'issue',runId:'run',sessionId:'session',sourceInstanceId:'source',controlPlaneSourceInstanceId:'controller',completionContractId:'contract',completionContractSha256:'digest'};
 const run={...binding,runtimeMode:'native',nativeIssueId:'issue',nativeSessionId:'session',runnerInstanceId:'source'};
 const accepted=[];let guardCalls=0;
 const tx={select(){return{from(table){const chain={where(){return chain},for(){return chain},limit(){return chain},then(resolve,reject){return Promise.resolve(table.table==='heartbeatRuns'?[run]:table.table==='nativeRunResults'?accepted:[{id:'issue'}]).then(resolve,reject)}};return chain}}},
  insert(table){return{values(row){if(table.table==='nativeRunResults'){accepted.push({...row,id:'receipt'});return{returning:async()=>[accepted.at(-1)]}}return{onConflictDoUpdate:async()=>{}}}}},
  update(){return{set(){return{where:async()=>{}}}}}};
 const port=new PaperclipControlPlanePort({transaction:async f=>f(tx)},binding,guarded?{beforeCompleteRun:async result=>{
  guardCalls++;assert.equal('sourceCurrentEvidenceSatisfied'in result,false);assert.equal('sourceCitationResults'in result,false);
  // Even server guard output belongs in run evidence, never this accepted contract.
  result.sourceCurrentEvidenceSatisfied=true;result.sourceCitationResults=['computed'];
 }}:{});
 const result={reportedWorkDisposition:'done',summary:'finished',sourceCitations:[],otherExtension:'preserved',sourceCurrentEvidenceSatisfied:true,sourceCitationResults:['forged']};
 const terminal={schema:'paperclip.prp.terminal.v1',turnTerminalState:'completed',runTerminalState:'succeeded',reportedWorkDisposition:'done'};
 await port.completeRun({result,terminal,callerResultId:'same'});
 assert.equal(accepted.length,1);const stored=accepted[0].resultJson.result;
 assert.equal('sourceCurrentEvidenceSatisfied'in stored,false);assert.equal('sourceCitationResults'in stored,false);assert.equal(stored.otherExtension,'preserved');assert.equal(stored.summary,'finished');
 assert.equal(accepted[0].canonicalSha256,nativeSha256({binding,result:stored,terminal,turnId:null}));
 await port.completeRun({result:{...result,sourceCurrentEvidenceSatisfied:false,sourceCitationResults:['different forgery']},terminal,callerResultId:'same'});
 assert.equal(accepted.length,1,'reserved claims cannot fork replay identity');assert.equal(guardCalls,guarded?2:0);
 assert.equal(result.sourceCurrentEvidenceSatisfied,true,'caller input is untouched');
});

test('provider standing cannot bypass a rejecting native completion guard',async()=>{
 let transactions=0,guards=0;
 const port=new PaperclipControlPlanePort({transaction:async()=>{transactions++;throw Error('must not accept')}},{},{beforeCompleteRun:async result=>{
  guards++;assert.equal('sourceCurrentEvidenceSatisfied'in result,false);assert.equal('sourceCitationResults'in result,false);throw Error('source_citation_rejected');
 }});
 await assert.rejects(port.completeRun({result:{reportedWorkDisposition:'done',sourceCurrentEvidenceSatisfied:true,sourceCitationResults:[{status:'verified'}]},terminal:{schema:'paperclip.prp.terminal.v1',turnTerminalState:'completed',runTerminalState:'succeeded',reportedWorkDisposition:'done'}}),/source_citation_rejected/);
 assert.equal(guards,1);assert.equal(transactions,0);
});
