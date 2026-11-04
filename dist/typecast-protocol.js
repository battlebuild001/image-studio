/** Shared Typecast API data validation. No credentials, network calls or project state. */
export const TYPECAST_MODELS = Object.freeze(['ssfm-v31', 'ssfm-v30', 'ssfm-v21']);
export const TYPECAST_DEFAULT_MODEL = 'ssfm-v31';
export const TYPECAST_MAX_TEXT = 30000;
export const TYPECAST_CHUNK_CHARACTERS = 2000;
export const TYPECAST_MAX_CHUNK_AUDIO_BYTES = 32 * 1024 * 1024;
export const TYPECAST_MAX_AUDIO_BYTES = 160 * 1024 * 1024;
export const TYPECAST_EMOTIONS = Object.freeze(['normal', 'happy', 'sad', 'angry', 'whisper', 'toneup', 'tonedown']);
const MODEL_SET = new Set(TYPECAST_MODELS), EMOTIONS = new Set(TYPECAST_EMOTIONS);
const V21_EMOTIONS = TYPECAST_EMOTIONS.slice(0, 4);
const FIELDS = new Set(['provider', 'text', 'speaker', 'model', 'tempo', 'pitch', 'volume', 'emotionType', 'emotion', 'emotionIntensity', 'paragraphPauseSeconds', 'paragraphPauses']);
const VOICE_ID = /^(?:tc|uc)_[A-Za-z0-9_-]{1,180}$/u;
const encoder = new TextEncoder();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class TypecastProtocolError extends Error {
  constructor(message, {status = 400, code = 'INVALID_TYPECAST_INPUT'} = {}) {super(message);this.name = 'TypecastProtocolError';this.status = status;this.code = code;}
}
const invalid = message => new TypecastProtocolError(message);
const invalidResponse = message => new TypecastProtocolError(message || '타입캐스트 응답의 형식을 확인하지 못했어요. 기존 대본과 음성은 유지돼요.', {status: 502, code: 'INVALID_TYPECAST_RESPONSE'});
function modelName(value = TYPECAST_DEFAULT_MODEL) {
  if (!MODEL_SET.has(value)) throw invalid('지원하는 타입캐스트 모델을 선택해 주세요.');return value;
}
function wellFormed(value) {
  if (typeof value.isWellFormed === 'function') return value.isWellFormed();
  for (let i = 0; i < value.length; i++) {
    const point = value.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdbff) {const next = value.charCodeAt(++i);if (!(next >= 0xdc00 && next <= 0xdfff)) return false;}
    else if (point >= 0xdc00 && point <= 0xdfff) return false;
  }
  return true;
}
function textValue(value, limit, {allowWhitespace = false, label = '읽을 대본'} = {}) {
  if (typeof value !== 'string' || !wellFormed(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || (!allowWhitespace && !value.trim())) throw invalid(`${label}의 글자와 내용을 확인해 주세요.`);
  const characters = Array.from(value).length;
  if (!characters || characters > limit) throw invalid(`${label}은 1~${limit.toLocaleString('ko-KR')}자로 입력해 주세요.`);
  return characters;
}
function ranged(value, fallback, min, max, label, integer = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw invalid(`${label} 범위(${min}~${max})를 확인해 주세요.`);
  return value;
}
function voiceId(value) {if (typeof value !== 'string' || !VOICE_ID.test(value)) throw invalid('타입캐스트 목록에서 사용할 목소리를 선택해 주세요.');return value;}
function labelValue(value, max = 300, allowBlank = false) {return typeof value === 'string' && (allowBlank || Boolean(value.trim())) && Array.from(value).length <= max && wellFormed(value) && !/[\u0000-\u001f\u007f]/u.test(value);}
function previewUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['static.typecast.ai', 'static2.typecast.ai'].includes(url.hostname) || url.hash) return null;
    return url.href;
  } catch {return null;}
}

