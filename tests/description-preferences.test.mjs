import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SUPPORT_BLOCK,normalizeDescriptionPreferences,getDescriptionPreferences,setDescriptionPreferences,compactDescriptionText,composeSupportBlock,composeVideoDescription,getDescriptionSummary} from '../dist/description-preferences.js';
import {createProject,createScene,validateProject,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {buildProductionAssistantRequest,validateProductionAssistantRequest,normalizeProductionAssistantResult} from '../dist/production-assistant-protocol.js';
import {generateUploadMetadata,uploadMetadataSourceKey} from '../dist/upload-metadata.js';
const exact=`이번 영상은 배틀테이블하비의 지원으로 제작되었습니다.
배틀테이블하비는 미니어처 전문 온라인 & 오프라인 스토어입니다.
국내에서 가장 많은 게임을 튜토리얼하고 플레이하며 서비스하고 있습니다.

제작 지원 : 배틀테이블하비
스토어 링크 : https://smartstore.naver.com/battletablehobby
제품 문의 : https://open.kakao.com/o/gbYU7X8h`;
const paragraph=Array.from({length:8},(_,n)=>`${n+1}번째 도시는 개척자들의 새로운 거점으로 세워졌고 주변 지역과 교역하며 서로 다른 세력의 갈등을 겪었습니다.`).join(' ');
const context={title:'도시의 탄생',fullScript:paragraph,durationSeconds:120,scenes:[{id:'first',start:0,end:120,caption:paragraph}]};
const publishing=description=>({titles:['도시의 탄생'],description,chapters:[],tags:['SF','도시'],thumbnailConcepts:[{headline:'도시의 시작',prompt:'실제 장면을 활용합니다.',sceneId:'first'}],notes:[]});
function fixture(){return createProject({title:'도시의 탄생',scenes:[createScene({id:'first',duration:120,caption:paragraph})],production:{version:1,youtube:{draft:{title:'수동 제목',description:'수동 설명',tags:['BLKOUT'],privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true}}}});}
const normalized=(task,value,input)=>normalizeProductionAssistantResult(task,{...value,model:'synthetic',createdAt:'2026-11-05T00:00:00.000Z'},input);
function sentenceCount(value){return Array.from(new Intl.Segmenter('ko',{granularity:'sentence'}).segment(value)).filter(item=>item.segment.trim()).length;}

test('legacy defaults are short and sponsorship-free without creating project data; explicit typed choices retain sibling fields',()=>{
  const project=createProject(),before=structuredClone(project);assert.deepEqual(getDescriptionPreferences(project),{length:'short',support:false,hashtags:true});assert.deepEqual(project,before);assert.equal(Object.hasOwn(project,'production'),false);
  const configured=fixture(),siblings=structuredClone(configured);assert.equal(setDescriptionPreferences(configured,{length:'standard',support:true}),configured);assert.deepEqual(configured.production.description,{length:'standard',support:true,hashtags:true});assert.deepEqual(configured.production.youtube,siblings.production.youtube);assert.deepEqual(configured.scenes,siblings.scenes);assert.deepEqual(configured.audio,siblings.audio);
  assert.deepEqual(normalizeDescriptionPreferences({}),{length:'short',support:false,hashtags:true});for(const bad of[null,[],{length:null},{length:'long'},{length:3},{support:'false'},{support:null},{length:'short',token:'secret'}])assert.throws(()=>normalizeDescriptionPreferences(bad));
});
test('optional description preferences survive actual portable project restoration without altering legacy projects or tags',async()=>{
  const project=fixture();setDescriptionPreferences(project,{length:'standard',support:true});const before=structuredClone(project),backup=await exportProjectBackup(project,new Map()),restored=await importProjectBackup(await backup.text());assert.deepEqual(restored.project.production.description,{length:'standard',support:true,hashtags:true});assert.deepEqual(restored.project.production.youtube.draft.tags,['BLKOUT']);assert.deepEqual(restored.project.scenes,before.scenes);assert.deepEqual(project,before);
  assert.equal(Object.hasOwn(validateProject(createProject()),'production'),false);for(const bad of[null,[],{length:'huge',support:false},{length:'short',support:1},{length:'short',support:false,extra:'field'}])assert.throws(()=>validateProject(createProject({production:{version:1,description:bad}})));
});
test('generated summaries prefer complete source sentences within independent short and standard caps',()=>{
  const short=compactDescriptionText(paragraph,{length:'short'}),standard=compactDescriptionText(paragraph,{length:'standard'});assert.ok(Array.from(short).length<=350);assert.ok(sentenceCount(short)<=3);assert.ok(Array.from(standard).length<=800);assert.ok(sentenceCount(standard)<=5);assert.ok(standard.length>short.length);assert.ok(paragraph.startsWith(short));assert.ok(paragraph.startsWith(standard));assert.equal(short.endsWith('습니다.'),true);assert.equal(compactDescriptionText(short),short);
  assert.equal(compactDescriptionText('1991년에는 4.25초의 신호가 수신되었습니다. 이후 새 행성을 발견했습니다.'),'1991년에는 4.25초의 신호가 수신되었습니다. 이후 새 행성을 발견했습니다.');assert.equal(compactDescriptionText('짧은 원문입니다.'),'짧은 원문입니다.');assert.throws(()=>compactDescriptionText(paragraph,{length:'long'}));
});
test('oversized single sentences use a visibly shortened Unicode-safe prefix while complete preceding sentences stay whole',()=>{
  const text='🚀'.repeat(500),short=compactDescriptionText(text),standard=compactDescriptionText(text.repeat(2),{length:'standard'});assert.equal(Array.from(short).length,350);assert.equal(Array.from(standard).length,800);assert.ok(short.endsWith('…'));assert.equal(short.includes('\uFFFD'),false);
  const first='첫 도시는 항구에 세워졌습니다. 둘째 도시는 내륙에 세워졌습니다.';assert.equal(compactDescriptionText(first+' '+'아주긴문장'.repeat(200)),first);
});
test('the exact support block is locally appended only when selected and repeated composition never duplicates or cuts it',()=>{
  assert.equal(SUPPORT_BLOCK,exact);const body='새로운 행성에서 도시와 질서가 만들어집니다.';assert.equal(composeVideoDescription(body,{length:'short',support:false,hashtags:true}),body);assert.doesNotMatch(composeVideoDescription(body),/배틀테이블하비|smartstore|open\.kakao/u);
  const result=composeVideoDescription(paragraph,{length:'short',support:true});assert.ok(result.endsWith('\n\n'+exact));assert.ok(Array.from(getDescriptionSummary(result)).length<=350);assert.equal(composeVideoDescription(result,{length:'short',support:true}),result);assert.equal(composeSupportBlock(result,true),result);
  const duplicated=body+'\n\n'+exact+'\n\n'+exact;assert.equal(composeSupportBlock(duplicated,true),body+'\n\n'+exact);assert.equal(composeSupportBlock(duplicated,false),body);assert.equal(getDescriptionSummary(exact),'');
});
test('whitespace typed after the owned complete support block cannot create a duplicate or prevent explicit removal',()=>{
  const body='수동 본문입니다.\n\n ',on=composeSupportBlock(body,true);for(const tail of['\n','\r\n','  \n\t']){assert.equal(composeSupportBlock(on+tail,true),on);assert.equal(composeSupportBlock(on+tail,false),body);assert.equal(getDescriptionSummary(on+tail),body);}const edited=on.replace('서비스하고 있습니다.','서비스합니다.');assert.equal(composeSupportBlock(edited,false),edited);
});
test('manual checkbox changes preserve every body character and never remove ordinary store mentions, URLs or inline text',()=>{
  const manual='  직접 쓴 소개입니다.\r\n\r\n배틀테이블하비 매장을 방문했습니다.\n스토어 https://smartstore.naver.com/battletablehobby\n\n';assert.equal(composeSupportBlock(manual,false),manual);const on=composeSupportBlock(manual,true);assert.equal(on,manual+'\n\n'+exact);assert.equal(composeSupportBlock(on,false),manual);assert.equal(getDescriptionSummary(manual),manual);
  const middle=exact+'\n이 내용은 영상 속 매장에 관한 기록입니다.';assert.equal(composeSupportBlock(middle,false),middle);assert.equal(composeSupportBlock('본문 중 '+exact,false),'본문 중 '+exact);assert.throws(()=>composeSupportBlock(manual,'false'));
});
test('manual overflow rejects the whole support change while generated bodies and the fixed block fit YouTube UTF8 limits',()=>{
  const manual='가'.repeat(1666),before=manual;assert.throws(()=>composeSupportBlock(manual,true),/5,000바이트/u);assert.equal(manual,before);assert.equal(composeSupportBlock(manual,false),manual);
  for(const length of['short','standard']){const result=composeVideoDescription('🚀'.repeat(3000),{length,support:true});assert.ok(new TextEncoder().encode(result).byteLength<=5000);assert.ok(result.endsWith(exact));assert.equal(getDescriptionSummary(result).includes('https://'),false);}
});
test('both AI tasks request only the selected summary length and normalize wrappers before compaction with no generated support or tags',()=>{
  for(const task of['publishing','upload-description'])for(const length of['short','standard']){
    const request={task,context,options:{descriptionLength:length}},payload=buildProductionAssistantRequest(request);assert.match(payload.instructions,length==='short'?/2~3문장.*150~300자.*350자/u:/4~5문장.*400~700자.*800자/u);assert.doesNotMatch(payload.instructions,/battletablehobby|gbYU7X8h|배틀테이블하비/u);
    const raw='영상 제목: 도시의 탄생\n요약\n'+paragraph+'\n\n챕터\n00:00 시작\n\n출처: https://example.test/story',result=normalized(task,task==='publishing'?publishing(raw):{description:raw},request);assert.ok(Array.from(result.description).length<=(length==='short'?350:800));assert.ok(sentenceCount(result.description)<=(length==='short'?3:5));assert.doesNotMatch(result.description,/영상 제목|요약|00:00|https:\/\//u);if(task==='publishing')assert.deepEqual(result.tags,[]);
    const withBlock=normalized(task,task==='publishing'?publishing(paragraph+'\n\n'+exact):{description:paragraph+'\n\n'+exact},request);assert.doesNotMatch(withBlock.description,/배틀테이블하비|smartstore|kakao/u);
  }
  for(const bad of[{descriptionLength:'long'},{descriptionLength:null},{support:true}])assert.throws(()=>validateProductionAssistantRequest({task:'upload-description',context,options:bad}));assert.throws(()=>validateProductionAssistantRequest({task:'upload-title',context,options:{descriptionLength:'short'}}));
});
test('upload helper keeps support local, sends one explicit length request, and source keys invalidate changed preferences only',async()=>{
  const project=fixture(),initial=uploadMetadataSourceKey(project);project.production.budget={spentUsd:1};assert.equal(uploadMetadataSourceKey(project),initial);setDescriptionPreferences(project,{length:'standard',support:true});const configured=uploadMetadataSourceKey(project);assert.notEqual(configured,initial);const before=structuredClone(project),calls=[];
  const api={getProject:()=>project,apiFetch:async(path,options)=>{calls.push({path,options});return Response.json({description:paragraph,model:'synthetic',createdAt:'2026-11-05T00:00:00.000Z'});}};const result=await generateUploadMetadata(api,{field:'description'});assert.equal(calls.length,1);const request=JSON.parse(calls[0].options.body);assert.deepEqual(request.options,{descriptionLength:'standard'});assert.equal(calls[0].options.body.includes('battletablehobby'),false);assert.equal(calls[0].options.body.includes('배틀테이블하비'),false);assert.ok(result.description.endsWith(exact));assert.ok(sentenceCount(getDescriptionSummary(result.description))<=5);assert.deepEqual(project,before);
  setDescriptionPreferences(project,{length:'standard',support:false});assert.notEqual(uploadMetadataSourceKey(project),configured);
});
