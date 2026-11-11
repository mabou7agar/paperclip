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
