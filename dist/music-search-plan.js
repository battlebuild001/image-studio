import {normalizeMusicRecommendations} from './media-search-protocol.js';

// These are catalog keywords, not track names or additional search providers.
// Prefer a named genre over generic soundtrack adjectives or instruments.
const CATALOG_TERMS = [
 {query:'orchestral',rank:0,pattern:/\b(?:orchestral|orchestra|symphonic|symphony)\b|오케스트라|관현악|교향(?:곡|악)/iu},
 {query:'ambient',rank:0,pattern:/\b(?:ambient|ambience)\b|앰비언트|앰비언스/iu},
 {query:'electronic',rank:0,pattern:/\b(?:electronic|electronica|synthwave|synthesizer|synth)\b|일렉트로닉|전자\s*음악|신시사이저|신스웨이브/iu},
 {query:'jazz',rank:0,pattern:/\bjazz\b|재즈/iu},
 {query:'acoustic',rank:0,pattern:/\bacoustic\b|어쿠스틱|통기타/iu},
 {query:'classical',rank:0,pattern:/\bclassical\b|클래식|고전\s*음악/iu},
 {query:'rock',rank:0,pattern:/\brock\b|(?:록|락)\s*음악|로큰롤/iu},
 {query:'folk',rank:0,pattern:/\bfolk\b|포크\s*음악/iu},
 {query:'blues',rank:0,pattern:/\bblues\b|블루스/iu},
 {query:'lofi',rank:0,pattern:/\blo[ -]?fi\b|로파이|로우파이/iu},
 {query:'piano',rank:1,pattern:/\b(?:piano|pianoforte)\b|피아노/iu},
 {query:'guitar',rank:1,pattern:/\bguitar\b|기타\s*(?:연주|음악)/iu},
 {query:'instrumental',rank:2,pattern:/\binstrumentals?\b|\bnon[ -]?vocal\b|\bno vocals\b|\bwordless\b|인스트루멘탈|무가사|가사\s*없는|연주곡/iu}
];

/** A caller may try the next keyword only after an honest empty catalog result. */
export function musicSearchQueries(recommendation){
 const item=normalizeMusicRecommendations([recommendation])[0];
 const exact=item.searchQuery.trim(),hints=[item.searchQuery,item.style,...item.instruments];
 const matches=[];
 for(const term of CATALOG_TERMS){
  const source=hints.findIndex(hint=>term.pattern.test(hint));
  if(source!==-1)matches.push({...term,source});
 }
 matches.sort((a,b)=>a.rank-b.rank||a.source-b.source);
 const queries=[exact],seen=new Set([exact.toLocaleLowerCase('en-US')]);
 for(const {query} of matches){
  if(!seen.has(query)){queries.push(query);seen.add(query);}
  if(queries.length===3)break;
 }
 return queries;
}
