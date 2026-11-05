import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {formatNarrationText,normalizeGeneratedNarration,assertGeneratedNarrationPronunciation,parseScriptResponse,buildScriptRequest} from '../dist/script-protocol.js';
import {createDirectOpenAi} from '../dist/direct-openai.js';
import {createScriptApi} from '../scripts/script-api.mjs';

// Entirely synthetic source and provider output; no user material or live providers.
const settings={sourceText:'2077년의 가상 관측소 기록은 인구와 거리의 수치, 기관의 활동을 다룹니다.',targetMinutes:8,charsPerMinute:330,narrationStyle:'korean'};
const draft='2077년 NASA와 UN은 10만 명과 27km의 거리를 확인합니다.\n\n행방이 알려지지 않은 정찰대는 실종 상태로 남았습니다.';
const natural='이천칠십칠년 나사와 유엔은 십만 명과 이십칠킬로미터의 거리를 확인합니다.\n\n행방이 알려지지 않은 정찰대는 실종 상태로 남았습니다.';
const response=(script=draft,displayScript=draft)=>({status:'completed',output:[
  {type:'web_search_call',status:'completed',action:{sources:[{title:'합성 관측소 기록',url:'https://example.org/synthetic-observatory'}]}},
  {type:'message',content:[{type:'output_text',text:JSON.stringify({title:'관측소 이야기',summary:'작성용 메모입니다.',script,displayScript,notes:[]})}]},
]});

test('source-like Korean narration recovers leftover years, quantities and metric units in all four selected styles',()=>{
  const expected={standard:draft,korean:natural,'korean-digits':draft.replace('2077','이영칠칠').replace('NASA','나사').replace('UN','유엔').replace('10만','일영만').replace('27km','이칠킬로미터'),'korean-native-digits':draft.replace('2077','둘공일곱일곱').replace('NASA','나사').replace('UN','유엔').replace('10만','하나공만').replace('27km','둘일곱킬로미터')};
  for(const [narrationStyle,wanted] of Object.entries(expected)){
    const raw=response(),before=structuredClone(raw),result=parseScriptResponse(raw,{...settings,narrationStyle});
    assert.equal(result.script,wanted);assert.equal(result.displayScript,draft);assert.deepEqual(raw,before);assert.equal(result.script.split('\n\n').length,2);
    assert.match(result.script,/행방이 알려지지 않은 정찰대는 실종 상태로 남았습니다\./u);assert.deepEqual(result.sources,[{title:'합성 관측소 기록',url:'https://example.org/synthetic-observatory'}]);
    if(narrationStyle!=='standard'){assert.doesNotMatch(result.script,/[A-Za-z0-9]/u);assert.ok(result.notes.some(note=>note.includes('추가 AI 요청 없이')));}
  }
});

test('cardinal formatting uses exact string values, decimal zeroes and leading-zero identifier readings without rounding',()=>{
  assert.equal(formatNarrationText('1991년과 2077년, 10만 명, 27km, 1,991.050과 0.05, 식별자 001입니다.','korean'),'천구백구십일년과 이천칠십칠년, 십만 명, 이십칠킬로미터, 천구백구십일점영오영과 영점영오, 식별자 영영일입니다.');
  assert.equal(formatNarrationText('값은 9007199254740993과 10,000,001입니다.','korean'),'값은 구천칠조천구백구십이억오천사백칠십사만구백구십삼과 천만일입니다.');
  assert.equal(formatNarrationText('번호 000,001과 ０２０７, 거리 27 km입니다.','korean'),'번호 영영영영영일과 영이영칠, 거리 이십칠 킬로미터입니다.');
  assert.equal(formatNarrationText('1991년, 1,991.05, 0과 1.5입니다.','korean-digits'),'일구구일년, 일구구일점영오, 영과 일점오입니다.');
  assert.equal(formatNarrationText('1991년, 1,991.05, 0과 1.5입니다.','korean-native-digits'),'하나아홉아홉하나년, 하나아홉아홉하나점공다섯, 공과 하나점다섯입니다.');
  assert.equal(formatNarrationText('1991년, NASA와 UN, 27km입니다.','standard'),'1991년, NASA와 UN, 27km입니다.');
  assert.equal(formatNarrationText('코드는 27kmish와 12kg_name입니다.','korean'),'코드는 이십칠kmish와 십이kg_name입니다.');
});

