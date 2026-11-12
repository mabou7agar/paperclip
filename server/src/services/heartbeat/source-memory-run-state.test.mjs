import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshSourceMemoryRetryContext,sourceReviewCandidateSha} from './source-memory-run-state.ts';
test('retry owns a fresh snapshot while predecessor and unrelated authority remain intact',()=>{
 const old={sourceSnapshot:{revision:'a'.repeat(40)},reviewCandidateSha:'b'.repeat(40),executionRetryAccounting:{attempt:2}};
 const next=freshSourceMemoryRetryContext(old);
 assert.equal('sourceSnapshot' in next,false);
 assert.equal(old.sourceSnapshot.revision,'a'.repeat(40));
 assert.equal(next.reviewCandidateSha,old.reviewCandidateSha);
 assert.deepEqual(next.executionRetryAccounting,{attempt:2});
});
test('review candidate is produced only for the assigned pending native stage',()=>{
 const state={status:'pending',currentStageType:'review',currentParticipant:{agentId:'reviewer'},reviewRequest:{candidateSha:'a'.repeat(40)}};
 assert.equal(sourceReviewCandidateSha(state,'reviewer'),'a'.repeat(40));
 for(const change of [{status:'completed'},{currentStageType:'approval'},{reviewRequest:null},{reviewRequest:{candidateSha:'main'}}])
  assert.equal(sourceReviewCandidateSha({...state,...change},'reviewer'),null);
 assert.equal(sourceReviewCandidateSha(state,'author'),null);
 assert.equal(sourceReviewCandidateSha(null,'reviewer'),null);
});

test('captured review consumer binds the exact task workspace revision stage and participant', () => {
 const sha='a'.repeat(40), scope={companyId:'company',issueId:'task',workspaceId:'workspace',bindingRevision:3};
 const receipt={schema:1,...scope,stageId:'stage',participantAgentId:'reviewer',candidateSha:sha};
 const state={status:'pending',currentStageId:'stage',currentStageType:'review',currentParticipant:{agentId:'reviewer'},
  reviewRequest:{candidateSha:sha},sourceReviewCapture:receipt};
 assert.equal(sourceReviewCandidateSha(state,'reviewer',scope),sha);
 for(const patch of [{companyId:'other'},{issueId:'other'},{workspaceId:'other'},{bindingRevision:4}])
  assert.equal(sourceReviewCandidateSha(state,'reviewer',{...scope,...patch}),null);
 for(const patch of [{schema:2},{stageId:'other'},{participantAgentId:'other'},{candidateSha:'b'.repeat(40)}])
  assert.equal(sourceReviewCandidateSha({...state,sourceReviewCapture:{...receipt,...patch}},'reviewer',scope),null);
 assert.equal(sourceReviewCandidateSha({...state,sourceReviewCapture:null},'reviewer',scope),null,'old saved stage is preserved but cannot acquire new evidence authority');
 assert.equal(sourceReviewCandidateSha({...state,currentStageId:'other'},'reviewer',scope),null);
 assert.equal(sourceReviewCandidateSha(state,'author',scope),null);
 assert.equal(state.sourceReviewCapture,receipt,'consumer never rewrites saved state');
});
