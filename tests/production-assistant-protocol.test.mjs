import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {ProductionAssistantError, validateProductionAssistantRequest, buildProductionAssistantRequest, parseProductionAssistantResponse, normalizeProductionAssistantResult} from '../dist/production-assistant-protocol.js';
const date='2026-10-31T04:00:00.000Z';
const png=(await readFile(new URL('./fixtures/image-test-1.png',import.meta.url))).toString('base64');
const completed=data=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(data)}]}]});
const input=(task,options={})=>({task,context:{title:'합성 영상',fullScript:'인류의 이주와 도시 건설을 설명합니다.',durationSeconds:120,scenes:[{sceneId:'scene-1',start:0,end:60,caption:'첫 번째 도시'}]},options});
const reviewInput=()=>({...input('visual-review',{sceneIds:['scene-1']}),images:[{mimeType:'image/png',data:png,role:'scene',sceneId:'scene-1',label:'첫 도시'}]});
const review=()=>({summary:'대본과 장면을 비교한 검토 후보입니다.',findings:[{sceneId:'scene-1',severity:'warning',reason:'대본은 민간 도시를 설명하지만 장비가 강조되어 있습니다.',suggestion:'건물과 생활 공간 중심으로 다시 구성해 보세요.'}],notes:['자동 판정은 검토 후보입니다.']});
const diagram=()=>({title:'이주 연표',cards:[{id:'card-1',type:'timeline',title:'도시의 탄생',subtitle:'제공된 연표만 사용',events:[{date:'2030',label:'정착',detail:'탐사대가 정착지를 세웠습니다.'}],nodes:[],edges:[],series:[],notes:[]}],notes:[]});
const shorts=()=>({title:'도시의 탄생',hook:'어떻게 시작되었을까요?',segments:[{start:0,end:10,label:'도입'},{start:20,end:35,label:'핵심'}],notes:[]});
const publishing=()=>({titles:['도시가 시작된 순간'],description:'이주와 도시 건설을 다루는 영상입니다.',chapters:[{start:0,title:'도입'},{start:60,title:'도시 건설'}],tags:['세계관','도시'],thumbnailConcepts:[{headline:'도시는 어떻게 탄생했나',prompt:'기존 도시 장면을 배경으로 큰 글자를 배치합니다.',sceneId:'scene-1'}],notes:[]});

