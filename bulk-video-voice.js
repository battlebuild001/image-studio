import {apiFetch} from './api-client.js';
import {createId, getTimeline, getCaptions, validateProject} from './project.js';
import {getNarrationScript, getDisplayScript} from './production-speech.js';
import {combineVoiceChunks, VOICE_SAMPLE_RATE} from './voice-audio.js';
import {validateTypecastVoiceRequest, createTypecastSpeechPlan, typecastParagraphs, splitTypecastText} from './typecast-protocol.js';
import {voiceTextKey, voiceSettingsKey, normalizeVoiceSample} from './voice-preferences-protocol.js';
import {fitScenesToNarration, buildSyncPlan, protectedTitleDurations} from './sync-timing.js';
import {narrationPlanKey} from './script-planning.js';

const reviews = new WeakMap();
const clone = value => structuredClone(value);
const abort = () => new DOMException('음성 제작을 중지했어요. 완료한 음성은 유지돼요.', 'AbortError');
const checkAbort = signal => {if (signal?.aborted) throw abort();};
const displaySource = project => project.scriptDraft?.displayScript ?? project.scriptDraft?.result?.displayScript ?? project.scriptDraft?.draftScript ?? project.scriptDraft?.result?.script ?? project.scenes.map(scene=>scene.caption||'').join('\n\n');
const sourceKey = project => JSON.stringify({id:project.id, script:getNarrationScript(project),display:getDisplayScript(project),audio:project.audio,scenes:project.scenes,scenePlan:project.scenePlan,captionMode:project.captionMode,captions:project.captions,captionAnalysis:project.captionAnalysis});
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = text => Array.from(text).length;
const nameFor = project => `${String(project.title || '내레이션').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 100)}-내레이션.wav`;

/** Shared provider controls produce this shape; this function never fetches a
 * catalog or turns a saved voice into a different provider behind the user. */
export function normalizeBulkVoiceSettings(input = {}) {
  if (!plain(input)) throw new Error('공통 목소리 설정을 확인해 주세요.');
  if (input.provider === 'typecast') {
    const {characters, text, ...settings} = validateTypecastVoiceRequest({...input, text:'음성 설정'});
    return settings;
  }
  if (input.provider !== undefined && input.provider !== 'server' && input.provider !== 'clova') throw new Error('공통 음성 제공자 설정을 확인해 주세요.');
  if (Object.keys(input).some(key => !['provider','speaker','speed','pitch','volume'].includes(key))) throw new Error('공통 목소리 설정 항목을 확인해 주세요.');
  const settings = {speaker:input.speaker ?? 'nara',speed:input.speed ?? 0,pitch:input.pitch ?? 0,volume:input.volume ?? 0};
  if (settings.speaker !== 'nara') throw new Error('연결된 음성 API에서 지원하는 목소리를 선택해 주세요.');
  for (const [key,min,max] of [['speed',-5,10],['pitch',-5,5],['volume',-5,5]]) {
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error('목소리 속도·음높이·음량의 범위를 확인해 주세요.');
  }
  return settings;
}

/** A readonly, exact application-request count. Provider chunks are reported
 * separately because one reviewed app request may synthesize several chunks. */
