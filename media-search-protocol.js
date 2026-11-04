/** Public Wikimedia media metadata only. No provider credentials or original media are portable here. */
export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
export const MAX_MEDIA_RESULTS = 20;
export const MAX_REFERENCE_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_MUSIC_MEDIA_BYTES = 50 * 1024 * 1024;
const MEDIA_HOSTS = new Set(['upload.wikimedia.org','thumb.wikimedia.org']);
const IMAGE_MIME = new Set(['image/jpeg','image/png','image/webp']);
const AUDIO_MIME = new Set(['audio/ogg','audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/flac','audio/webm']);
const CANDIDATE_KEYS = new Set(['id','kind','title','description','mediaUrl','originalUrl','previewUrl','sourceUrl','mimeType','size','width','height','duration','artist','license','licenseUrl','attribution','source']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail = message => {throw new Error(message || '자료 검색 결과의 형식을 확인해 주세요.');};
function own(value,keys){if(!plain(value)||Object.keys(value).some(key=>!keys.includes(key)))fail('자료 검색 자료에 지원하지 않는 항목이 있어요.');}
function text(value,max,label,{blank=true}={}){if(typeof value!=='string'||Array.from(value).length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))fail(`${label}의 길이와 형식을 확인해 주세요.`);if(!blank&&!value.trim())fail(`${label}을 입력해 주세요.`);return value;}
function number(value,min,max,label){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)fail(`${label}의 범위를 확인해 주세요.`);return value;}
export function mediaQuery(value){return text(value,500,'검색어',{blank:false}).trim();}
export function mediaPlainText(value,max=1000){
 const input=String(value??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu,' ').replace(/<[^>]*>/gu,' ');
 const decoded=input.replace(/&#(x[0-9a-f]+|\d+);/giu,(_match,code)=>{const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);return n>31&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'';}).replace(/&(amp|lt|gt|quot|apos|nbsp);/gu,(_m,key)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[key]);
 return Array.from(decoded.replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim()).slice(0,max).join('');
}
function url(value,{hosts,blank=false}={}){
 if(blank&&(value===undefined||value===''))return'';
 if(typeof value!=='string'||value.length>2048)fail('자료 주소를 확인해 주세요.');let u;try{u=new URL(value);}catch{fail('자료 주소를 확인해 주세요.');}
 if(u.protocol!=='https:'||u.username||u.password||u.port||(hosts&&!hosts.has(u.hostname)))fail('공식 자료 주소만 사용할 수 있어요.');
 u.hash='';for(const key of [...u.searchParams.keys()])if(/^utm_/iu.test(key))u.searchParams.delete(key);return u.href;
}
export function mediaDownloadUrl(value){const normalized=url(value,{hosts:MEDIA_HOSTS});const u=new URL(normalized);if(!u.pathname.startsWith('/wikipedia/commons/')||u.pathname.includes('..'))fail('Wikimedia Commons 파일 주소를 확인해 주세요.');return normalized;}
export function normalizeMediaCandidate(input,kind){
 if(!plain(input)||Object.keys(input).some(key=>!CANDIDATE_KEYS.has(key)))fail();
 if(!['image','audio'].includes(input.kind)||kind&&input.kind!==kind)fail('자료 종류를 확인해 주세요.');
 if(typeof input.id!=='string'||!/^commons-\d{1,15}$/u.test(input.id))fail('자료 식별자를 확인해 주세요.');
 const mimeType=input.mimeType==='application/ogg'?'audio/ogg':input.mimeType;
 if(!(input.kind==='image'?IMAGE_MIME:AUDIO_MIME).has(mimeType))fail('사용할 수 있는 이미지 또는 음악 파일이 아니에요.');
 const sourceUrl=url(input.sourceUrl,{hosts:new Set(['commons.wikimedia.org'])});
 return{id:input.id,kind:input.kind,title:text(input.title,240,'자료 제목',{blank:false}),description:text(input.description??'',1500,'자료 설명'),mediaUrl:mediaDownloadUrl(input.mediaUrl),originalUrl:mediaDownloadUrl(input.originalUrl),previewUrl:input.previewUrl?mediaDownloadUrl(input.previewUrl):'',sourceUrl,mimeType,size:number(input.size??0,0,2**40,'자료 크기'),width:number(input.width??0,0,100000,'자료 너비'),height:number(input.height??0,0,100000,'자료 높이'),duration:number(input.duration??0,0,86400,'음악 길이'),artist:text(input.artist??'',500,'저작자'),license:text(input.license??'',200,'이용 조건'),licenseUrl:url(input.licenseUrl,{blank:true}),attribution:text(input.attribution??'',1500,'출처 표시'),source:'wikimedia-commons'};
}
function metadata(value,key,max){return mediaPlainText(value?.[key]?.value,max);}
export function normalizeCommonsResponse(value,{kind='image'}={}){
 if(!['image','audio'].includes(kind)||!plain(value))fail();if(value.error)fail('Wikimedia 검색 요청을 처리하지 못했어요. 검색어를 바꾸거나 잠시 뒤 다시 시도하세요.');
 const pages=value.query?.pages;if(pages===undefined)return[];if(!plain(pages)&&!Array.isArray(pages))fail();
 const result=[];
 for(const page of Object.values(pages).sort((a,b)=>(a.index??0)-(b.index??0))){
  const info=page?.imageinfo?.[0];if(!info||!Number.isSafeInteger(page.pageid)||page.pageid<=0)continue;
  try{
   const mime=info.mime==='application/ogg'?'audio/ogg':info.mime,originalUrl=mediaDownloadUrl(info.url),previewUrl=kind==='image'&&info.thumburl?mediaDownloadUrl(info.thumburl):originalUrl;
   let mediaUrl=originalUrl,mimeType=mime;
   if(kind==='image'){
    if(!IMAGE_MIME.has(mime))continue;
    if(Number(info.size)>MAX_REFERENCE_MEDIA_BYTES){mediaUrl=previewUrl;mimeType=info.thumbmime||mime;}
   }else if(!AUDIO_MIME.has(mime)||Number(info.size)>MAX_MUSIC_MEDIA_BYTES)continue;
   const meta=info.extmetadata||{},artist=metadata(meta,'Artist',500),license=metadata(meta,'LicenseShortName',200)||metadata(meta,'UsageTerms',200),title=metadata(meta,'ObjectName',240)||mediaPlainText(String(page.title||'').replace(/^File:/u,''),240);
   const licenseRaw=String(meta.LicenseUrl?.value||'').replace(/^http:\/\/(creativecommons\.org|www\.creativecommons\.org)\//iu,'https://$1/');
   let licenseUrl='';try{licenseUrl=url(licenseRaw,{blank:true});}catch{}
   result.push(normalizeMediaCandidate({id:`commons-${page.pageid}`,kind,title,description:metadata(meta,'ImageDescription',1500),mediaUrl,originalUrl,previewUrl,sourceUrl:`https://commons.wikimedia.org/?curid=${page.pageid}`,mimeType,size:Number(info.size)||0,width:Number(info.width)||0,height:Number(info.height)||0,duration:Number(info.duration)||0,artist,license,licenseUrl,attribution:metadata(meta,'Attribution',1500)||[title,artist,license].filter(Boolean).join(' · '),source:'wikimedia-commons'},kind));
  }catch{continue;}
  if(result.length>=MAX_MEDIA_RESULTS)break;
 }
 return result;
}
function candidates(value,kind){if(!Array.isArray(value)||value.length>MAX_MEDIA_RESULTS)fail();const list=value.map(item=>normalizeMediaCandidate(item,kind));if(new Set(list.map(item=>item.id)).size!==list.length)fail('같은 자료가 중복돼요.');return list;}
function stamp(value){if(value===''||value===undefined)return'';if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T/u.test(value)||!Number.isFinite(Date.parse(value)))fail('자료 조회 시각을 확인해 주세요.');return new Date(value).toISOString();}
export function normalizeReferenceMediaState(input={}){
 own(input,['query','results','selectedIds','searchedAt','withTopic','imports']);const results=candidates(input.results??[],'image'),selectedIds=input.selectedIds??[];
 if(!Array.isArray(selectedIds)||selectedIds.length>MAX_MEDIA_RESULTS||selectedIds.some(id=>!results.some(item=>item.id===id))||new Set(selectedIds).size!==selectedIds.length)fail('선택한 이미지 자료를 확인해 주세요.');
 if(input.withTopic!==undefined&&typeof input.withTopic!=='boolean')fail();
 const imports=input.imports??[];if(!Array.isArray(imports)||imports.length>50)fail('가져온 자료 출처는 최대 50개까지 보관할 수 있어요.');const saved=imports.map(item=>normalizeMediaCandidate(item,'image'));if(new Set(saved.map(item=>item.id)).size!==saved.length)fail();
 return{query:text(input.query??'',500,'이미지 검색어'),results,selectedIds:[...selectedIds],searchedAt:stamp(input.searchedAt),withTopic:input.withTopic??true,imports:saved};
}
export function normalizeMusicRecommendations(value){
 if(!Array.isArray(value)||value.length>5)fail('음악 추천은 최대 5개까지 보관할 수 있어요.');
 return value.map(item=>{own(item,['title','mood','style','instruments','tempoBpm','searchQuery','reason']);if(!Array.isArray(item.instruments)||item.instruments.length>12)fail();return{title:text(item.title,120,'추천 제목',{blank:false}),mood:text(item.mood,120,'분위기'),style:text(item.style,200,'음악 스타일'),instruments:item.instruments.map(v=>text(v,100,'악기')),tempoBpm:item.tempoBpm===null?null:number(item.tempoBpm,20,300,'예상 박자'),searchQuery:text(item.searchQuery,200,'음원 검색어',{blank:false}),reason:text(item.reason,1000,'추천 이유')};});
}
export function normalizeMusicState(input={}){
 own(input,['query','recommendations','candidates','selectedId','searchedAt','suggestedAt','appliedCandidate']);const list=candidates(input.candidates??[],'audio'),selectedId=input.selectedId??'';if(typeof selectedId!=='string'||selectedId&&!list.some(item=>item.id===selectedId))fail();
 return{query:text(input.query??'',500,'음원 검색어'),recommendations:normalizeMusicRecommendations(input.recommendations??[]),candidates:list,selectedId,searchedAt:stamp(input.searchedAt),suggestedAt:stamp(input.suggestedAt),appliedCandidate:input.appliedCandidate?normalizeMediaCandidate(input.appliedCandidate,'audio'):null};
}

export function mediaAttributionText(candidate){const value=normalizeMediaCandidate(candidate);return[value.title,value.artist?`저작자: ${value.artist}`:'',value.license?`Commons 표기: ${value.license}`:'이용 조건은 출처에서 확인',value.sourceUrl,value.licenseUrl].filter(Boolean).join('\n');}