test('explicit user pronunciation wins and is never rewritten by known acronym fallback or another rule',()=>{
  const recovered=normalizeGeneratedNarration('NASA와 UN이 관측을 이어갑니다.',{narrationStyle:'korean',pronunciations:[{term:'NASA',reading:'엔에이에스에이'},{term:'UN',reading:'연합 기구'}],sourceText:'나사(NASA), 유엔(UN)'});
  assert.equal(recovered.script,'엔에이에스에이와 연합 기구이 관측을 이어갑니다.');assert.deepEqual(recovered.residualTokens,[]);assertGeneratedNarrationPronunciation(recovered,'korean');
  const standard=normalizeGeneratedNarration('NASA와 UN이 관측을 이어갑니다.',{narrationStyle:'standard',pronunciations:[{term:'NASA',reading:'사용자 기관'}]});assert.equal(standard.script,'사용자 기관와 UN이 관측을 이어갑니다.');
  const unspoken=normalizeGeneratedNarration('NASA가 출발합니다.',{narrationStyle:'korean',pronunciations:[{term:'NASA',reading:'UN'}]});assert.equal(unspoken.script,'UN가 출발합니다.');assert.throws(()=>assertGeneratedNarrationPronunciation(unspoken,'korean'),{code:'PRONUNCIATION_REQUIRED'});
});

test('only unambiguous explicit aliases are recovered from raw source/display text and original evidence stays unchanged',()=>{
  const source='새 연합인 헤드리스(Headless)는 관측소로 갑니다.',display='헤드리스(Headless)는 2077년 관측소로 갑니다.',before={source,display};
  const result=normalizeGeneratedNarration('Headless는 2077년 관측소로 갑니다.',{narrationStyle:'korean',sourceText:source,displayScript:display});assert.equal(result.script,'헤드리스는 이천칠십칠년 관측소로 갑니다.');assert.deepEqual(before,{source,display});
  const quoted=normalizeGeneratedNarration('Breath of God는 아직 완성되지 않았습니다.',{narrationStyle:'korean',sourceText:'‘브레스 오브 갓’(Breath of God)은 가상 장치입니다.'});assert.equal(quoted.script,'브레스 오브 갓는 아직 완성되지 않았습니다.');
  const unquoted=normalizeGeneratedNarration('Breath of God는 아직 완성되지 않았습니다.',{narrationStyle:'korean',sourceText:'이 장치의 이름은 브레스 오브 갓(Breath of God)입니다.'});assert.match(unquoted.script,/Breath of God/u);assert.throws(()=>assertGeneratedNarrationPronunciation(unquoted,'korean'),{code:'PRONUNCIATION_REQUIRED'});
  const conflict=normalizeGeneratedNarration('Quorin은 관측소로 갑니다.',{narrationStyle:'korean',sourceText:'코린(Quorin)과 쿼린(Quorin)이라는 서로 다른 표기가 있습니다.'});assert.match(conflict.script,/Quorin/u);assert.deepEqual(conflict.residualTokens,['Quorin']);
  const noInventedLore=normalizeGeneratedNarration('ABOL의 사절이 도착합니다.',{narrationStyle:'korean',sourceText:'아볼의 사절이 도착한다는 설정입니다.'});assert.match(noInventedLore.script,/ABOL/u);
});

test('unknown Latin remains intact and produces a bounded actionable dictionary error without displaying sensitive-shaped tokens',()=>{
  const raw='Quorin과 UnmappedFleet는 여전히 실종 상태입니다.',recovered=normalizeGeneratedNarration(raw,{narrationStyle:'korean'});assert.equal(recovered.script,raw);assert.deepEqual(recovered.residualTokens,['Quorin','UnmappedFleet']);
  assert.throws(()=>assertGeneratedNarrationPronunciation(recovered,'korean'),error=>error.code==='PRONUNCIATION_REQUIRED'&&error.message.includes('Quorin')&&error.message.includes('발음 사전')&&!error.message.includes('다시 작성해 주세요'));
  const many=normalizeGeneratedNarration('Alpha Beta Gamma Delta Epsilon Zeta Eta는 이름 목록입니다.',{narrationStyle:'korean'});assert.equal(many.residualTokens.length,5);
  const secret='sk-proj-'+ 'x'.repeat(80),safe=normalizeGeneratedNarration('비밀 형식의 이름은 자료에만 남깁니다. '.repeat(8)+secret+'는 읽기를 확인해야 합니다.',{narrationStyle:'korean'});assert.deepEqual(safe.residualTokens,['[긴 영문 표기]']);assert.throws(()=>assertGeneratedNarrationPronunciation(safe,'korean'),error=>!error.message.includes(secret)&&error.message.length<400);
});