/** /v3/voices returns a bare array. A localized name does not establish a voice's language. */
export function normalizeTypecastVoices(input, {model} = {}) {
  if (model !== undefined) modelName(model);
  let serialized;
  try {serialized = JSON.stringify(input);} catch {throw invalidResponse();}
  if (!Array.isArray(input) || input.length > 10000 || typeof serialized !== 'string' || encoder.encode(serialized).byteLength > 8 * 1024 * 1024) throw invalidResponse('타입캐스트 목소리 목록의 크기나 형식을 확인하지 못했어요.');
  const ids = new Set(), result = [];
  for (const item of input) {
    if (!plain(item) || typeof item.voice_id !== 'string' || !VOICE_ID.test(item.voice_id) || ids.has(item.voice_id) || !plain(item.voice_name) || !labelValue(item.voice_name.kor, 300, true) || !labelValue(item.voice_name.eng, 300, true) || !(item.voice_name.kor.trim() || item.voice_name.eng.trim()) || !Array.isArray(item.models) || item.models.length > 30) throw invalidResponse('타입캐스트 목소리 목록의 식별자나 이름을 확인하지 못했어요.');
    ids.add(item.voice_id);
    const versions = new Set(), models = [];
    for (const candidate of item.models) {
      if (!plain(candidate) || typeof candidate.version !== 'string' || !Array.isArray(candidate.emotions) || candidate.emotions.length > 100 || candidate.emotions.some(value => typeof value !== 'string' || value.length > 80)) throw invalidResponse('타입캐스트 목소리의 모델·감정 정보를 확인하지 못했어요.');
      if (!MODEL_SET.has(candidate.version)) continue;
      if (versions.has(candidate.version)) throw invalidResponse('타입캐스트 목소리의 모델 정보가 중복돼요.');versions.add(candidate.version);
      const available = candidate.version === 'ssfm-v21' ? V21_EMOTIONS : TYPECAST_EMOTIONS;
      const emotions = [...new Set(candidate.emotions.filter(value => available.includes(value)))];
      models.push({version: candidate.version, emotions});
    }
    if (!models.length || (model && !models.some(value => value.version === model))) continue;
    const speaker = {id: item.voice_id, name: item.voice_name.kor.trim() || item.voice_name.eng.trim(), language: 'multi', models};
    const preview = previewUrl(item.preview_url);if (preview) speaker.previewUrl = preview;
    for (const key of ['gender', 'age']) if (labelValue(item[key], 80)) speaker[key] = item[key];
    result.push(speaker);
  }
  return result;
}

