/** Bounded local pronunciation recovery. Never translates or guesses unfamiliar names. */
import {normalizePronunciations} from './pronunciation.js';

const PRON_SINO_DIGITS = ['영','일','이','삼','사','오','육','칠','팔','구'];
const PRON_NATIVE_DIGITS = ['공','하나','둘','셋','넷','다섯','여섯','일곱','여덟','아홉'];
const PRON_LARGE_UNITS = ['','만','억','조','경','해','자','양','구','간','정','재','극'];
const PRON_SMALL_UNITS = ['','십','백','천'];
const PRON_KNOWN = [{term:'NASA',reading:'나사'},{term:'UN',reading:'유엔'}];
const PRON_METRIC_UNITS = {km:'킬로미터',cm:'센티미터',mm:'밀리미터',m:'미터',kg:'킬로그램',mg:'밀리그램',g:'그램',ml:'밀리리터',mL:'밀리리터',L:'리터'};
const pronEscape = value => value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const pronKey = value => value.normalize('NFKC').replace(/[ \t]+/gu,' ').toLocaleLowerCase('en-US');
const pronDigits = (value,digits=PRON_SINO_DIGITS) => value.replace(/\d/gu,digit=>digits[Number(digit)]);

function pronCardinalInteger(value) {
  if(value==='0')return'영';
  // Identifiers with leading zeroes must retain every digit, and very long values
  // use digit readings rather than inventing an unsupported large-number unit.
  if(value.startsWith('0')||value.length>PRON_LARGE_UNITS.length*4)return pronDigits(value);
  const chunks=[];let unit=0;
  for(let end=value.length;end>0;end-=4,unit++){
    const group=value.slice(Math.max(0,end-4),end);let reading='';
    for(let index=0;index<group.length;index++){
      const digit=Number(group[index]),place=group.length-index-1;if(!digit)continue;
      reading+=(digit===1&&place>0?'':PRON_SINO_DIGITS[digit])+PRON_SMALL_UNITS[place];
    }
    if(reading)chunks.unshift((reading==='일'&&unit===1?'':reading)+PRON_LARGE_UNITS[unit]);
  }
  return chunks.join('');
}

/** String arithmetic only: no floating point conversion, rounding or dropped decimal zeroes. */
export function formatNarrationNumbers(value,style='standard') {
  if(typeof value!=='string')throw new Error('발음 적용 대본의 형식을 확인해 주세요.');
  if(!['korean','korean-digits','korean-native-digits'].includes(style))return value;
  let text=value.replace(/[０-９]/gu,digit=>String(digit.charCodeAt(0)-0xff10));
  // Metric abbreviations are read only immediately after an explicit numeric
  // quantity; a bare letter elsewhere is never assumed to be a measurement.
  text=text.replace(/(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([ \t]*)(km|cm|mm|kg|mg|ml|mL|m|g|L)(?![A-Za-z0-9_])/gu,
    (_all,integer,fraction,spacing,unit)=>integer+(fraction||'')+spacing+PRON_METRIC_UNITS[unit]);
  return text.replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/gu,number=>{
    const [integer,fraction]=number.replace(/,/gu,'').split('.');
    const digits=style==='korean-native-digits'?PRON_NATIVE_DIGITS:PRON_SINO_DIGITS;
    const reading=style==='korean'?pronCardinalInteger(integer):pronDigits(integer,digits);
    return reading+(fraction===undefined?'':'점'+pronDigits(fraction,digits));
  });
}

function pronAliases(contexts) {
  const aliases=new Map(),conflicts=new Set();
  const add=(term,reading)=>{
    const normalized=term.normalize('NFKC').trim();
    if(normalized.length>100||!/^[A-Za-z][A-Za-z .’'\-]{1,99}$/u.test(normalized)||!/[가-힣]/u.test(reading))return;
    const key=pronKey(normalized),name=reading.replace(/[ \t]+/gu,' ').trim();
    if(aliases.has(key)&&aliases.get(key).reading!==name)conflicts.add(key);
    else if(aliases.size<200)aliases.set(key,{term:normalized,reading:name});
  };
  for(const context of contexts){
    if(typeof context!=='string'||context.length>100000)continue;
    // Unquoted multiword phrases can include ordinary preceding prose. Only a
    // single Hangul word paired with a single Latin token is unambiguous here.
    for(const match of context.matchAll(/([가-힣]{1,40})[ \t]*[（(]([A-Za-zＡ-Ｚａ-ｚ][A-Za-zＡ-Ｚａ-ｚ.’'\-]{1,99})[）)]/gu))add(match[2],match[1]);
    for(const pattern of [/[‘“"']([가-힣][가-힣 \t·\-]{0,78}[가-힣])[’”"'][ \t]*[（(]([A-Za-z][A-Za-z .’'\-]{1,99})[）)]/gu,/[‘“"']([가-힣][가-힣 \t·\-]{0,78}[가-힣])[ \t]*[（(]([A-Za-z][A-Za-z .’'\-]{1,99})[）)][’”"']/gu]){
      for(const match of context.matchAll(pattern))add(match[2],match[1]);
    }
  }
  return [...aliases].filter(([key])=>!conflicts.has(key)).map(([,entry])=>entry);
}

/** User rules win before contextual aliases and the small standard acronym list. */
export function recoverKnownNarrationPronunciations(value,{pronunciations=[],contexts=[]}={}) {
  const userRules=normalizePronunciations(pronunciations).sort((a,b)=>Array.from(b.term).length-Array.from(a.term).length);
  const knownKeys=new Set(userRules.map(rule=>pronKey(rule.term))),fallback=[];
  for(const entry of [...pronAliases(contexts),...PRON_KNOWN]){
    const key=pronKey(entry.term);if(knownKeys.has(key))continue;knownKeys.add(key);fallback.push(entry);
  }
  fallback.sort((a,b)=>b.term.length-a.term.length);
  const rules=[...userRules,...fallback],byTerm=new Map(rules.map(rule=>[pronKey(rule.term),rule.reading]));
  if(!rules.length)return value;
  const alternatives=rules.map(({term})=>{
    const pattern=term.split(/\s+/u).map(pronEscape).join('[^\\S\\r\\n\\u2028\\u2029]+');
    return /^[A-Za-z0-9_]/u.test(term)||/[A-Za-z0-9_]$/u.test(term)?`(?<![A-Za-z0-9_])(?:${pattern})(?![A-Za-z0-9_])`:pattern;
  });
  // Single-pass replacement means a user's chosen reading is never rewritten by
  // an automatic fallback or another dictionary entry.
  const text=value.replace(/[Ａ-Ｚａ-ｚ]/gu,letter=>letter.normalize('NFKC'));
  return text.replace(new RegExp(alternatives.join('|'),'giu'),match=>byTerm.get(pronKey(match))??match);
}

/** Bounded lexical examples for an actionable error, never a raw provider response. */
export function narrationResidualTokens(value) {
  const result=[],seen=new Set();
  for(const match of value.matchAll(/[\p{Script=Latin}][\p{Script=Latin}\p{M}\p{N}._-]*/gu)){
    const raw=match[0],sensitive=/^(?:sk-|ya29\.|AIza|gh[pousr]_)/iu.test(raw)||raw.length>40;
    const token=sensitive?'[긴 영문 표기]':raw.replace(/[\r\n\u0000-\u001f\u007f]/gu,'').slice(0,40),key=pronKey(token);
    if(!seen.has(key)){seen.add(key);result.push(token);if(result.length===5)break;}
  }
  return result;
}
