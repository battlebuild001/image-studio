import {youtubeTagCharacterCount} from './youtube-protocol.js';

/** A small editorial catalog, not measured search volume or an SEO ranking. */
const groups = [
  {id: 'warhammer40k', label: '워해머 40K', needles: ['워해머40k','워해머40000','워해머사만','warhammer40k','warhammer40000','wh40k'], tags: [
    ['워해머 40K', ['워해머40k','워해머40000','워해머40,000','워해머사만'], '영상에서 다루는 게임의 한국어 이름'],
    ['Warhammer 40k', ['warhammer40000','warhammer40,000','wh40k'], '같은 게임의 영어 표기'],
  ]},
  {id: 'aos', label: '에이지 오브 지그마 · 에오지', needles: ['에이지오브지그마','에이지오브시그마','에오지','ageofsigmar','warhammeraos'], tags: [
    ['에이지 오브 지그마', ['에이지오브시그마'], '영상에서 다루는 게임의 한국어 이름'],
    ['Age of Sigmar', ['warhammerageofsigmar'], '같은 게임의 영어 표기'],
    ['에오지', ['warhammeraos','aos'], '같은 게임의 통용 약칭'],
  ]},
  {id: 'blkout', label: '블랙아웃 · BLKOUT', needles: ['블랙아웃','blkout'], tags: [
    ['블랙아웃', [], '영상에서 다루는 미니어처 게임의 한국어 이름'],
    ['BLKOUT', ['blkoutminiatures','블랙아웃미니어처게임'], '같은 미니어처 게임의 정식 영어 표기'],
  ]},
  {id: 'infinity', label: '인피니티', needles: ['인피니티미니어처','인피니티워게임','infinitythegame','corvusbelli','코르부스벨리'], tags: [
    ['인피니티 미니어처 게임', ['인피니티워게임'], '영상에서 다루는 게임과 미니어처 분야를 명확히 한 이름'],
    ['Infinity the Game', ['infinityminiatures'], '같은 미니어처 게임의 영어 표기'],
  ]},
  {id: 'mcp', label: '마블 크라이시스 프로토콜', needles: ['마블크라이시스프로토콜','marvelcrisisprotocol'], tags: [
    ['마블 크라이시스 프로토콜', [], '영상에서 다루는 게임의 한국어 이름'],
    ['Marvel Crisis Protocol', ['마블미니어처게임'], '같은 미니어처 게임의 영어 표기'],
  ]},
];
const common = [
  ['미니어처 게임', ['미니어처게임','miniaturegame'], '게임 분야를 직접 나타내는 분류'],
  ['미니어처 워게임', ['미니어처워게임'], '미니어처를 사용하는 워게임 분류'],
  ['테이블탑 워게임', ['테이블탑워게임','tabletopwargame','tabletopwargaming'], '탁상에서 진행하는 워게임 분류'],
  ['Miniature Wargaming', ['miniaturewargame','miniaturewargaming'], '같은 분야의 영어 분류'],
];
const topics = [
  {tag: '미니어처 도색', aliases: ['미니어처도색'], reason: '영상에 도색·페인팅 내용이 있어요', titlePattern: /도색|페인팅|miniature\s+painting|painting\s+miniatures/iu, pattern: /(?:도색|페인팅).{0,20}(?:방법|과정|튜토리얼|가이드|강좌|설명|연습)|(?:miniature\s+painting|painting\s+miniatures).{0,30}(?:tutorial|guide|technique|steps?)|(?:tutorial|guide).{0,30}(?:miniature\s+painting|painting\s+miniatures)/iu},
  {tag: 'Miniature Painting', aliases: ['miniaturepainting'], reason: '미니어처 도색 내용의 영어 분류', titlePattern: /도색|페인팅|miniature\s+painting|painting\s+miniatures/iu, pattern: /(?:도색|페인팅).{0,20}(?:방법|과정|튜토리얼|가이드|강좌|설명|연습)|(?:miniature\s+painting|painting\s+miniatures).{0,30}(?:tutorial|guide|technique|steps?)|(?:tutorial|guide).{0,30}(?:miniature\s+painting|painting\s+miniatures)/iu},
  {tag: '미니어처 배틀리포트', aliases: ['미니어처배틀리포트'], reason: '영상에 실제 게임 진행·배틀리포트 내용이 있어요', pattern: /배틀\s*리포트|전투\s*리포트|battle[\s-]*report/iu},
  {tag: '미니어처 게임 룰', aliases: ['미니어처게임룰'], reason: '영상에 게임 규칙·룰 설명 내용이 있어요', pattern: /룰\s*(?:설명|해설|북)|게임\s*규칙|rules?\s*(?:guide|explain|overview)/iu},
  {tag: '미니어처 게임 세계관', aliases: ['미니어처게임세계관'], reason: '영상에 로어·세계관 설명 내용이 있어요', pattern: /로어|세계관|\blore\b/iu},
  {tag: '미니어처 게임 입문', aliases: ['미니어처게임입문'], reason: '영상에 입문·초보 안내 내용이 있어요', titlePattern: /입문|초보|(?:게임|미니어처|워게임).{0,6}시작하기|\bbeginner\b|getting\s+started\s+with\s+(?:miniature|wargam)/iu, pattern: /(?:미니어처|워게임|게임).{0,12}(?:입문|초보|시작하기)|(?:입문|초보자?).{0,12}(?:가이드|안내|방법|튜토리얼)|\bbeginner(?:'s)?\s+(?:guide|tutorial)|getting\s+started\s+with\s+(?:miniature|wargam)/iu},
];
export const MINIATURE_GAME_GROUPS = Object.freeze(groups.map(({id,label}) => Object.freeze({id,label})));
const catalog = [
  ...groups.flatMap(group => group.tags.map(([tag,aliases,reason],index) => ({tag,aliases,reason,gameId:group.id,priority:100-index*6}))),
  ...common.map(([tag,aliases,reason],index) => ({tag,aliases,reason,gameId:'common',priority:86-index*2})),
  ...topics.map((topic,index) => ({...topic,gameId:'topic',priority:89-index*.1})),
];
export const MINIATURE_TAG_CATALOG = Object.freeze(catalog.map(({tag,gameId,reason}) => Object.freeze({tag,gameId,reason})));
export const MINIATURE_TAG_PRESETS_KEY = 'content-studio-miniature-tag-presets-v1';
const presetListeners = new Set();
const MAX_PRESETS = 30, MAX_STORE_CHARACTERS = 100000;
function fail(message){throw new Error(message);}
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function key(value){return value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[\s#·.,:_'-]+/gu,'');}
const tagsByKey = new Map();
for(const item of catalog)for(const value of[item.tag,...item.aliases])tagsByKey.set(key(value),item.tag);
function tagArray(input,{tolerant=false}={}){
  if(typeof input==='string'&&tolerant)input=input.replace(/(warhammer|워해머)\s*40,000/giu,'$1 40000').split(',');
  if(!Array.isArray(input)||input.length>1000)fail('태그 목록을 확인해 주세요.');
  return input;
}
/** Selected tags are canonical catalog labels; arbitrary story words cannot enter through this picker. */
export function normalizeMiniatureTags(input,{maxTags=30}={}){
  if(!Number.isInteger(maxTags)||maxTags<0||maxTags>30)fail('태그 개수 범위를 확인해 주세요.');
  const result=[];
  for(const value of tagArray(input)){
    if(typeof value!=='string'||!value.trim()||Array.from(value).length>100||/[<>\u0000-\u001f\u007f]/u.test(value))fail('미니어처 게임 태그의 문구를 확인해 주세요.');
    const tag=tagsByKey.get(key(value));
    if(!tag)fail('추천 목록에 있는 미니어처 게임 태그를 선택해 주세요.');
    if(!result.includes(tag))result.push(tag);
  }
  if(result.length>maxTags)fail(`태그는 최대 ${maxTags}개 선택할 수 있어요.`);
  if(youtubeTagCharacterCount(result)>500)fail('선택한 태그는 쉼표와 공백 태그의 따옴표를 포함해 500자 이하여야 해요.');
  return result;
}
/** Reading old text never changes it. Unknown legacy tags are merely omitted from the selection preview. */
export function filterMiniatureTags(input){
  const result=[];
  for(const value of tagArray(input,{tolerant:true})){
    if(typeof value!=='string'||value.length>100||/[<>\u0000-\u001f\u007f]/u.test(value))continue;
    const tag=tagsByKey.get(key(value));if(tag&&!result.includes(tag))result.push(tag);
  }
  return normalizeMiniatureTags(result);
}
function contextText(input){
  if(typeof input==='string')return input.slice(0,200000).normalize('NFKC');
  if(!plain(input))return '';
  const external=input.source==='external', hasProject=Object.hasOwn(input,'project');
  const project=external?{}:hasProject?(plain(input.project)?input.project:{}):input;
  const draft=plain(project.scriptDraft)?project.scriptDraft:{};
  const result=plain(draft.result)?draft.result:{};
  const script=draft.displayScript??draft.draftScript??result.displayScript??result.script??'';
  const values=[input.title,input.notes,input.sourceNotes,project.title,script,result.title,
    ...(Array.isArray(project.scenes)?project.scenes.slice(0,200).map(scene=>scene?.caption):[])];
  return values.filter(value=>typeof value==='string').map(value=>value.slice(0,100000)).join('\n').slice(0,400000).normalize('NFKC');
}
function contextTitle(input){
  if(typeof input==='string')return input.length<=200&&!/[\r\n]/u.test(input)?input.normalize('NFKC'):'';
  if(!plain(input))return '';
  const hasProject=Object.hasOwn(input,'project'),project=input.source==='external'?{}:hasProject?(plain(input.project)?input.project:{}):input;
  return[input.title,project.title,project.scriptDraft?.result?.title].filter(value=>typeof value==='string').map(value=>value.slice(0,200)).join('\n').normalize('NFKC');
}
function detectedGames(text){
  const compact=key(text), miniature=/미니어처|워게임|warhammer|wargam|tabletop|miniature/iu.test(text);
  return groups.filter(group=>group.needles.some(needle=>compact.includes(key(needle)))||
    group.id==='warhammer40k'&&miniature&&/(?:^|[^a-z0-9])40k(?:$|[^a-z0-9])/iu.test(text)||
    group.id==='aos'&&miniature&&/(?:^|[^a-z0-9])aos(?:$|[^a-z0-9])/iu.test(text)||
    group.id==='blkout'&&miniature&&/\bblackout\b/iu.test(text)||
    group.id==='mcp'&&miniature&&/\bmcp\b/iu.test(text));
}
/** Curate by actual game/topic evidence. Existing generated tags are deliberately never evidence. */
export function recommendMiniatureTags(context,{gameId='auto'}={}){
  if(gameId!=='auto'&&!groups.some(group=>group.id===gameId))fail('추천할 미니어처 게임을 다시 선택해 주세요.');
  const text=contextText(context), title=contextTitle(context), selected=gameId==='auto'?detectedGames(text):groups.filter(group=>group.id===gameId),ids=new Set(selected.map(group=>group.id));
  const eligible=catalog.filter(item=>ids.has(item.gameId)||item.gameId==='common'||item.gameId==='topic'&&(item.titlePattern?.test(title)||item.pattern.test(text)));
  const items=[...eligible].sort((a,b)=>b.priority-a.priority||catalog.indexOf(a)-catalog.indexOf(b)).slice(0,12)
    .map(({tag,gameId,reason},index)=>({tag,gameId,reason,recommended:index<6}));
  const reason=gameId!=='auto'?'직접 선택한 게임과 영상의 실제 내용에 맞는 태그예요.':selected.length?'영상 제목·대본에서 확인한 게임과 직접 관련된 태그예요.':'영상에서 게임 이름을 확인하기 어려워요. 게임을 선택하면 전용 태그도 볼 수 있어요.';
  return {gameIds:[...ids],items,reason};
}
export function getRecommendedMiniatureTags(context,options){return recommendMiniatureTags(context,options).items.slice(0,6).map(item=>item.tag);}
function presetName(value){
  if(typeof value!=='string')fail('태그 프리셋 이름을 입력해 주세요.');
  const name=value.normalize('NFC').trim();
  if(!name||Array.from(name).length>80||/[<>\u0000-\u001f\u007f]/u.test(name)||/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{16,})\b/u.test(name))fail('프리셋 이름은 80자 이하의 일반 문구로 입력해 주세요.');
  return name;
}
function presetId(value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,100}$/u.test(value))fail('태그 프리셋 식별자를 확인해 주세요.');return value;}
function normalizePreset(input){
  if(!plain(input)||Object.keys(input).some(field=>!['id','name','tags'].includes(field)))fail('저장된 태그 프리셋의 형식을 확인해 주세요.');
  const tags=normalizeMiniatureTags(input.tags);if(!tags.length)fail('프리셋에는 태그를 한 개 이상 선택해 주세요.');
  return{id:presetId(input.id),name:presetName(input.name),tags};
}
function identityName(value){return value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/gu,' ').trim();}
function clone(value){return structuredClone(value);}
function newId(){return 'mini-tags-'+(globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,12)}`);}
/** Browser-wide definitions only; applying a preset to a project is a separate explicit UI action. */
export function createMiniatureTagPresetStore(options={}){
  let storage;
  try{storage=Object.hasOwn(options,'storage')?options.storage:globalThis.localStorage;}catch{fail('이 브라우저에서 태그 프리셋 저장소에 접근할 수 없어요.');}
  function read(){
    let raw;try{raw=storage?.getItem(MINIATURE_TAG_PRESETS_KEY);if(!storage||typeof storage.getItem!=='function')fail('unavailable');}catch{fail('이 브라우저에서 태그 프리셋을 읽을 수 없어요. 저장소 권한을 확인해 주세요.');}
    if(raw===null)return[];
    if(typeof raw!=='string'||raw.length>MAX_STORE_CHARACTERS)fail('저장된 태그 프리셋이 너무 크거나 손상됐어요. 기존 자료는 그대로 보관했어요.');
    try{
      const value=JSON.parse(raw);if(!plain(value)||value.version!==1||Object.keys(value).some(field=>!['version','presets'].includes(field))||!Array.isArray(value.presets)||value.presets.length>MAX_PRESETS)throw Error('shape');
      const presets=value.presets.map(normalizePreset),ids=new Set(),names=new Set();
      for(const preset of presets){if(ids.has(preset.id)||names.has(identityName(preset.name)))throw Error('duplicate');ids.add(preset.id);names.add(identityName(preset.name));}
      return presets;
    }catch{fail('저장된 태그 프리셋을 읽지 못했어요. 기존 자료는 덮어쓰지 않았어요. 브라우저 저장소를 확인해 주세요.');}
  }
  function notify(){for(const listener of presetListeners)if(listener.storage===storage){try{listener.callback();}catch{}}}
  function write(presets){
    const encoded=JSON.stringify({version:1,presets});if(encoded.length>MAX_STORE_CHARACTERS)fail('태그 프리셋 저장 용량을 초과했어요.');
    try{storage.setItem(MINIATURE_TAG_PRESETS_KEY,encoded);}catch{fail('태그 프리셋을 저장하지 못했어요. 브라우저 저장 공간과 권한을 확인해 주세요.');}
    notify();
  }
  function list(){return clone(read());}
  function save(input){
    if(!plain(input)||Object.keys(input).some(field=>!['id','name','tags'].includes(field)))fail('저장할 태그 프리셋을 확인해 주세요.');
    const previous=read(),id=input.id===undefined?newId():presetId(input.id),existing=previous.findIndex(item=>item.id===id);
    if(input.id!==undefined&&existing<0)fail('수정할 태그 프리셋을 다시 선택해 주세요.');
    const value=normalizePreset({id,name:input.name,tags:input.tags});
    if(previous.some(item=>item.id!==id&&identityName(item.name)===identityName(value.name)))fail('같은 이름의 태그 프리셋이 있어요. 다른 이름을 쓰거나 선택한 프리셋을 수정해 주세요.');
    if(existing<0&&previous.length>=MAX_PRESETS)fail('태그 프리셋은 최대 30개예요. 필요 없는 프리셋을 삭제한 뒤 저장해 주세요.');
    const next=clone(previous);if(existing>=0)next[existing]=value;else next.push(value);write(next);return clone(value);
  }
  function remove(id){const target=presetId(id),previous=read();if(!previous.some(item=>item.id===target))fail('삭제할 태그 프리셋을 다시 선택해 주세요.');write(previous.filter(item=>item.id!==target));return true;}
  function subscribe(callback){
    if(typeof callback!=='function')fail('태그 프리셋 알림을 준비하지 못했어요.');
    const record={storage,callback};presetListeners.add(record);
    const crossTab=event=>{if((event.key===MINIATURE_TAG_PRESETS_KEY||event.key===null)&&(!event.storageArea||event.storageArea===storage)){try{callback();}catch{}}};
    globalThis.addEventListener?.('storage',crossTab);
    return()=>{presetListeners.delete(record);globalThis.removeEventListener?.('storage',crossTab);};
  }
  return{list,save,remove,subscribe};
}