/** Only canonical Typecast controls are accepted; legacy server knobs must not be reinterpreted. */
export function validateTypecastVoiceRequest(input, {model, voiceId: defaultVoice} = {}) {
  if (!plain(input) || Object.keys(input).some(key => !FIELDS.has(key)) || input.provider !== 'typecast') throw invalid('타입캐스트 음성 생성 요청 형식을 확인해 주세요.');
  const characters = textValue(input.text, TYPECAST_MAX_TEXT);
  if (splitTypecastText(input.text).some(chunk => !chunk.trim())) throw invalid('공백만 있는 긴 구간을 줄여 주세요. 대본은 변경하지 않았어요.');
  const selectedModel = modelName(input.model ?? model ?? TYPECAST_DEFAULT_MODEL);
  const emotionType = input.emotionType ?? (selectedModel === 'ssfm-v21' ? 'preset' : 'smart');
  if (!['smart', 'preset'].includes(emotionType) || (selectedModel === 'ssfm-v21' && emotionType !== 'preset')) throw invalid('선택한 타입캐스트 모델에서 지원하는 감정 방식을 선택해 주세요.');
  const emotion = input.emotion ?? 'normal', allowed = selectedModel === 'ssfm-v21' ? V21_EMOTIONS : TYPECAST_EMOTIONS;
  if (!allowed.includes(emotion)) throw invalid('선택한 타입캐스트 모델에서 지원하는 감정을 선택해 주세요.');
  return {provider: 'typecast', text: input.text, characters, speaker: voiceId(input.speaker ?? defaultVoice), model: selectedModel,
    tempo: ranged(input.tempo, 1, .5, 2, '읽는 속도'), pitch: ranged(input.pitch, 0, -12, 12, '음높이', true), volume: ranged(input.volume, 100, 0, 200, '음량', true),
    emotionType, emotion, emotionIntensity: ranged(input.emotionIntensity, 1, 0, 2, '감정 강도'),
    ...(input.paragraphPauseSeconds!==undefined?{paragraphPauseSeconds:ranged(input.paragraphPauseSeconds,0,0,10,'단락 뒤 추가 쉼')}:{}),
    ...(input.paragraphPauses!==undefined?{paragraphPauses:normalizeParagraphPauses(input.paragraphPauses)}:{})};
}
/** Paragraph pauses are app-side PCM silence; no undocumented field goes to Typecast. */
export function normalizeParagraphPauses(input) {
  if(!Array.isArray(input)||input.length>1000)throw invalid('단락별 쉼은 최대 1,000개까지 지정할 수 있어요.');
  const seen=new Set();return input.map(value=>{if(!plain(value)||Object.keys(value).some(key=>!['afterParagraph','seconds'].includes(key))||!Number.isInteger(value.afterParagraph)||value.afterParagraph<1||value.afterParagraph>1000||seen.has(value.afterParagraph)||value.seconds===undefined)throw invalid('단락별 쉼의 위치를 확인해 주세요.');seen.add(value.afterParagraph);return{afterParagraph:value.afterParagraph,seconds:ranged(value.seconds,undefined,0,10,'단락 뒤 추가 쉼')};}).sort((a,b)=>a.afterParagraph-b.afterParagraph);
}
export function typecastParagraphs(text) {
  textValue(text,TYPECAST_MAX_TEXT);const result=[];let start=0,pending='';
  for(const match of text.matchAll(/(?:\r?\n)[\t ]*(?:\r?\n)+/gu)){const end=match.index+match[0].length,piece=text.slice(start,end);start=end;if(piece.trim()){result.push(pending+piece);pending='';}else if(result.length)result[result.length-1]+=piece;else pending+=piece;}
  const tail=text.slice(start);if(tail.trim())result.push(pending+tail);else if(result.length)result[result.length-1]+=pending+tail;else if(pending||tail)result.push(pending+tail);return result;
}
export function createTypecastSpeechPlan(input) {
  const settings=canonicalSettings(input),globalPause=settings.paragraphPauseSeconds??0,overrides=new Map((settings.paragraphPauses??[]).map(value=>[value.afterParagraph,value.seconds]));
  if(!globalPause&&![...overrides.values()].some(value=>value>0))return splitTypecastText(settings.text).map(text=>({text,pauseAfterSeconds:0}));
  const paragraphs=typecastParagraphs(settings.text),result=[];
  for(const key of overrides.keys())if(key>paragraphs.length)throw invalid('현재 대본에 없는 단락의 쉼 설정을 확인해 주세요.');
  for(const [index,paragraph]of paragraphs.entries()){const pieces=splitTypecastText(paragraph);for(const text of pieces){if(!text.trim())throw invalid('공백만 있는 긴 구간을 줄여 주세요. 대본은 변경하지 않았어요.');result.push({text,pauseAfterSeconds:0});}result[result.length-1].pauseAfterSeconds=overrides.get(index+1)??(index<paragraphs.length-1?globalPause:0);}
  if(result.length>100)throw invalid('단락과 합성 구간은 최대 100개로 줄여 주세요.');return result;
}

function canonicalSettings(input) {
  if (!plain(input)) throw invalid('타입캐스트 음성 설정을 확인해 주세요.');
  const {characters, ...rest} = input, settings = validateTypecastVoiceRequest(rest);
  if (characters !== undefined && characters !== settings.characters) throw invalid('타입캐스트 대본의 글자 수를 확인해 주세요.');
  return settings;
}