test('foreign-language narration is rejected before automatic aliases or even a user dictionary can disguise it as Korean',()=>{
  const english='NASA UN NASA UN NASA UN NASA UN NASA UN NASA UN.';
  for(const narrationStyle of['standard','korean','korean-digits','korean-native-digits'])assert.throws(()=>normalizeGeneratedNarration(english,{narrationStyle,pronunciations:[{term:'NASA',reading:'나사'},{term:'UN',reading:'유엔'}]}),{code:'KOREAN_NARRATION_REQUIRED'});
  assert.throws(()=>parseScriptResponse(response('The expedition departs and discovers the quiet distant world.'),settings),{code:'KOREAN_NARRATION_REQUIRED'});
});

test('only nonstandard spoken JSON schema forbids Latin and numeric glyphs while captions, summary and notes retain their types',()=>{
  for(const narrationStyle of['standard','korean','korean-digits','korean-native-digits']){
    const payload=buildScriptRequest({...settings,narrationStyle}),properties=payload.text.format.schema.properties;
    if(narrationStyle==='standard')assert.deepEqual(properties.script,{type:'string'});
    else{
      const pattern=new RegExp(properties.script.pattern);assert.equal(pattern.test('이천칠십칠년의 이야기입니다.\n\n나사가 관측합니다.'),true);
      for(const text of['NASA','2077','ＮＡＳＡ','２０７７','Café','Łódź'])assert.equal(pattern.test(text),false,text);
      assert.equal(properties.script.pattern.includes('\\p{'),false);
    }
    assert.deepEqual(properties.displayScript,{type:'string'});assert.deepEqual(properties.summary,{type:'string'});assert.deepEqual(properties.notes,{type:'array',items:{type:'string'}});assert.equal(payload.tools[0].type,'web_search');assert.equal(payload.tool_choice,'required');
  }
});

test('recovery preserves source-copy, search, source, structure and final expanded-length guards',()=>{
  const repeated='이 가상 기록은 관측소의 건설과 인구 이동, 기관들의 활동과 아직 확인되지 않은 정찰대의 행방을 다룹니다. '.repeat(3).trim();
  assert.throws(()=>parseScriptResponse(response(repeated),{...settings,sourceText:repeated}),{code:'SOURCE_NOT_REWRITTEN'});
  const noSearch=response();noSearch.output.shift();assert.throws(()=>parseScriptResponse(noSearch,settings),{code:'WEB_SEARCH_REQUIRED'});
  const noSource=response();noSource.output[0].action.sources=[];assert.throws(()=>parseScriptResponse(noSource,settings),{code:'WEB_SOURCES_REQUIRED'});
  const malformed=response();malformed.output[1].content[0].text='{';assert.throws(()=>parseScriptResponse(malformed,settings),{code:'INVALID_AI_OUTPUT'});
  assert.throws(()=>parseScriptResponse(response('본문 '+ '9'.repeat(99990)),{...settings,narrationStyle:'korean-native-digits'}),{code:'INVALID_AI_OUTPUT'});
});

test('direct and optional-server generation each use exactly one mocked provider request for successful local repair and strict unknown rejection',async()=>{
  for(const unknown of[false,true]){
    let directCalls=0;const provider=response(unknown?'Quorin의 탐사대가 출발합니다.':draft),api=createDirectOpenAi({sessionStorage:null,localStorage:null,storageEvents:null,dispatchChange(){},fetchImpl:async()=>{directCalls++;return Response.json(provider);}});api.setDirectSettings({apiKey:'sk-synthetic-pronunciation-not-a-real-key'});
    const direct=await api.directApiFetch('/api/script/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)}),directBody=await direct.json();assert.equal(directCalls,1);assert.equal(direct.status,unknown?502:200);if(unknown)assert.equal(directBody.code,'PRONUNCIATION_REQUIRED');else assert.equal(directBody.script,natural);
    let serverCalls=0;const handle=createScriptApi({env:{SCRIPT_AI_API_KEY:'synthetic-not-a-real-key'},requestProvider:async()=>{serverCalls++;return provider;}}),req=new EventEmitter(),res=new EventEmitter();req.method='POST';req.headers={'content-type':'application/json'};req.resume=()=>{};let status,body;
    res.writeHead=value=>{status=value;};res.end=value=>{body=JSON.parse(value);res.writableEnded=true;};const pending=handle(req,res,'/api/script/generate');req.emit('data',Buffer.from(JSON.stringify(settings)));req.emit('end');await pending;
    assert.equal(serverCalls,1);assert.equal(status,unknown?502:200);if(unknown)assert.equal(body.code,'PRONUNCIATION_REQUIRED');else assert.equal(body.script,natural);
  }
});
