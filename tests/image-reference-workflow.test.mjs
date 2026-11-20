import test from 'node:test';
import assert from 'node:assert/strict';
import {imageReferenceResearchInput,randomReferenceIndex} from '../dist/image-reference-workflow.js';
import {validateTopicResearchRequest} from '../dist/topic-research-protocol.js';

test('image reference research uses the existing bounded request and labels long-script excerpts',()=>{
  const source='앞부분 워해머 룰 설명. '+ '한글🙂'.repeat(40000)+' 마지막 교전 설명.';
  const {request,excerpted}=imageReferenceResearchInput(source,'워해머 40,000');
  assert.equal(excerpted,true);assert.deepEqual(validateTopicResearchRequest(request),request);
  assert.ok(Array.from(request.topic).length<=500);assert.ok(Array.from(request.instructions).length<=2000);
  assert.match(request.instructions,/앞·중간·마지막 발췌 · 전체 대본이 아님/u);
  assert.match(request.instructions,/앞부분 워해머/u);assert.match(request.instructions,/마지막 교전 설명/u);
});
test('short script reference research retains complete text without rewriting the project',()=>{
  const source='워해머 40k에서 엄폐 판정을 설명합니다.\n실제 미니어처의 위치를 보여 주세요.';
  const {request,excerpted}=imageReferenceResearchInput(source,'엄폐 룰');
  assert.equal(excerpted,false);assert.match(request.instructions,/\[전체 대본\]/u);assert.ok(request.instructions.endsWith(source));
  assert.throws(()=>imageReferenceResearchInput('  '),/대본/u);
});
test('another reference always differs when the local pool has alternatives',()=>{
  assert.equal(randomReferenceIndex(0),-1);assert.equal(randomReferenceIndex(1,0),0);
  for(const size of [2,3,20])for(let previous=0;previous<size;previous++)for(const random of [0,.2,.5,.99,1]){
    const index=randomReferenceIndex(size,previous,()=>random);assert.ok(index>=0&&index<size);assert.notEqual(index,previous);
  }
});
