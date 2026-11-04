import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stripEnglishParentheticalGlosses,cleanNarrationText,formatNarrationText} from '../dist/narration-text.js';
import {validateScriptRequest,buildScriptRequest,parseScriptResponse} from '../dist/script-protocol.js';
import {applyPronunciations,getNarrationScript,getDisplayScript} from '../dist/production-speech.js';

test('Korean names keep one spelling while factual and standalone parentheticals remain intact',()=>{
 const pairs=[
  ['헤드리스(Headless)는 길을 떠났습니다.','헤드리스는 길을 떠났습니다.'],
  ['브레스 오브 갓 (Breath of God)이 멈췄습니다.','브레스 오브 갓이 멈췄습니다.'],
  ['안보법(SSSA)과 유엔(U.N.)이 등장했습니다.','안보법과 유엔이 등장했습니다.'],
  ['헤드리스（Ｈｅａｄｌｅｓｓ）와 노스웨스트(North-West).','헤드리스와 노스웨스트.'],
  ['헤드리스( Headless )의 기록입니다.','헤드리스의 기록입니다.'],
 ];
 for(const[input,expected]of pairs){assert.equal(stripEnglishParentheticalGlosses(input),expected);assert.equal(stripEnglishParentheticalGlosses(expected),expected);}
 const facts='기지는 1991년(첫 관측) 세워졌고 규모(120명)는 남았습니다. 수식(x + y)와 기호(A), 버전(v2.1), (Headless)라는 원문 인용을 보존합니다.';
 assert.equal(stripEnglishParentheticalGlosses(facts),facts);
 assert.equal(stripEnglishParentheticalGlosses('헤드리스(Headless(부연)) 기록'), '헤드리스(Headless(부연)) 기록');
 assert.equal(stripEnglishParentheticalGlosses(null),'');
});
test('glosses disappear before dictionary or numeric phonetics can cause a second pronunciation',()=>{
 const text='1991년 헤드리스(Headless)와 안보법(SSSA)을 소개합니다.';
 assert.equal(cleanNarrationText(text),'1991년 헤드리스와 안보법을 소개합니다.');
 assert.equal(formatNarrationText(text,'korean-digits'),'일구구일년 헤드리스와 안보법을 소개합니다.');
 const result=applyPronunciations(text,[{term:'Headless',reading:'헤드리스'},{term:'SSSA',reading:'에스에스에스에이'}],'korean-digits');
 assert.equal(result,'일구구일년 헤드리스와 안보법을 소개합니다.');assert.equal((result.match(/헤드리스/gu)||[]).length,1);
});
test('restored display/spoken drafts and scene fallback are cleaned without mutating original project evidence',()=>{
 const project={scriptDraft:{sourceText:'Source Headless, 1991, and SSSA.',draftScript:'일구구일년 헤드리스(Headless)의 이야기입니다.',displayScript:'1991년 헤드리스(Headless)의 이야기입니다.',result:{summary:'원래 철자는 Headless입니다.',notes:['SSSA 원문을 보관합니다.'],script:'기존 결과(Original)입니다.'}}};
 const before=structuredClone(project);
 assert.equal(getNarrationScript(project),'일구구일년 헤드리스의 이야기입니다.');assert.equal(getDisplayScript(project),'1991년 헤드리스의 이야기입니다.');assert.deepEqual(project,before);
 assert.equal(getNarrationScript({scenes:[{caption:'헤드리스(Headless)의 첫 이야기입니다.'}]}),'헤드리스의 첫 이야기입니다.');
});
test('actual shared AI parsing preserves source/notes but returns separate clean subtitle and voice scripts',()=>{
 const input=validateScriptRequest({sourceText:'A synthetic chronology follows a group and a law. Original names are Headless and SSSA.',targetMinutes:1,charsPerMinute:330,narrationStyle:'korean-digits',pronunciations:[{term:'Headless',reading:'헤드리스'},{term:'SSSA',reading:'에스에스에스에이'}]});
 const before=structuredClone(input),raw={title:'기록의 흐름',summary:'원문 Headless와 SSSA 표기는 조사 메모에 보관했습니다.',script:'1991년 헤드리스(Headless)는 새로운 항로를 택했습니다. 안보법(SSSA)의 시행으로 마을의 이동 규칙이 바뀌었습니다.',displayScript:'1991년 헤드리스(Headless)는 새로운 항로를 택했습니다. 안보법(SSSA)의 시행으로 마을의 이동 규칙이 바뀌었습니다.',notes:['Headless와 SSSA는 원문 표기입니다.']};
 const result=parseScriptResponse({status:'completed',output:[{type:'web_search_call',status:'completed',action:{sources:[{url:'https://example.org/synthetic-chronology',title:'합성 연표'}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify(raw)}]}]},input,new Date('2026-11-04T10:00:00.000Z'));
 assert.equal(result.displayScript,'1991년 헤드리스는 새로운 항로를 택했습니다. 안보법의 시행으로 마을의 이동 규칙이 바뀌었습니다.');
 assert.equal(result.script,'일구구일년 헤드리스는 새로운 항로를 택했습니다. 안보법의 시행으로 마을의 이동 규칙이 바뀌었습니다.');
 assert.match(result.summary,/Headless/u);assert.match(result.notes[0],/SSSA/u);assert.equal(result.sources[0].url,'https://example.org/synthetic-chronology');assert.deepEqual(input,before);
 const payload=buildScriptRequest(input);assert.match(payload.instructions,/자막용 대본과 보이스용 대본/u);assert.match(payload.instructions,/괄호로 병기하지/u);assert.equal(JSON.parse(payload.input[0].content[0].text).referenceMaterial,input.sourceText);
});
