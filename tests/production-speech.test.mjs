import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizePronunciations,applyPronunciationDictionary,parsePronunciationLines,pronunciationLines,getDisplayScript,getNarrationScript,applyPronunciations} from '../dist/production-speech.js';
import {validateScriptRequest,buildScriptRequest,parseScriptResponse,ScriptApiError} from '../dist/script-protocol.js';
import {createProject,validateProject,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {planTimedScenes,getScenePlanStatus,narrationPlanKey} from '../dist/script-planning.js';

const rules = [{term:'ABOL',reading:'아볼'},{term:'UN',reading:'유엔'},{term:'First Wave',reading:'퍼스트 웨이브'}];
const display = '1991년, ABOL로 향하는 UN의 계획이 시작됩니다.\n\n첫 이주민들은 먼 항성을 향해 출발하고 새로운 땅을 기다렸습니다.';
const spoken = '일구구일년, 아볼로 향하는 유엔의 계획이 시작됩니다.\n\n첫 이주민들은 먼 항성을 향해 출발하고 새로운 땅을 기다렸습니다.';
const input = {sourceText:'The expedition approaches ABOL. The United Nations prepares a settlement mission. The fictional chronology is distinct from actual historical events.',targetMinutes:1,charsPerMinute:330,instructions:'가상 세계관의 설정을 시간순으로 설명하세요.',narrationStyle:'korean-digits',pronunciations:rules};
const response = (screen = display, script = '1991년, ABOL로 향하는 유엔의 계획이 시작됩니다.\n\n첫 이주민들은 먼 항성을 향해 출발하고 새로운 땅을 기다렸습니다.') => ({status:'completed',output:[{type:'web_search_call',status:'completed',action:{sources:[{title:'합성 설정 자료',url:'https://example.org/fictional-timeline'}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify({title:'이주의 시작',summary:'테스트용 설정 요약입니다.',script,...(screen === undefined ? {} : {displayScript:screen}),notes:[]})}]}]});

test('dictionary validates bounded unique terms, preserves case-insensitive readings and escapes regex input',()=>{
  assert.deepEqual(normalizePronunciations([{term:' ABOL ',reading:' 아볼 '}]),[{term:'ABOL',reading:'아볼'}]);
  for(const value of [null,{},[{term:'',reading:'읽기'}],[{term:'ABOL',reading:''}],[{term:'ABOL',reading:'아볼'},{term:'abol',reading:'에이볼'}],[{term:'ABOL',reading:'아볼',endpoint:'https://evil.invalid'}]]) assert.throws(()=>normalizePronunciations(value));
  assert.equal(applyPronunciationDictionary('A.BoL과 AxBoL', [{term:'A.BoL',reading:'아볼'}]),'아볼과 AxBoL');
  assert.throws(()=>normalizePronunciations(Array.from({length:201},(_,index)=>({term:`word${index}`,reading:'읽기'}))));
  assert.throws(()=>normalizePronunciations([{term:'First Wave',reading:'첫 물결'},{term:'First  Wave',reading:'다른 발음'}]));
});

test('dictionary uses longest one-pass matching, keeps Latin word boundaries and accepts Korean particles',()=>{
  const dictionary=[{term:'First Wave',reading:'첫 물결'},{term:'Wave',reading:'웨이브'},{term:'첫 물결',reading:'다른 말'},{term:'ABOL',reading:'아볼'},{term:'UN',reading:'유엔'}];
  assert.equal(applyPronunciationDictionary('first   wave, Wave, ABOL은 ABOLITE와 ABOL2를 만나 UN의 UNITED를 봅니다.',dictionary),'첫 물결, 웨이브, 아볼은 ABOLITE와 ABOL2를 만나 유엔의 UNITED를 봅니다.');
  assert.deepEqual(parsePronunciationLines('ABOL = 아볼\nUN → 유엔\n'),rules.slice(0,2));
  assert.equal(pronunciationLines(rules.slice(0,2)),'ABOL = 아볼\nUN = 유엔');assert.throws(()=>parsePronunciationLines('ABOL'));
  assert.equal(applyPronunciationDictionary('First\n\nWave',dictionary),'First\n\n웨이브','A phrase rule must not join separate paragraphs');
});

test('display and spoken helpers preserve independent text and explicit empty edits without reconstructing lost original numbers',()=>{
  const project={scriptDraft:{draftScript:spoken,displayScript:display},scenes:[{caption:'다른 자막'}]};
  assert.equal(getDisplayScript(project),display);assert.equal(getNarrationScript(project),spoken);
  assert.equal(getDisplayScript({scriptDraft:{draftScript:spoken}}),spoken,'Legacy phonetic text is not falsely reversed into original digits');
  assert.equal(getDisplayScript({scriptDraft:{draftScript:spoken,displayScript:''}}),'');assert.equal(getNarrationScript({scriptDraft:{draftScript:'',result:{script:spoken}}}),'');
  const before=display;assert.equal(applyPronunciations(display,rules,'korean-digits'),spoken);assert.equal(display,before);
  assert.ok(!applyPronunciations(display+'\nhttps://example.org/research\n(.gg)',rules,'korean-digits').includes('example.org'));
});

test('script transport sends original references, separate dictionary and optional channel tone without changing user instructions',()=>{
  const value=validateScriptRequest({...input,channelTone:'차분하고 쉽게 설명',channelName:'내 채널'}),payload=buildScriptRequest(value),sent=JSON.parse(payload.input[0].content[0].text);
  assert.deepEqual(sent.pronunciationDictionary,rules);assert.equal(sent.referenceMaterial,input.sourceText);assert.equal(sent.productionInstructions,input.instructions);assert.equal(sent.channelTone,'차분하고 쉽게 설명');
  assert.ok(payload.text.format.schema.required.includes('displayScript'));assert.match(payload.instructions,/displayScript/u);assert.match(payload.instructions,/채널|channelName/u);
  assert.throws(()=>validateScriptRequest({...input,pronunciations:[{term:'A',reading:''}]}),ScriptApiError);assert.throws(()=>validateScriptRequest({...input,channelTone:'가'.repeat(2001)}),ScriptApiError);
});

test('completed researched result keeps digits/names for display and applies dictionary only to spoken narration',()=>{
  const result=parseScriptResponse(response(),validateScriptRequest(input),new Date('2026-10-31T04:00:00Z'));
  assert.equal(result.displayScript,display);assert.equal(result.script,spoken);assert.ok(result.displayScript.includes('1991년'));assert.ok(result.displayScript.includes('ABOL'));assert.ok(!result.script.includes('ABOL'));
  const legacy=response();delete JSON.parse(legacy.output[1].content[0].text).displayScript;
  legacy.output[1].content[0].text=JSON.stringify({title:'이주의 시작',summary:'요약',script:spoken,notes:[]});const previous=parseScriptResponse(legacy,input);assert.equal(Object.hasOwn(previous,'displayScript'),false);
  for(const bad of ['',42,'https://example.org']) assert.throws(()=>parseScriptResponse(response(bad),input),ScriptApiError);
});

test('dual scripts and pronunciation dictionary survive canonical project and portable backup independently',async()=>{
  const value=createProject({scriptDraft:{draftScript:spoken,displayScript:display,result:null},production:{version:1,speech:{pronunciations:rules,updatedAt:'2026-10-31T04:00:00.000Z'}}});
  const project=validateProject(value);assert.equal(project.scriptDraft.displayScript,display);assert.equal(project.scriptDraft.draftScript,spoken);assert.deepEqual(project.production.speech.pronunciations,rules);
  const restored=await importProjectBackup(await exportProjectBackup(project,new Map()));assert.equal(restored.project.scriptDraft.displayScript,display);assert.equal(restored.project.scriptDraft.draftScript,spoken);assert.deepEqual(restored.project.production.speech.pronunciations,rules);
});

test('image plan currentness follows display facts while spoken-only pronunciation edits leave visual timing valid',()=>{
  const planned=planTimedScenes(display,[],{intervalSeconds:10,totalSeconds:60,targetBasis:'target'}),project=createProject({scenes:planned.scenes,scriptDraft:{draftScript:spoken,displayScript:display}});
  project.scenePlan={version:1,intervalSeconds:planned.intervalSeconds,durationSeconds:planned.durationSeconds,basis:planned.basis,sourceScript:planned.sourceScript,narrationKey:narrationPlanKey(project),items:planned.items,confirmedAt:'2026-10-31T04:00:00.000Z'};
  assert.equal(getScenePlanStatus(project).valid,true);project.scriptDraft.draftScript=spoken.replace('아볼','에이볼');assert.equal(getScenePlanStatus(project).valid,true);
  project.scriptDraft.displayScript=display.replace('1991','1992');assert.equal(getScenePlanStatus(project).valid,false);
});