/** Preserve every code point, including whitespace, while preferring whole sentence boundaries. */
export function splitTypecastText(text, limit = TYPECAST_CHUNK_CHARACTERS) {
  textValue(text, TYPECAST_MAX_TEXT);
  if (!Number.isInteger(limit) || limit < 1 || limit > TYPECAST_CHUNK_CHARACTERS) throw invalid('타입캐스트 대본을 나누는 글자 수를 확인해 주세요.');
  const chars = Array.from(text), result = [];let start = 0;
  while (start < chars.length) {
    let end = Math.min(chars.length, start + limit);
    if (end < chars.length) {
      const minimum = start + Math.floor(limit * .65);let whitespace = -1;
      for (let at = end - 1; at >= minimum; at--) {
        if (chars[at] === '\n' || (/[.!?。！？]/u.test(chars[at]) && /\s/u.test(chars[at + 1] || ''))) {end = at + 1;break;}
        if (whitespace < 0 && /\s/u.test(chars[at])) whitespace = at + 1;
        if (at === minimum && whitespace > start) end = whitespace;
      }
    }
    result.push(chars.slice(start, end).join(''));start = end;
  }
  return result;
}

/** Official synchronous TTS JSON: Korean ISO639-3 and compact MP3 output, no undocumented fields. */
export function buildTypecastTtsRequest(input, text = input?.text, {previousText, nextText} = {}) {
  const settings = canonicalSettings(input);textValue(text, TYPECAST_CHUNK_CHARACTERS, {allowWhitespace: true});
  const request = {voice_id: settings.speaker, model: settings.model, text, language: 'kor',
    output: {audio_format: 'mp3', audio_tempo: settings.tempo, audio_pitch: settings.pitch, volume: settings.volume}};
  if (settings.model === 'ssfm-v21') request.prompt = {emotion_preset: settings.emotion, emotion_intensity: settings.emotionIntensity};
  else if (settings.emotionType === 'preset') request.prompt = {emotion_type: 'preset', emotion_preset: settings.emotion, emotion_intensity: settings.emotionIntensity};
  else {
    request.prompt = {emotion_type: 'smart'};
    for (const [key, value] of [['previous_text', previousText], ['next_text', nextText]]) if (value !== undefined && value !== '') {textValue(value, TYPECAST_CHUNK_CHARACTERS, {allowWhitespace: true, label: '앞뒤 문맥'});request.prompt[key] = value;}
  }
  return request;
}

/** Check actual account-visible voice/model/preset compatibility before a charged POST. */
export function assertTypecastVoiceSupport(input, speakers) {
  const settings = canonicalSettings(input);
  if (!Array.isArray(speakers) || speakers.length > 10000) throw invalid('타입캐스트 목소리 목록을 먼저 확인해 주세요.');
  const speaker = speakers.find(value => plain(value) && value.id === settings.speaker), model = Array.isArray(speaker?.models) ? speaker.models.find(value => value?.version === settings.model) : null;
  if (!speaker || !model) throw invalid('선택한 타입캐스트 목소리가 현재 모델에서 지원되지 않아요. 목소리 목록과 모델을 다시 확인해 주세요.');
  if (settings.emotionType === 'preset' && (!Array.isArray(model.emotions) || !model.emotions.includes(settings.emotion))) throw invalid('선택한 타입캐스트 목소리가 해당 감정을 지원하지 않아요. 다른 감정을 선택해 주세요.');
  return speaker;
}

export function getTypecastConfig(speakers, model = TYPECAST_DEFAULT_MODEL) {
  modelName(model);
  if (!Array.isArray(speakers) || speakers.length > 10000) throw invalidResponse('타입캐스트 목소리 목록을 확인하지 못했어요.');
  const compatible = speakers.filter(speaker => plain(speaker) && Array.isArray(speaker.models) && speaker.models.some(value => value?.version === model));
  return {configured: compatible.length > 0, provider: 'typecast', model, speakers: compatible,
    capabilities: {tempo: {min: .5, max: 2, step: .05, default: 1}, pitch: {min: -12, max: 12, step: 1, default: 0}, volume: {min: 0, max: 200, step: 1, default: 100},
      emotionTypes: model === 'ssfm-v21' ? ['preset'] : ['smart', 'preset'], emotions: [...(model === 'ssfm-v21' ? V21_EMOTIONS : TYPECAST_EMOTIONS)],
      emotionIntensity: {min: 0, max: 2, step: .1, default: 1}, language: 'kor', audioFormat: 'mp3'}};
}