export function prepareBulkVoice(project, settings, assets) {
  const validated = validateProject(project), narrationId = validated.audio.narrationId;
  if (narrationId) {
    if (assets && !assets.get(narrationId)?.blob) throw new Error('기존 내레이션 파일을 찾지 못했어요. 원본 프로젝트에서 음성을 확인해 주세요.');
    const review = Object.freeze({required:false,requestCount:0,requestCalls:0,providerChunks:0,text:'',settings:Object.freeze({}),payload:null,sceneCount:validated.scenes.length,reused:true});
    reviews.set(review,{sourceKey:sourceKey(project),kind:'existing',assetId:narrationId});return review;
  }
  const text = getNarrationScript(validated);
  if (!text.trim() || count(text) > 30000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || typeof text.isWellFormed === 'function' && !text.isWellFormed()) throw new Error('읽을 대본을 1~30,000자로 입력해 주세요.');
  if (!validated.scenes.length || validated.scenes.length > 200) throw new Error('음성을 넣을 장면 시간표를 먼저 준비해 주세요.');
  const titles = protectedTitleDurations(validated, assets || new Map());
  if (getTimeline(validated).duration <= titles.introSeconds + titles.outroSeconds + 1e-7) throw new Error('음성을 배치할 본문 장면을 먼저 준비해 주세요.');
  const normalized = normalizeBulkVoiceSettings(settings ?? validated.production?.speech?.voicePreferences ?? {});
  let payload, providerChunks;
  if (normalized.provider === 'typecast') {
    const paragraphs = typecastParagraphs(text);
    const value = {...normalized,text,...(normalized.paragraphPauses ? {paragraphPauses:normalized.paragraphPauses.filter(item => item.afterParagraph <= paragraphs.length)} : {})};
    const {characters, ...request} = validateTypecastVoiceRequest(value);payload = request;
    providerChunks = createTypecastSpeechPlan(request).length;
  } else {payload = {text,...normalized};providerChunks = splitTypecastText(text).length;}
  const textKey = voiceTextKey(text), settingsKey = voiceSettingsKey(normalized);
  const cached = validated.production?.speech?.voiceSamples?.find(sample => sample.textKey === textKey && sample.settingsKey === settingsKey && assets?.get(sample.assetId)?.blob);
  if (!cached && (validated.production?.speech?.voiceSamples?.length || 0) >= 20) throw new Error('이 프로젝트의 음성 샘플이 20개예요. 기존 샘플을 정리한 뒤 제작해 주세요.');
  if (payload.paragraphPauses) {for (const value of payload.paragraphPauses) Object.freeze(value);Object.freeze(payload.paragraphPauses);}
  Object.freeze(payload);if (normalized.paragraphPauses) {for (const value of normalized.paragraphPauses) Object.freeze(value);Object.freeze(normalized.paragraphPauses);}Object.freeze(normalized);
  const requestCount = cached ? 0 : 1;
  const review = Object.freeze({required:true,requestCount,requestCalls:requestCount,providerChunks:cached?0:providerChunks,text,settings:normalized,payload,textKey,settingsKey,sceneCount:validated.scenes.length,reused:Boolean(cached)});
  reviews.set(review,{sourceKey:sourceKey(project),kind:cached?'cached':'generate',assetId:cached?.assetId});return review;
}

/** Read the measured PCM length from the actual app-produced WAV, not the text
 * estimate or a provider's guessed duration. combineVoiceChunks emits this format. */
export async function measureBulkVoiceWav(blob) {
  if (!(blob instanceof Blob) || blob.size < 46 || blob.size > 180 * 1024 * 1024) throw new Error('완성한 음성 WAV 파일의 크기를 확인해 주세요.');
  const bytes = await blob.arrayBuffer(), view = new DataView(bytes), ascii = (offset,n) => String.fromCharCode(...new Uint8Array(bytes,offset,n));
  if (ascii(0,4)!=='RIFF'||ascii(8,4)!=='WAVE'||ascii(12,4)!=='fmt '||view.getUint32(4,true)+8!==bytes.byteLength||view.getUint32(16,true)!==16||view.getUint16(20,true)!==1||view.getUint16(22,true)!==1||view.getUint32(24,true)!==VOICE_SAMPLE_RATE||view.getUint32(28,true)!==VOICE_SAMPLE_RATE*2||view.getUint16(32,true)!==2||view.getUint16(34,true)!==16||ascii(36,4)!=='data'||view.getUint32(40,true)!==bytes.byteLength-44||(bytes.byteLength-44)%2) throw new Error('완성한 음성 WAV의 실제 샘플 형식을 확인하지 못했어요.');
  const duration = (bytes.byteLength-44)/(VOICE_SAMPLE_RATE*2);
  if (!Number.isFinite(duration)||duration<=0||duration>3600) throw new Error('완성한 음성은 60분 이내여야 해요.');
  return duration;
}

/** Fit actual new audio while retaining every currently visible edited cue.
 * Old speech cues are captured before swapping narration identity, and become
 * estimated manual cues rather than claiming precision for different audio. */
