/** Local cleanup for newly generated descriptions only. Never run on manual drafts. */
export function cleanGeneratedVideoDescription(value,{titles=[],sourceText=''}={}){
 if(typeof value!=='string'||Array.from(value).length>16000)throw new Error('생성한 영상 설명의 길이를 확인해 주세요.');
 const compact=text=>String(text).normalize('NFKC').replace(/\s+/gu,' ').trim();
 const evidence=compact(typeof sourceText==='string'?sourceText.slice(0,200000):''),knownTitles=new Set(titles.filter(title=>typeof title==='string'&&title.trim()).map(compact));
 const summaryLabel=/^(?:요약|내용\s*요약|영상\s*(?:요약|내용|소개|설명)|줄거리|설명|summary|description)\s*[:：]\s*(.*)$/iu;
 const summaryHeading=/^(?:요약|내용\s*요약|영상\s*(?:요약|내용|소개|설명)|줄거리|설명|summary|description)\s*[:：]?$/iu;
 const excludedHeading=/^(?:챕터|타임스탬프|시간표|태그|해시태그|출처|참고\s*(?:자료|문헌|링크|출처)|크레딧|저작권|제작\s*(?:정보|과정)|검증\s*(?:정보|결과)|chapters?|timestamps?|tags?|hashtags?|sources?|references?|credits?)\s*(?:[:：].*)?$/iu;
 const selfProduction=/^(?:이|본)\s*(?:영상|콘텐츠|작품)(?:은|는|에서는|에서|을|를)?\s*/u;
 const productionTerms=/\b(?:AI|TTS)\b|(?:내레이션|나레이션)|음성\s*합성|배경\s*음악|이미지\s*(?:생성|제작|편집)|다큐(?:멘터리)?\s*(?:스타일|형식)|(?:제작|편집)(?:해|하|했|되|된|으로)/iu;
 const productionLead=/^(?:(?:한국어\s*)?(?:내레이션|나레이션|TTS|음성\s*합성)|AI\s*(?:생성\s*)?이미지|인공지능\s*(?:생성\s*)?이미지|배경\s*음악)(?:과|와|을|를|으로|로|이|가|에|\s)/iu;
 const pureProduction=/^(?:(?:이|본)\s*(?:영상|콘텐츠|작품)(?:은|는)?\s*)?(?:한국어\s*)?(?:내레이션|나레이션|TTS|음성\s*합성|AI\s*(?:생성\s*)?이미지|인공지능\s*(?:생성\s*)?이미지|배경\s*음악)(?:\s*(?:과|와|및|그리고|,)\s*(?:한국어\s*)?(?:내레이션|나레이션|TTS|음성\s*합성|AI\s*(?:생성\s*)?이미지|인공지능\s*(?:생성\s*)?이미지|배경\s*음악))*\s*(?:을|를)?\s*(?:활용해|사용해|통해|활용하여|사용하여|활용해서|사용해서|으로|로)\s*(?:(?:내러티브\s*)?다큐(?:멘터리)?\s*(?:스타일|형식)(?:으로|로)\s*)?(?:구성|제작|편집|합성)(?:했습니다|하였습니다|했어요|한\s*영상입니다|한\s*콘텐츠입니다)[.!。]?$/iu;
 function stripKnownFormatSuffix(sentence){
  if(!selfProduction.test(sentence))return sentence;
  const next=sentence.replace(/(을|를)\s*(?:서사적으로\s*)?(?:정리한|소개하는|다룬|풀어낸)\s*(?:내러티브\s*)?다큐(?:멘터리)?\s*(?:스타일|형식)의\s*(?:단편\s*)?(?:영상|콘텐츠|작품)(?:입니다|이에요|이다)[.!。]?$/u,'$1 다룹니다.');
  return next===sentence?sentence:next.replace(selfProduction,'');
 }
 function boilerplate(sentence){
  if(evidence&&evidence.includes(compact(sentence)))return false;
  if(pureProduction.test(sentence))return true;
  if((selfProduction.test(sentence)&&productionTerms.test(sentence))||(productionLead.test(sentence)&&/(?:사용|활용|제작|편집|구성|합성|전달|소개|설명)/u.test(sentence)))throw new Error('영상 내용과 제작 방식 안내가 한 문장에 섞여 설명을 적용하지 않았어요. 내용 요약만 다시 작성해 주세요.');
  if(/^(?:구독(?:과|하고|을|해)|좋아요(?:와|를)|알림\s*설정|다음\s*영상(?:도|에서)|시청(?:해\s*주셔서|해주셔서)|끝까지\s*시청)/u.test(sentence))return true;
  return /^(?:(?:공식\s*(?:자료|출처)|웹\s*검색|온라인\s*(?:자료|출처))(?:를|을)?\s*(?:(?:통해|바탕으로)\s*)?(?:검증|확인|참고)(?:했습니다|하였습니다|했어요)|(?:사실|내용|출처)\s*(?:검증|확인)(?:을|이|은|는)?\s*(?:완료했습니다|마쳤습니다|했습니다))[.!。]?$/u.test(sentence);
 }
 const output=[];let excluded=false;
 for(const original of value.replace(/\r\n?/gu,'\n').split('\n')){
  let line=original.trim(),label=line.replace(/^#{1,6}\s*/u,'').replace(/\*\*/gu,'').trim();
  if(!line){excluded=false;if(output.length&&output.at(-1)!=='')output.push('');continue;}
  if(summaryHeading.test(label)){excluded=false;continue;}
  const summary=summaryLabel.exec(label);if(summary){excluded=false;line=summary[1].trim();if(!line)continue;label=line;}
  if(excluded)continue;
  if(/^(?:영상\s*제목|제목|title)\s*[:：]/iu.test(label)||knownTitles.has(compact(label)))continue;
  if(excludedHeading.test(label)){excluded=true;continue;}
  if(/^(?:[-*•]\s*)?(?:\d{1,3}:)?\d{1,3}:\d{2}(?:\s*[-–—]\s*(?:\d{1,3}:)?\d{1,3}:\d{2})?\s+\S/u.test(label))continue;
  line=line.replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/giu,'$1').replace(/https?:\/\/[^\s<>\[\]]+/giu,'').replace(/\bwww\.[^\s<>\[\]]+/giu,'').replace(/(^|\s)#[\p{L}\p{N}_-]+(?=\s|$)/gu,'$1').trim();
  if(!line)continue;
  const content=line.split(/(?<=[.!?。！？])\s+/u).map(sentence=>stripKnownFormatSuffix(sentence.trim())).filter(sentence=>!boilerplate(sentence)).join(' ').trim();
  if(content)output.push(content);
 }
 return output.join('\n').replace(/\n{3,}/gu,'\n\n').trim();
}