function ascii(bytes, start, end) {let value = '';for (let index = start; index < end; index++) value += String.fromCharCode(bytes[index]);return value;}
function mpegFrame(bytes, offset) {
  if (offset + 4 > bytes.length || bytes[offset] !== 255 || (bytes[offset + 1] & 0xe0) !== 0xe0) return false;
  const version = bytes[offset + 1] >> 3 & 3, layer = bytes[offset + 1] >> 1 & 3, bitrate = bytes[offset + 2] >> 4, sample = bytes[offset + 2] >> 2 & 3;
  if (version === 1 || layer !== 1 || !bitrate || bitrate === 15 || sample === 3) return false;
  const rates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const rate = [44100,48000,32000][sample] / (version === 3 ? 1 : version === 2 ? 2 : 4), length = Math.floor((version === 3 ? 144 : 72) * rates[bitrate] * 1000 / rate) + (bytes[offset + 2] >> 1 & 1);
  return length >= 24 && offset + length <= bytes.length;
}

/** Sniff real bounded PCM/MP3 bytes; JSON errors, download URLs and truncated containers are rejected. */
export function validateTypecastAudio(bytes, contentType = '') {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > TYPECAST_MAX_CHUNK_AUDIO_BYTES || !['', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'application/octet-stream'].includes(mime)) throw invalidResponse('타입캐스트가 유효한 음성 파일을 반환하지 않았어요. 기존 음성은 유지돼요.');
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.length) throw invalidResponse('타입캐스트 음성 파일의 크기가 맞지 않아요.');
    let position = 12, format = null, dataLength = 0;
    while (position + 8 <= bytes.length) {
      const name = ascii(bytes, position, position + 4), size = view.getUint32(position + 4, true), start = position + 8;
      if (start + size + size % 2 > bytes.length) throw invalidResponse('타입캐스트 WAV 음성 파일이 잘렸어요.');
      if (name === 'fmt ') {
        if (format || size < 16) throw invalidResponse('타입캐스트 WAV 형식 정보를 확인하지 못했어요.');
        const encoding = view.getUint16(start, true), channels = view.getUint16(start + 2, true), rate = view.getUint32(start + 4, true), byteRate = view.getUint32(start + 8, true), blockAlign = view.getUint16(start + 12, true), bits = view.getUint16(start + 14, true);
        if (![1, 3].includes(encoding) || channels < 1 || channels > 8 || rate < 8000 || rate > 384000 || ![8,16,24,32,64].includes(bits) || (encoding === 3 && ![32,64].includes(bits)) || blockAlign !== channels * bits / 8 || byteRate !== rate * blockAlign) throw invalidResponse('타입캐스트 WAV 음성의 샘플 정보를 확인하지 못했어요.');
        format = {blockAlign};
      }
      if (name === 'data') {if (!size || dataLength) throw invalidResponse('타입캐스트 WAV에 음성 데이터가 없거나 중복돼요.');dataLength = size;}
      position = start + size + size % 2;
    }
    if (!format || !dataLength || position !== bytes.length || dataLength % format.blockAlign) throw invalidResponse('타입캐스트 WAV의 실제 음성 데이터를 확인하지 못했어요.');
    return {bytes, mimeType: 'audio/wav'};
  }
  let offset = 0;
  if (ascii(bytes, 0, 3) === 'ID3') {
    if (bytes.length < 14 || ![2,3,4].includes(bytes[3]) || Array.from(bytes.subarray(6, 10)).some(value => value & 0x80)) throw invalidResponse('타입캐스트 MP3 메타데이터를 확인하지 못했어요.');
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);if (bytes[3] === 4 && bytes[5] & 0x10) offset += 10;
  }
  if (!mpegFrame(bytes, offset)) throw invalidResponse('타입캐스트가 실제 MP3 또는 WAV 음성을 반환하지 않았어요.');
  return {bytes, mimeType: 'audio/mpeg'};
}