test('actual vision pixels, labels and full context enter one strict Responses request with no external image fetch or paid tool fallback',()=>{
  const request=reviewInput(),payload=buildProductionAssistantRequest(request,'gpt-5-mini');
  assert.equal(payload.store,false);assert.equal(payload.tools,undefined);assert.equal(payload.model,'gpt-5-mini');assert.equal(payload.text.format.strict,true);
  assert.equal(payload.input[0].content[1].type,'input_image');assert.equal(payload.input[0].content[1].image_url,'data:image/png;base64,'+png);
  const encoded=JSON.parse(payload.input[0].content[0].text);assert.equal(encoded.context.fullScript,request.context.fullScript);assert.equal(encoded.imageIndex[0].sceneId,'scene-1');assert.equal(encoded.imageIndex[0].data,undefined);
  assert.match(payload.instructions,/실제 웹 검색은 이 요청에 포함되지/);
  const result=parseProductionAssistantResponse(completed(review()),request,'gpt-5-mini',new Date(date));assert.equal(result.findings[0].sceneId,'scene-1');assert.equal(result.createdAt,date);
});
test('missing pixels, mismatched image roles/types/ids, leaked keys and invalid requested tools fail before provider requests',()=>{
  for(const request of [input('visual-review'),{...reviewInput(),images:[{mimeType:'image/jpeg',data:png,sceneId:'scene-1'}]},
    {...reviewInput(),images:[{mimeType:'image/png',data:png,sceneId:'wrong-scene'}]},
    {...reviewInput(),images:[{mimeType:'image/png',data:'AAAA',sceneId:'scene-1'}]},
    {...input('shorts'),options:{targetSeconds:45}},input('not-a-tool'),
    {...input('diagrams'),options:{maxCards:0}},{...input('diagrams'),options:{type:'html'}},
    {...input('publishing'),context:{apiKey:'hidden'}},{...input('publishing'),context:{text:'sk-synthetic-key-must-never-be-content'}},
    {...input('publishing'),images:reviewInput().images},{...input('publishing'),endpoint:'https://evil.example'},
  ]) assert.throws(()=>validateProductionAssistantRequest(request),ProductionAssistantError);
});
test('review only applies findings for scene IDs whose actual pixels were submitted',()=>{
  const request=reviewInput(),wrong=review();wrong.findings[0].sceneId='scene-2';
  assert.throws(()=>parseProductionAssistantResponse(completed(wrong),request),/실제 이미지/);
  const noImageEvidence={...review(),findings:[]};assert.equal(parseProductionAssistantResponse(completed(noImageEvidence),request).findings.length,0);
});
test('structured information cards preserve source facts and enforce readable graph/position/card limits',()=>{
  const request=input('diagrams',{type:'timeline',maxCards:1});assert.equal(parseProductionAssistantResponse(completed(diagram()),request).cards[0].events[0].date,'2030');
  const oversized=diagram();oversized.cards[0].events=Array.from({length:13},()=>({date:'2030',label:'정착',detail:''}));assert.throws(()=>parseProductionAssistantResponse(completed(oversized),request));
  const wrong=diagram();wrong.cards[0].type='map';wrong.cards[0].events=[];wrong.cards[0].nodes=[{id:'node-1',label:'거점',x:1.1,y:.2}];assert.throws(()=>parseProductionAssistantResponse(completed(wrong),input('diagrams',{type:'map'})));
  wrong.cards[0].nodes[0].x=.5;wrong.cards[0].edges=[{from:'node-1',to:'invented',label:'이동'}];assert.throws(()=>parseProductionAssistantResponse(completed(wrong),input('diagrams',{type:'map'})));
});
test('shorts use original source seconds, reject overlap/out-of-source ranges and respect 30/60-second total',()=>{
  const request=input('shorts',{targetSeconds:30});assert.equal(parseProductionAssistantResponse(completed(shorts()),request).segments.length,2);
  for(const segments of [[{start:0,end:31,label:'너무 긴 선택'}],[{start:0,end:10,label:'첫 구간'},{start:8,end:15,label:'겹친 구간'}],[{start:115,end:125,label:'원본 밖'}]]) assert.throws(()=>parseProductionAssistantResponse(completed({...shorts(),segments}),request));
});
test('publishing assets reference actual scene IDs and ordered in-range chapter timestamps without claiming upload',()=>{
  const request=input('publishing');const result=parseProductionAssistantResponse(completed(publishing()),request);assert.equal(result.thumbnailConcepts[0].sceneId,'scene-1');
  const wrong=publishing();wrong.thumbnailConcepts[0].sceneId='made-up';assert.throws(()=>parseProductionAssistantResponse(completed(wrong),request));wrong.thumbnailConcepts[0].sceneId='';assert.equal(parseProductionAssistantResponse(completed(wrong),request).thumbnailConcepts[0].sceneId,'');
  wrong.chapters=[{start:70,title:'먼저'},{start:20,title:'역순'}];assert.throws(()=>parseProductionAssistantResponse(completed(wrong),request));
});
test('partial rewriting returns separate display/narration; refusal/incomplete/malformed output never becomes a result',()=>{
  const request=input('rewrite-section');const result=parseProductionAssistantResponse(completed({displayScript:'1991년 NASA',narrationScript:'일구구일년 나사',notes:[]}),request);assert.notEqual(result.displayScript,result.narrationScript);
  for(const response of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]},completed({displayScript:'',narrationScript:'본문',notes:[]}),completed({displayScript:'1991년',narrationScript:'일구구일년',notes:[],raw:'provider'})]) assert.throws(()=>parseProductionAssistantResponse(response,request));
  assert.throws(()=>normalizeProductionAssistantResult('rewrite-section',{displayScript:'1991년',narrationScript:'일구구일년',notes:[],model:'gpt-5-mini',createdAt:'2026-02-30T04:00:00.000Z'}));
});
