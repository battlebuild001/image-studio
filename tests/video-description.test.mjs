import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cleanGeneratedVideoDescription} from '../dist/video-description.js';
import {buildProductionAssistantRequest,parseProductionAssistantResponse} from '../dist/production-assistant-protocol.js';
import {createProject,createScene,validateProject} from '../dist/project.js';
import {publishingToYouTubeMetadata} from '../dist/youtube-protocol.js';
const story='개척자들이 우주선을 타고 새로운 행성으로 떠납니다.\n\n도착한 행성에서는 도시를 건설하고 새로운 질서를 만듭니다.';
const compactStory='개척자들이 우주선을 타고 새로운 행성으로 떠납니다. 도착한 행성에서는 도시를 건설하고 새로운 질서를 만듭니다.';
const title='원본의 항해 이야기';
const context={title,currentTitle:title,fullScript:story,durationSeconds:120,scenes:[{id:'first',start:0,end:60,caption:'개척자들이 우주선을 타고 떠납니다.'},{id:'second',start:60,end:120,caption:'새로운 행성에 도시를 세웁니다.'}]};
const complete=value=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const kit=description=>({titles:[title,'도시가 시작된 순간'],description,chapters:[{start:0,title:'항해'},{start:60,title:'도시 건설'}],tags:['세계관','이주'],thumbnailConcepts:[{headline:'새로운 행성',prompt:'기존 장면의 실제 이미지를 활용합니다.',sceneId:'first'}],notes:[]});

test('new generated descriptions remove only known metadata and self-production boilerplate while keeping the original story',()=>{
 const value=`영상 제목: ${title}\n\n## 요약\n${story}\n\n이 영상은 한국어 나레이션과 AI 생성 이미지를 활용해 다큐멘터리 스타일로 구성했습니다.\n공식 자료를 확인했습니다.\n구독과 좋아요를 부탁드립니다.\n\n챕터\n00:00 항해\n01:00 도시 건설\n\n출처\n공식 설정 https://example.org/source\n\n#세계관 #우주`;
 assert.equal(cleanGeneratedVideoDescription(value,{titles:[title],sourceText:story}),story);
 assert.equal(cleanGeneratedVideoDescription(cleanGeneratedVideoDescription(value,{titles:[title],sourceText:story}),{titles:[title],sourceText:story}),story);
 assert.throws(()=>cleanGeneratedVideoDescription('가'.repeat(16001)),/길이/u);
});

test('conservative cleanup retains factual title/summary words, story clocks and source-evidenced technical subject matter',()=>{
 const factual='위원회는 영상 제목을 변경했고 요약 보고서를 공개했습니다.\n1991년 밤 00:00에 탐사대가 출발했습니다.\n이 영상은 음성 합성 기술의 제작 과정을 설명합니다.';
 assert.equal(cleanGeneratedVideoDescription(factual,{titles:['다른 제목'],sourceText:factual}),factual);
 assert.equal(cleanGeneratedVideoDescription('요약: 개척자들이 도시에 정착합니다.\n\n설명\n새로운 질서가 시작됩니다.'),'개척자들이 도시에 정착합니다.\n\n새로운 질서가 시작됩니다.');
 assert.equal(cleanGeneratedVideoDescription(title+'\n'+story,{titles:[title]}),story);
});

test('mixed user-style story and documentary wording keeps every LEAP/ABOL fact rather than deleting the entire sentence',()=>{
 const source='인류는 대규모 우주 이주 계획 LEAP를 추진합니다. 식민 행성 ABOL에서는 권력과 사회 구조가 변합니다.';
 const generated='이 영상은 인류의 대규모 우주 이주 계획 LEAP와 식민 행성 ABOL에서 벌어지는 권력과 사회 구조의 변화를 서사적으로 정리한 내러티브 다큐 스타일의 단편 영상입니다.';
 assert.equal(cleanGeneratedVideoDescription(generated,{sourceText:source}),'인류의 대규모 우주 이주 계획 LEAP와 식민 행성 ABOL에서 벌어지는 권력과 사회 구조의 변화를 다룹니다.');
 const ambiguous='이 영상은 LEAP 이주와 ABOL 정착을 AI 이미지와 나레이션으로 재현합니다.';
 assert.throws(()=>cleanGeneratedVideoDescription(ambiguous,{sourceText:source}),/한 문장에 섞여/u);
 const actualClaim='공식 자료를 확인한 위원회는 ABOL 정착을 승인했습니다.';
 assert.equal(cleanGeneratedVideoDescription(actualClaim,{sourceText:source}),actualClaim);
});

test('publishing and single-description AI share content-only prompts and normalized output without changing sibling fields',()=>{
 const raw=`영상 제목: ${title}\n\n요약\n${story}\n\n챕터\n00:00 항해\n01:00 도시 건설\n\n출처: https://example.org/source`;
 const input={task:'publishing',context,options:{}},original=kit(raw),result=parseProductionAssistantResponse(complete(original),input,'gpt-5-mini',new Date('2026-11-04T04:00:00Z'));
 assert.equal(result.description,compactStory);for(const key of['titles','chapters','thumbnailConcepts','notes'])assert.deepEqual(result[key],original[key]);assert.deepEqual(result.tags,[],'AI publishing leaves tag selection to the miniature-game picker');assert.deepEqual(original.tags,['세계관','이주']);assert.equal(original.description,raw);
 for(const task of['publishing','upload-description']){
  const payload=buildProductionAssistantRequest({task,context,options:{}});assert.match(payload.instructions,/실제 사건·인물·배경·논점/u);assert.match(payload.instructions,/제목 반복/u);assert.match(payload.instructions,/챕터 목록·타임코드/u);assert.match(payload.instructions,/제작 과정/u);assert.match(payload.instructions,/주제 자체의 사실/u);assert.equal(payload.tools,undefined);assert.equal(JSON.parse(payload.input[0].content[0].text).context.fullScript,story);
  const value=task==='publishing'?kit(raw):{description:raw};assert.equal(parseProductionAssistantResponse(complete(value),{task,context,options:{}}).description,compactStory);
  const empty=task==='publishing'?kit('요약\n출처: https://example.org/source'):{description:'요약\n출처: https://example.org/source'};assert.throws(()=>parseProductionAssistantResponse(complete(empty),{task,context,options:{}}));
 }
});

test('legacy and manually edited publishing descriptions are neither cleaned on project load nor supplemented on YouTube handoff',()=>{
 const manual='영상 제목: 사용자가 직접 쓴 문구\n\n요약\n수동으로 보존할 설명입니다.\n\n00:00 직접 적은 시간\n#사용자태그';
 const project=createProject({title,scenes:[createScene({id:'first',duration:120,caption:story})],production:{version:1,publishing:{result:{...kit(manual),model:'gpt-5-mini',createdAt:'2026-11-04T04:00:00.000Z'},selectedTitle:0}}}),before=structuredClone(project),loaded=validateProject(project),metadata=publishingToYouTubeMetadata(loaded);
 assert.equal(loaded.production.publishing.result.description,manual);assert.equal(metadata.description,manual);assert.deepEqual(metadata.tags,['세계관','이주']);assert.deepEqual(loaded.production.publishing.result.chapters,before.production.publishing.result.chapters);assert.deepEqual(project,before);
});
