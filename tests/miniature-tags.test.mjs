import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MINIATURE_GAME_GROUPS,MINIATURE_TAG_CATALOG,MINIATURE_TAG_PRESETS_KEY,recommendMiniatureTags,getRecommendedMiniatureTags,normalizeMiniatureTags,filterMiniatureTags,createMiniatureTagPresetStore} from '../dist/miniature-tags.js';
import {youtubeTagCharacterCount} from '../dist/youtube-protocol.js';
function storage(seed=null){const map=new Map(seed===null?[]:[[MINIATURE_TAG_PRESETS_KEY,seed]]);return{writes:[],getItem:key=>map.get(key)??null,setItem(key,value){this.writes.push({key,value});map.set(key,value);},raw:()=>map.get(MINIATURE_TAG_PRESETS_KEY)??null};}
const project=()=>({id:'miniature-fixture',title:'BLKOUT: ABOL로 가는 길',scriptDraft:{displayScript:'블랙아웃 미니어처 게임 세계관을 설명합니다. ABOL, LEAP와 난민의 이동이 등장합니다.'},scenes:[{caption:'정착과 갈등의 이야기'}],production:{publishing:{result:{tags:['워해머40k','에오지','인피니티','MCP','SF','ABOL','LEAP']}}}});

test('BLKOUT curation uses actual video evidence and excludes narrative names and unrelated legacy tags',()=>{
  const input=project(),before=structuredClone(input),result=recommendMiniatureTags(input);
  assert.deepEqual(result.gameIds,['blkout']);assert.ok(result.items.some(item=>item.tag==='블랙아웃'));assert.ok(result.items.some(item=>item.tag==='BLKOUT'));assert.ok(result.items.some(item=>item.tag==='미니어처 게임 세계관'));
  assert.ok(result.items.every(item=>['blkout','common','topic'].includes(item.gameId)));assert.ok(result.items.length<=12);assert.ok(!result.items.some(item=>/ABOL|LEAP|난민|우주|SF|40k|Sigmar|Infinity/iu.test(item.tag)));
  assert.equal(result.items.slice(0,6).every(item=>item.recommended),true);assert.equal(result.items.slice(6).every(item=>!item.recommended),true);assert.deepEqual(input,before);
});
test('game spellings and only explicit painting/battle/rules topics produce relevant candidates without broad keyword stuffing',()=>{
  const warhammer=recommendMiniatureTags('워해머 40,000 미니어처 도색 입문');assert.deepEqual(warhammer.gameIds,['warhammer40k']);assert.ok(warhammer.items.some(item=>item.tag==='미니어처 도색'));assert.ok(warhammer.items.some(item=>item.tag==='미니어처 게임 입문'));assert.ok(!warhammer.items.some(item=>/배틀|룰|세계관/u.test(item.tag)));
  assert.deepEqual(recommendMiniatureTags('에오지: Age of Sigmar 룰 설명 배틀 리포트').gameIds,['aos']);
  const plain=recommendMiniatureTags('1991년 전쟁과 SF 영화에 나온 우주 이주');assert.deepEqual(plain.gameIds,[]);assert.ok(plain.items.every(item=>item.gameId==='common'));
  assert.deepEqual(recommendMiniatureTags('Infinity the Game 도색').gameIds,['infinity']);assert.deepEqual(recommendMiniatureTags('Marvel Crisis Protocol').gameIds,['mcp']);
  assert.deepEqual(recommendMiniatureTags('MCP 서버와 인피니티 워 영화').gameIds,[]);
});
test('ordinary story wording does not invent tutorial or painting tags, while explicit guides do',()=>{
  const story={title:'BLKOUT 로어',scriptDraft:{displayScript:'그는 도색된 장비를 보고 새 항해를 시작하기 위해 떠났습니다. 오래된 초보 병사도 합류했습니다.'}};
  assert.equal(recommendMiniatureTags(story).items.some(item=>/도색|Painting|입문/u.test(item.tag)),false);
  const guide={title:'워해머 40K 초보자 도색 가이드',scriptDraft:{displayScript:'미니어처 도색 방법과 게임 입문 가이드를 설명합니다.'}};
  assert.ok(recommendMiniatureTags(guide).items.some(item=>item.tag==='미니어처 도색'));assert.ok(recommendMiniatureTags(guide).items.some(item=>item.tag==='미니어처 게임 입문'));
});
test('external videos use only their title/notes and never borrow the open project, description or generated tags',()=>{
  const result=recommendMiniatureTags({source:'external',project:project(),title:'Age of Sigmar 입문',notes:'에오지 룰 설명',description:'BLKOUT',tags:['Warhammer 40k']});assert.deepEqual(result.gameIds,['aos']);assert.equal(result.items.some(item=>item.gameId==='blkout'),false);
  assert.deepEqual(recommendMiniatureTags({project:null,title:'외부 영상',notes:'MCP 서버 개발',description:'워해머40k'}).gameIds,[]);
  assert.deepEqual(recommendMiniatureTags({project:project(),title:'비교 영상',notes:'워해머40k도 비교'}).gameIds,['warhammer40k','blkout']);
});
test('explicit game choice offers reviewed alternatives without mutating the project and the quick set stays small',()=>{
  const input=project(),before=structuredClone(input),result=recommendMiniatureTags({project:input},{gameId:'aos'});assert.deepEqual(result.gameIds,['aos']);assert.equal(result.items.some(item=>item.gameId==='blkout'),false);assert.deepEqual(input,before);
  const quick=getRecommendedMiniatureTags({project:input});assert.ok(quick.length<=6);assert.deepEqual(quick,result.gameIds[0]==='blkout'?result.items.slice(0,6).map(item=>item.tag):recommendMiniatureTags({project:input}).items.slice(0,6).map(item=>item.tag));assert.throws(()=>recommendMiniatureTags(input,{gameId:'invented'}),/다시 선택/u);
});
test('canonical selection deduplicates supported spellings and enforces catalog and actual YouTube tag bounds',()=>{
  assert.deepEqual(normalizeMiniatureTags(['#워해머40k','워해머 40K','Ｗａｒｈａｍｍｅｒ ４０ｋ','warhammer 40,000','미니어처게임']),['워해머 40K','Warhammer 40k','미니어처 게임']);
  for(const input of[['ABOL'],['SF'],['미니어처 게임\n'],[''],[null],['<BLKOUT>'],['https://example.test'],['sk-this-is-not-a-tag-secret']])assert.throws(()=>normalizeMiniatureTags(input));
  assert.throws(()=>normalizeMiniatureTags(['BLKOUT','블랙아웃'],{maxTags:1}),/최대 1개/u);assert.throws(()=>normalizeMiniatureTags([],{maxTags:31}),/범위/u);
  const all=normalizeMiniatureTags(MINIATURE_TAG_CATALOG.map(item=>item.tag));assert.ok(all.length<=30);assert.ok(youtubeTagCharacterCount(all)<=500);assert.deepEqual(normalizeMiniatureTags([]),[]);
});
test('legacy preview filters broad words without editing the supplied text or retaining arbitrary provider output',()=>{
  const raw=['BLKOUT','ABOL','LEAP','우주이주','SF','미니어처게임','BLKOUT',19],before=structuredClone(raw);assert.deepEqual(filterMiniatureTags(raw),['BLKOUT','미니어처 게임']);assert.deepEqual(raw,before);
  assert.deepEqual(filterMiniatureTags('Warhammer 40,000, SF, 워해머40k'),['Warhammer 40k','워해머 40K']);assert.deepEqual(filterMiniatureTags(''),[]);
});
test('preset definitions persist separately, update only explicit IDs, share same-page changes and remain isolated copies',()=>{
  const backend=storage(),first=createMiniatureTagPresetStore({storage:backend}),second=createMiniatureTagPresetStore({storage:backend});assert.deepEqual(first.list(),[]);assert.equal(backend.writes.length,0);let calls=0;const unsubscribe=second.subscribe(()=>{calls++;assert.ok(second.list());});
  const saved=first.save({name:'블랙아웃 세계관',tags:['blkout','블랙아웃','미니어처게임세계관']});assert.equal(calls,1);assert.deepEqual(second.list()[0],saved);saved.tags.push('bad');assert.equal(second.list()[0].tags.includes('bad'),false);
  const exported=JSON.parse(backend.raw());assert.deepEqual(Object.keys(exported),['version','presets']);assert.deepEqual(Object.keys(exported.presets[0]),['id','name','tags']);
  const updated=second.save({id:saved.id,name:'블랙아웃 전용',tags:['BLKOUT','미니어처 게임']});assert.equal(updated.id,saved.id);assert.equal(calls,2);assert.equal(first.list().length,1);assert.equal(first.list()[0].name,'블랙아웃 전용');
  assert.equal(first.remove(saved.id),true);assert.deepEqual(second.list(),[]);assert.equal(calls,3);unsubscribe();first.save({name:'재사용',tags:['BLKOUT']});assert.equal(calls,3);
});
test('duplicate names, unknown IDs, malformed/empty tags and excess presets never overwrite existing definitions',()=>{
  const backend=storage(),store=createMiniatureTagPresetStore({storage:backend}),one=store.save({name:'하나',tags:['BLKOUT']});let raw=backend.raw();
  for(const input of[{name:' 하나 ',tags:['BLKOUT']},{id:'missing',name:'없음',tags:['BLKOUT']},{name:'빈 태그',tags:[]},{name:'서사태그',tags:['ABOL']},{name:'API 키',tags:['BLKOUT'],token:'secret'}]){assert.throws(()=>store.save(input));assert.equal(backend.raw(),raw);}
  assert.throws(()=>store.remove('missing'));assert.equal(backend.raw(),raw);
  for(let n=1;n<30;n++)store.save({name:'프리셋 '+n,tags:['미니어처 게임']});assert.equal(store.list().length,30);raw=backend.raw();assert.throws(()=>store.save({name:'너무 많음',tags:['BLKOUT']}),/최대 30개/u);assert.equal(backend.raw(),raw);
  store.save({id:one.id,name:'첫 항목 수정',tags:['블랙아웃']});assert.equal(store.list().length,30);
});
test('blocked or corrupt storage reports real failure and never silently clears or replaces saved data',()=>{
  const blocked={getItem(){throw Error('denied');},setItem(){throw Error('denied');}};assert.throws(()=>createMiniatureTagPresetStore({storage:blocked}).list(),/읽을 수 없/u);
  const noWrite={getItem:()=>null,setItem(){throw Error('quota');}};assert.throws(()=>createMiniatureTagPresetStore({storage:noWrite}).save({name:'보관',tags:['BLKOUT']}),/저장하지 못/u);
  for(const raw of['{broken',JSON.stringify({version:2,presets:[]}),JSON.stringify({version:1,presets:[{id:'one',name:'손상',tags:['ABOL']}]}),JSON.stringify({version:1,presets:[],token:'secret'})]){const backend=storage(raw),store=createMiniatureTagPresetStore({storage:backend});assert.throws(()=>store.list());assert.throws(()=>store.save({name:'새 항목',tags:['BLKOUT']}));assert.equal(backend.raw(),raw);assert.equal(backend.writes.length,0);}
});
test('cross-tab storage notifications refresh subscribers without writing, and unsubscribing removes listeners',()=>{
  const oldAdd=globalThis.addEventListener,oldRemove=globalThis.removeEventListener,events=new EventTarget();globalThis.addEventListener=events.addEventListener.bind(events);globalThis.removeEventListener=events.removeEventListener.bind(events);
  try{const backend=storage(),store=createMiniatureTagPresetStore({storage:backend});let count=0;const stop=store.subscribe(()=>count++);const other=new Event('storage');Object.assign(other,{key:'another-key',storageArea:backend});events.dispatchEvent(other);assert.equal(count,0);const own=new Event('storage');Object.assign(own,{key:MINIATURE_TAG_PRESETS_KEY,storageArea:backend});events.dispatchEvent(own);assert.equal(count,1);assert.equal(backend.writes.length,0);stop();events.dispatchEvent(own);assert.equal(count,1);}finally{if(oldAdd===undefined)delete globalThis.addEventListener;else globalThis.addEventListener=oldAdd;if(oldRemove===undefined)delete globalThis.removeEventListener;else globalThis.removeEventListener=oldRemove;}
});
