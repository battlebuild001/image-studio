/** User-selected description formatting; no provider call or automatic sponsor placement. */
export const SUPPORT_BLOCK = `이번 영상은 배틀테이블하비의 지원으로 제작되었습니다.
배틀테이블하비는 미니어처 전문 온라인 & 오프라인 스토어입니다.
국내에서 가장 많은 게임을 튜토리얼하고 플레이하며 서비스하고 있습니다.

제작 지원 : 배틀테이블하비
스토어 링크 : https://smartstore.naver.com/battletablehobby
제품 문의 : https://open.kakao.com/o/gbYU7X8h`;
const encoder=new TextEncoder();
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
function fail(message){throw new Error(message);}
function descriptionText(value){if(typeof value!=='string'||value.length>300000)fail('영상 설명의 형식과 길이를 확인해 주세요.');return value;}
export function normalizeDescriptionPreferences(input){
  if(input===undefined)return{length:'short',support:false,hashtags:true};
  if(!plain(input)||Object.keys(input).some(key=>!['length','support','hashtags'].includes(key)))fail('영상 설명 설정의 형식을 확인해 주세요.');
  const length=input.length===undefined?'short':input.length,support=input.support===undefined?false:input.support,hashtags=input.hashtags===undefined?true:input.hashtags;
  if(!['short','standard'].includes(length)||typeof support!=='boolean'||typeof hashtags!=='boolean')fail('설명 길이와 제작 지원 표시를 다시 선택해 주세요.');
  return{length,support,hashtags};
}
export function getDescriptionPreferences(project){return normalizeDescriptionPreferences(project?.production?.description);}
export function setDescriptionPreferences(project,input){
  const prefs=normalizeDescriptionPreferences(input);
  if(!plain(project)||project.production!==undefined&&project.production!==null&&(!plain(project.production)||project.production.version!==1))fail('설명 설정을 저장할 프로젝트를 확인해 주세요.');
  if(!project.production)project.production={version:1};project.production.description=prefs;return project;
}
/** Only our exact complete trailing block is owned; ordinary manually written brand mentions stay intact. */
export function getDescriptionSummary(text){
  let body=descriptionText(text);
  while(true){
    const candidate=body.replace(/\s+$/u,'');
    if(!candidate.endsWith(SUPPORT_BLOCK))break;
    const offset=candidate.length-SUPPORT_BLOCK.length;
    if(offset===0){body='';break;}
    if(candidate.slice(offset-2,offset)==='\n\n')body=candidate.slice(0,offset-2);
    else if(candidate[offset-1]==='\n')body=candidate.slice(0,offset-1);
    else break;
  }
  return body;
}
/** Checkbox changes preserve manual body text exactly and never shorten the fixed support details. */
export function composeSupportBlock(text,support){
  if(typeof support!=='boolean')fail('제작 지원 표시를 다시 선택해 주세요.');
  const body=getDescriptionSummary(text),result=support?(body?body+'\n\n'+SUPPORT_BLOCK:SUPPORT_BLOCK):body;
  if(support&&encoder.encode(result).byteLength>5000)fail('제작 지원 문구를 포함한 설명이 5,000바이트를 넘어요. 본문을 줄인 뒤 다시 선택해 주세요.');
  return result;
}
function shortenedPrefix(text,maximum){
  const chars=Array.from(text);if(chars.length<=maximum)return text;
  const candidate=chars.slice(0,maximum-1).join('');let boundary=-1;
  for(const match of candidate.matchAll(/[\s,;，；]/gu))if(Array.from(candidate.slice(0,match.index)).length>=maximum*.6)boundary=match.index;
  return (boundary>0?candidate.slice(0,boundary):candidate).replace(/[\s,;，；]+$/gu,'')+'…';
}
/** Generated drafts only: prefer complete sentences and retain a bounded, visibly shortened prefix if needed. */
export function compactDescriptionText(text,{length='short'}={}){
  if(!['short','standard'].includes(length))fail('설명 길이를 다시 선택해 주세요.');
  const body=getDescriptionSummary(text).replace(/\s+/gu,' ').trim();if(!body)return'';
  const maxSentences=length==='short'?3:5,maxCharacters=length==='short'?350:800;
  let sentences;
  if(typeof Intl.Segmenter==='function')sentences=Array.from(new Intl.Segmenter('ko',{granularity:'sentence'}).segment(body),item=>item.segment.trim()).filter(Boolean);
  else sentences=body.split(/(?<=[.!?。！？])\s+/u).map(value=>value.trim()).filter(Boolean);
  const selected=[];
  for(const sentence of sentences){
    if(selected.length>=maxSentences)break;
    const candidate=[...selected,sentence].join(' ');
    if(Array.from(candidate).length>maxCharacters){if(!selected.length)selected.push(shortenedPrefix(sentence,maxCharacters));break;}
    selected.push(sentence);
  }
  return selected.join(' ');
}
export function composeVideoDescription(text,input){
  const prefs=normalizeDescriptionPreferences(input),summary=compactDescriptionText(text,{length:prefs.length});
  const result=composeSupportBlock(summary,prefs.support);
  if(encoder.encode(result).byteLength>5000)fail('영상 설명은 UTF-8 기준 5,000바이트 이내로 작성해 주세요.');
  return result;
}