export function fitBulkVoiceProject(project, assets, assetId, duration, now = new Date()) {
  const next = clone(project), explicitCaptions = project.captionMode !== 'auto';
  if (explicitCaptions) {next.captions = getCaptions(project);next.captionMode = 'srt';next.captionAnalysis = null;}
  next.audio = {...next.audio,narrationId:assetId,narrationStart:0,narrationEnd:duration,narrationOffset:0};
  const fitted = explicitCaptions && next.captions.length ? buildSyncPlan(next,assets,{mode:'voice'}).project : fitScenesToNarration(next,assets);
  if (!explicitCaptions) {fitted.captionMode = 'auto';fitted.captions = [];}
  fitted.captionAnalysis = null;
  const timeline = getTimeline(fitted), original = project.scenePlan, prompts = new Map((original?.items||[]).map(item=>[item.sceneId,item.prompt]));
  fitted.scenePlan = {version:1,confirmedAt:new Date(now).toISOString(),intervalSeconds:original?.intervalSeconds||10,durationSeconds:timeline.duration,basis:'narration',sourceScript:displaySource(fitted),narrationKey:narrationPlanKey(fitted),
    items:timeline.scenes.map((scene,index)=>({sceneId:scene.id,start:scene.start,end:scene.end,caption:scene.caption,prompt:prompts.get(scene.id)||`${index+1}번 장면: ${scene.caption || '전체 대본과 앞뒤 장면에 맞는 이미지'}`})),
    ...(original?.visualBrief===undefined?{}:{visualBrief:original.visualBrief}),...(original?.imageInstructions===undefined?{}:{imageInstructions:original.imageInstructions})};
  return validateProject(fitted);
}

/** Run inside the queue's isolated, budget-bound adapter. All actual synthesis
 * goes through the existing transport and paid-job lock, with no retry. */
export async function runBulkVoice(api, review, {signal,guard,onProgress=()=>{},combine=combineVoiceChunks,now=()=>new Date(),idFactory=createId} = {}) {
  const saved = reviews.get(review);
  if (!saved || sourceKey(api.getProject()) !== saved.sourceKey) throw new Error('음성을 만들 대본이나 시간표가 바뀌었어요. 제작 범위를 다시 확인해 주세요.');
  let applying = false;
  const check = () => {checkAbort(signal);if (guard?.()===false) throw abort();if (!applying && sourceKey(api.getProject())!==saved.sourceKey) throw new Error('읽을 대본이나 시간표가 바뀌어 이전 음성 결과를 적용하지 않았어요.');};
  check();
  if (saved.kind==='existing') return {generated:false,requestCount:0,reused:true,assetId:saved.assetId};
  let assetId = saved.assetId, duration;
  const request = api.apiFetch || apiFetch;
  if (saved.kind==='generate') {
    await api.persist?.();check();onProgress({phase:'voice',message:'읽을 대본 전체를 음성으로 만들고 있어요.'});
    const response = await request('/api/voice/generate',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify(review.payload)});check();
    if (!response.ok) throw new Error('음성을 생성하지 못했어요. 음성 API 연결과 사용 한도를 확인해 주세요.');
    let result;try {result=await response.json();} catch {throw new Error('음성 생성 응답을 읽지 못했어요.');}check();
    if (review.settings.provider==='typecast' && result.provider!=='typecast') throw new Error('선택한 음성 제공자의 결과인지 확인하지 못했어요.');
    onProgress({phase:'voice',message:'생성한 음성 구간을 WAV로 합치고 있어요.'});
    const blob = await combine(result.chunks,{signal,...(result.provider==='typecast'?{maxInputBytes:160*1024*1024,applyParagraphPauses:true}:{})});check();
    duration = await measureBulkVoiceWav(blob);check();assetId=idFactory('voice');
    const name=nameFor(api.getProject()),asset={blob,name,type:'audio/wav',duration};api.getAssets().set(assetId,asset);
    const sample=normalizeVoiceSample({assetId,name,textKey:review.textKey,settingsKey:review.settingsKey,createdAt:now().toISOString(),duration,settings:review.settings.provider==='typecast'?review.settings:{provider:'server',...review.settings}});
    api.mutate(project=>{project.production||={version:1};project.production.speech||={};project.production.speech.voiceSamples=[...(project.production.speech.voiceSamples||[]),sample];if(review.settings.provider==='typecast')project.production.speech.voicePreferences=clone(review.settings);});
    // Preserve the paid result before applying timing. An interrupted save/apply
    // can reuse this matching sample without synthesizing the same text again.
    await api.persist?.();check();
  } else {
    const blob=api.getAssets().get(assetId)?.blob;if(!blob)throw new Error('저장한 음성 샘플을 찾지 못했어요.');duration=await measureBulkVoiceWav(blob);check();
    api.getAssets().get(assetId).duration=duration;
  }
  const next=fitBulkVoiceProject(api.getProject(),api.getAssets(),assetId,duration,now());check();
  applying = true;api.mutate(project=>Object.assign(project,next));await api.persist?.();check();
  onProgress({phase:'voice',message:`실제 음성 ${duration.toFixed(2)}초를 저장하고 장면 시간을 맞췄어요. 자막 시간은 추정값입니다.`});
  return {generated:saved.kind==='generate',requestCount:review.requestCount,reused:saved.kind==='cached',assetId,duration};
}
