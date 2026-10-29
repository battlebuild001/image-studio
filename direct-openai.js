import {validateScriptRequest, buildScriptRequest, parseScriptResponse} from './script-protocol.js';
import {buildImagePrompt} from './image-prompt.js';
import {buildDirectTranscriptRequest, parseTranscriptResponse} from './transcript-protocol.js';

const SESSION_KEY = 'bth-studio-openai-session-v1';
const SCRIPT_CONFIG = '/api/script/config', SCRIPT_GENERATE = '/api/script/generate';
const IMAGE_CONFIG = '/api/image/config', IMAGE_GENERATE = '/api/image/generate';
const TRANSCRIPT_CONFIG = '/api/transcript/config', TRANSCRIPT_ANALYZE = '/api/transcript/analyze';
const ROUTES = new Set([SCRIPT_CONFIG, SCRIPT_GENERATE, IMAGE_CONFIG, IMAGE_GENERATE, TRANSCRIPT_CONFIG, TRANSCRIPT_ANALYZE]);
const DEFAULTS = Object.freeze({enabled: false, apiKey: '', rememberForTab: false,
  scriptModel: 'gpt-5-mini', imageModel: 'gpt-image-2', transcribeModel: 'whisper-1'});
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024, MAX_REFERENCES_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024, MAX_RESPONSE_BYTES = 30 * 1024 * 1024;
const SIZES = ['1536x864', '864x1536', '1024x1024'], QUALITIES = ['low', 'medium', 'high'];
const ROLES = ['concept', 'background', 'character', 'style', 'other'];
const MIME_EXTENSIONS = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const visible = value => typeof value === 'string' && /^[\x21-\x7e]+$/u.test(value);

export class DirectOpenAiError extends Error {
  constructor(status, code, message) {super(message);this.name = 'DirectOpenAiError';this.status = status;this.code = code;}
}
const invalid = message => new DirectOpenAiError(400, 'INVALID_INPUT', message);
const abortError = () => new DOMException('작업을 취소했어요. 기존 자료와 결과는 유지돼요.', 'AbortError');
const safeError = (status, code, message) => new DirectOpenAiError(status, code, message);
function validateKey(value) {
  if (typeof value !== 'string') throw invalid('OpenAI API 키를 확인해 주세요.');
  const key = value.trim();
  if (!key.startsWith('sk-') || key.length < 24 || key.length > 1024 || !visible(key)) {
    throw invalid('OpenAI API 키는 sk-로 시작하는 공백 없는 키를 입력해 주세요.');
  }
  return key;
}
function validateModel(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/u.test(value)) throw invalid(`${label} 모델 이름을 확인해 주세요.`);
  if (/^sk-/iu.test(value)) throw invalid('API 키는 모델 이름 대신 API 키 입력란에 넣어 주세요.');
  return value;
}
function normalizeSettings(input, previous = DEFAULTS) {
  if (!plain(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULTS, key))) throw invalid('지원하지 않는 OpenAI 설정입니다.');
  const value = {...previous};
  if (Object.hasOwn(input, 'apiKey') && input.apiKey !== undefined && input.apiKey !== '') value.apiKey = validateKey(input.apiKey);
  if (Object.hasOwn(input, 'enabled')) {if (typeof input.enabled !== 'boolean') throw invalid('OpenAI 연결 사용 여부를 확인해 주세요.');value.enabled = input.enabled;}
  else if (input.apiKey) value.enabled = true;
  if (Object.hasOwn(input, 'rememberForTab')) {if (typeof input.rememberForTab !== 'boolean') throw invalid('탭에서 키 기억 설정을 확인해 주세요.');value.rememberForTab = input.rememberForTab;}
  for (const [key, label] of [['scriptModel', '대본'], ['imageModel', '이미지'], ['transcribeModel', '음성 분석']]) {
    if (Object.hasOwn(input, key)) value[key] = validateModel(input[key], label);
  }
  if (['gpt-image-1', 'dall-e-2', 'dall-e-3'].includes(value.imageModel)) throw invalid('지원이 종료된 이미지 모델입니다. gpt-image-2를 사용해 주세요.');
  if (value.transcribeModel !== 'whisper-1') throw invalid('음성 분석에는 단어별 시간을 지원하는 whisper-1을 사용해 주세요.');
  if (value.enabled && !value.apiKey) throw invalid('OpenAI API 키를 먼저 입력해 주세요.');
  return value;
}
const metadata = settings => ({enabled: Boolean(settings.enabled && settings.apiKey), hasKey: Boolean(settings.apiKey),
  rememberForTab: settings.rememberForTab, scriptModel: settings.scriptModel,
  imageModel: settings.imageModel, transcribeModel: settings.transcribeModel});
function browserStorage() {try {return globalThis.sessionStorage || null;} catch {return null;}}
function emitSettingsChange() {if (typeof window !== 'undefined') window.dispatchEvent(new Event('studio-api-settings-change'));}
function jsonResponse(status, body, head = false) {
  return new Response(head ? null : JSON.stringify(body), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}});
}
function textField(value, fallback, max, label) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || Array.from(value).length > max) throw invalid(`${label} 형식이나 길이를 확인해 주세요.`);
  return value.replace(/\u0000/g, '').trim();
}
function bytesBase64(value, maxBytes, label = '이미지') {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw invalid(`${label} 데이터의 크기나 형식을 확인해 주세요.`);
  }
  let decoded;
  try {decoded = atob(value);} catch {throw invalid(`${label} 데이터를 읽지 못했어요.`);}
  if (!decoded.length || decoded.length > maxBytes || btoa(decoded) !== value) throw invalid(`${label} 데이터의 크기나 형식을 확인해 주세요.`);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}
const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));
const dimensions = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= 40_000_000;
function isPng(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || signature.some((byte, index) => bytes[index] !== byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);let position = 8, chunks = 0, pixels = false;
  while (position + 12 <= bytes.length && ++chunks <= 10000) {
    const length = view.getUint32(position), type = ascii(bytes, position + 4, position + 8);
    if (position + 12 + length > bytes.length) return false;
    if (position === 8 && (type !== 'IHDR' || length !== 13 || !dimensions(view.getUint32(16), view.getUint32(20)))) return false;
    if (type === 'IDAT' && length) pixels = true;
    if (type === 'IEND') return length === 0 && pixels && position + 12 === bytes.length;
    position += length + 12;
  }
  return false;
}
function isJpeg(bytes) {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);let offset = 2, segments = 0, sizeKnown = false;
  while (offset + 1 < bytes.length && ++segments <= 10000) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 218) return sizeKnown && offset + 2 < bytes.length;
    if (marker === 217) return false;
    if (marker === 1 || (marker >= 208 && marker <= 216)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8 || !dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3))) return false;
      sizeKnown = true;
    }
    offset += length;
  }
  return false;
}
function isWebp(bytes) {
  if (bytes.length < 26 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return false;
  let offset = 12, chunks = 0, sizeKnown = false, pixels = false;
  const uint24 = from => bytes[from] + (bytes[from + 1] << 8) + (bytes[from + 2] << 16);
  while (offset + 8 <= bytes.length && ++chunks <= 10000) {
    const type = ascii(bytes, offset, offset + 4), size = view.getUint32(offset + 4, true), from = offset + 8;
    if (from + size > bytes.length) return false;
    if (type === 'VP8X') {
      if (size < 10 || !dimensions(1 + uint24(from + 4), 1 + uint24(from + 7))) return false;
      sizeKnown = true;
    } else if (type === 'VP8 ') {
      if (size < 10 || bytes[from + 3] !== 157 || bytes[from + 4] !== 1 || bytes[from + 5] !== 42 || !dimensions(view.getUint16(from + 6, true) & 16383, view.getUint16(from + 8, true) & 16383)) return false;
      sizeKnown = true;pixels = true;
    } else if (type === 'VP8L') {
      if (size < 5 || bytes[from] !== 47) return false;
      const width = 1 + bytes[from + 1] + ((bytes[from + 2] & 63) << 8), height = 1 + (bytes[from + 2] >> 6) + (bytes[from + 3] << 2) + ((bytes[from + 4] & 15) << 10);
      if (!dimensions(width, height)) return false;
      sizeKnown = true;pixels = true;
    }
    offset = from + size + size % 2;
  }
  return offset === bytes.length && sizeKnown && pixels;
}
function imageSettings(input) {
  if (!plain(input) || Object.keys(input).some(key => !['prompt', 'background', 'style', 'negativePrompt', 'size', 'quality', 'references'].includes(key))) throw invalid('이미지 요청 설정을 확인해 주세요.');
  const prompt = textField(input.prompt, undefined, 10000, '장면 요청');
  if (!prompt) throw invalid('이번에 만들 장면을 입력해 주세요.');
  const size = input.size ?? '1536x864', quality = input.quality ?? 'medium';
  if (!SIZES.includes(size) || !QUALITIES.includes(quality)) throw invalid('이미지 비율과 출력 품질을 확인해 주세요.');
  if (!Array.isArray(input.references) || input.references.length < 1 || input.references.length > 5) throw invalid('고정 레퍼런스 이미지를 1~5장 선택해 주세요.');
  let total = 0;
  const references = input.references.map((reference, index) => {
    if (!plain(reference) || Object.keys(reference).some(key => !['label', 'role', 'mimeType', 'data'].includes(key))) throw invalid('레퍼런스 이미지 정보를 확인해 주세요.');
    const role = reference.role ?? 'concept', mimeType = reference.mimeType;
    if (!ROLES.includes(role) || !Object.hasOwn(MIME_EXTENSIONS, mimeType)) throw invalid('레퍼런스 이미지의 역할과 형식을 확인해 주세요.');
    const label = textField(reference.label, `참조 이미지 ${index + 1}`, 120, '레퍼런스 이름').replace(/[\u0000-\u001f\u007f]/gu, ' ');
    const bytes = bytesBase64(reference.data, MAX_REFERENCE_BYTES, '레퍼런스 이미지');total += bytes.length;
    if (total > MAX_REFERENCES_BYTES) throw safeError(413, 'REFERENCES_TOO_LARGE', '레퍼런스 이미지 합계는 20MB 이하로 줄여 주세요.');
    if (!(mimeType === 'image/png' ? isPng(bytes) : mimeType === 'image/jpeg' ? isJpeg(bytes) : isWebp(bytes))) throw invalid('레퍼런스의 실제 이미지 형식을 확인해 주세요.');
    return {label: label || `참조 이미지 ${index + 1}`, role, mimeType, bytes};
  });
  references.sort((left, right) => Number(right.role === 'concept') - Number(left.role === 'concept'));
  return {prompt, size, quality, references, background: textField(input.background, '', 20000, '배경 설정'),
    style: textField(input.style, '', 4000, '고정 화풍'), negativePrompt: textField(input.negativePrompt, '', 2000, '피할 요소')};
}
function imageRequest(settings, model) {
  if (['gpt-image-1.5', 'gpt-image-1-mini'].includes(model) && settings.size !== '1024x1024') throw invalid('선택한 이미지 모델은 정사각형 출력만 지원해요. gpt-image-2 또는 정사각형을 선택해 주세요.');
  const promptUsed = buildImagePrompt(settings), body = new FormData();
  for (const [key, value] of Object.entries({model, prompt: promptUsed, size: settings.size, quality: settings.quality, n: '1', output_format: 'png'})) body.append(key, value);
  if (model === 'gpt-image-1.5') body.append('input_fidelity', 'high');
  if (model === 'gpt-image-1-mini') body.append('input_fidelity', 'low');
  for (const [index, reference] of settings.references.entries()) body.append('image[]', new Blob([reference.bytes], {type: reference.mimeType}), `reference-${String(index + 1).padStart(2, '0')}.${MIME_EXTENSIONS[reference.mimeType]}`);
  return {body, promptUsed};
}
function parseImage(response, settings, promptUsed) {
  const value = plain(response) && Array.isArray(response.data) && response.data.length === 1 ? response.data[0] : null;
  if (!plain(value) || typeof value.b64_json !== 'string') throw safeError(502, 'INVALID_AI_IMAGE', '생성된 PNG 이미지를 받지 못했어요. 기존 결과는 유지돼요.');
  let bytes;try {bytes = bytesBase64(value.b64_json, MAX_OUTPUT_BYTES, '생성 이미지');} catch {throw safeError(502, 'INVALID_AI_IMAGE', '생성된 이미지의 크기나 형식을 확인하지 못했어요.');}
  if (!isPng(bytes)) throw safeError(502, 'INVALID_AI_IMAGE', '생성된 PNG 이미지 형식이 올바르지 않아요.');
  const now = new Date();
  return {image: {mimeType: 'image/png', data: value.b64_json, name: `reference-scene-${now.getTime()}.png`},
    promptUsed, referenceCount: settings.references.length, size: settings.size, quality: settings.quality, generatedAt: now.toISOString()};
}
function providerError(status) {
  if (status === 401) return safeError(401, 'OPENAI_AUTH_FAILED', 'OpenAI API 키가 올바르지 않거나 만료됐어요. 설정에서 키를 확인해 주세요.');
  if (status === 403) return safeError(403, 'OPENAI_ACCESS_DENIED', 'OpenAI 키의 모델 사용 권한을 확인해 주세요.');
  if (status === 429) return safeError(429, 'OPENAI_RATE_LIMITED', 'OpenAI 사용 한도·잔액 또는 요청 한도를 확인해 주세요. 자동 재시도는 하지 않았어요.');
  if (status === 400 || status === 404) return safeError(502, 'OPENAI_CONFIGURATION_ERROR', 'OpenAI 모델이나 요청 설정을 사용할 수 없어요. 설정의 모델과 입력 자료를 확인해 주세요.');
  return safeError(502, 'OPENAI_UNAVAILABLE', 'OpenAI 서비스가 응답하지 않아요. 기존 자료와 결과는 유지돼요.');
}
function appInput(options, limit) {
  if (typeof options.body !== 'string' || new TextEncoder().encode(options.body).byteLength > limit) throw invalid('요청 자료의 형식이나 크기를 확인해 주세요.');
  try {const value = JSON.parse(options.body);if (!plain(value)) throw invalid('요청 형식을 확인해 주세요.');return value;}
  catch (error) {if (error instanceof DirectOpenAiError) throw error;throw invalid('요청 내용을 읽지 못했어요.');}
}

export function handlesDirectPath(path) {return ROUTES.has(path);}

/** A personal API key stays in this module's memory unless the user opts in to tab-session retention. */
export function createDirectOpenAi({fetchImpl = (...args) => globalThis.fetch(...args), sessionStorage = browserStorage(),
  dispatchChange = emitSettingsChange, timeoutMs = 180000, checkTimeoutMs = 15000} = {}) {
  let settings = {...DEFAULTS}, activeController = null, generation = 0;
  try {
    const saved = sessionStorage?.getItem(SESSION_KEY);
    if (saved) {
      const value = JSON.parse(saved);
      if (!plain(value) || value.rememberForTab !== true) throw new Error('invalid');
      settings = normalizeSettings(value);
    }
  } catch {try {sessionStorage?.removeItem(SESSION_KEY);} catch {}}
  function getDirectSettings() {return metadata(settings);}
  function save(next) {
    try {
      if (next.rememberForTab) {
        if (!sessionStorage) throw new Error('unavailable');
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      } else {sessionStorage?.removeItem(SESSION_KEY);}
    } catch {throw safeError(400, 'OPENAI_SETTINGS_STORAGE', '이 탭에 API 설정을 저장하지 못했어요. ‘이 탭에서 키 기억’을 끄거나 브라우저 저장 공간을 확인해 주세요.');}
    activeController?.abort();settings = next;dispatchChange();return metadata(settings);
  }
  function setDirectSettings(value) {return save(normalizeSettings(value, settings));}
  function setDirectEnabled(enabled) {
    if (typeof enabled === 'boolean' && enabled === settings.enabled) return metadata(settings);
    return setDirectSettings({enabled});
  }
  function clearDirectSettings() {return save({...DEFAULTS});}
  async function requestProvider(endpoint, {key, body, signal, timeout = timeoutMs}) {
    const controller = new AbortController();let timedOut = false;
    const forward = () => controller.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', forward, {once: true});
    const timer = setTimeout(() => {timedOut = true;controller.abort();}, timeout);
    let rejectAbort;
    const aborted = new Promise((_, reject) => {rejectAbort = () => reject(abortError());controller.signal.addEventListener('abort', rejectAbort, {once: true});});
    try {
      const headers = new Headers({Authorization: `Bearer ${key}`});
      if (typeof body === 'string') headers.set('Content-Type', 'application/json');
      const pending = Promise.resolve().then(() => fetchImpl(`https://api.openai.com/v1/${endpoint}`, {method: body === undefined ? 'GET' : 'POST',
        headers, body, signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer'}));
      const response = await Promise.race([pending, aborted]);
      if (!response || typeof response.status !== 'number') throw safeError(502, 'INVALID_OPENAI_RESPONSE', 'OpenAI 응답을 읽지 못했어요.');
      if (!response.ok) {response.body?.cancel?.().catch?.(() => {});throw providerError(response.status);}
      const length = Number(response.headers.get('Content-Length'));
      if (length > MAX_RESPONSE_BYTES) throw safeError(502, 'OPENAI_RESPONSE_TOO_LARGE', 'OpenAI 응답이 너무 커요. 분량이나 이미지 품질을 낮춰 주세요.');
      let text;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];let size = 0;
        try {
          for (;;) {
            const value = await Promise.race([reader.read(), aborted]);if (value.done) break;
            size += value.value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {reader.cancel().catch(() => {});throw safeError(502, 'OPENAI_RESPONSE_TOO_LARGE', 'OpenAI 응답이 너무 커요. 분량이나 이미지 품질을 낮춰 주세요.');}
            chunks.push(value.value);
          }
          const bytes = new Uint8Array(size);let offset = 0;
          for (const chunk of chunks) {bytes.set(chunk, offset);offset += chunk.byteLength;}
          text = new TextDecoder().decode(bytes);
        } finally {reader.releaseLock();}
      } else {text = await Promise.race([response.text(), aborted]);if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw safeError(502, 'OPENAI_RESPONSE_TOO_LARGE', 'OpenAI 응답이 너무 커요.');}
      try {return JSON.parse(text);} catch {throw safeError(502, 'INVALID_OPENAI_RESPONSE', 'OpenAI 응답 형식을 읽지 못했어요. 기존 결과는 유지돼요.');}
    } catch (error) {
      if (timedOut) throw safeError(504, 'OPENAI_TIMEOUT', 'OpenAI 요청 시간이 오래 걸려 취소했어요. 분량이나 이미지 품질을 낮춰 다시 시도해 주세요.');
      if (signal?.aborted || controller.signal.aborted || error?.name === 'AbortError') throw abortError();
      if (error instanceof DirectOpenAiError) throw error;
      throw safeError(502, 'OPENAI_CONNECTION_FAILED', 'OpenAI에 연결하지 못했어요. 네트워크 또는 브라우저 연결 제한을 확인해 주세요.');
    } finally {
      clearTimeout(timer);signal?.removeEventListener('abort', forward);controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
  async function checkDirectKey(apiKey, {signal} = {}) {
    const key = apiKey === undefined || apiKey === '' ? settings.apiKey : validateKey(apiKey);
    if (!key) throw invalid('OpenAI API 키를 먼저 입력해 주세요.');
    try {await requestProvider('models', {key, signal, timeout: checkTimeoutMs});return {verified: true};}
    catch (error) {
      if (error instanceof DirectOpenAiError && error.status === 403) return {verified: false, limited: true,
        message: '모델 목록 조회 권한이 없어 연결을 확인하지 못했어요. API 키를 저장한 뒤 해당 모델의 실행 권한을 확인할 수 있어요.'};
      throw error;
    }
  }
  async function directApiFetch(path, options = {}) {
    if (!handlesDirectPath(path)) throw invalid('지원하지 않는 OpenAI 기능 요청입니다.');
    const headers = new Headers(options.headers);
    if (headers.has('Authorization') || headers.has('Proxy-Authorization')) throw invalid('OpenAI 인증은 설정에 입력한 API 키만 사용할 수 있어요.');
    if (options.signal?.aborted) throw abortError();
    const method = (options.method || 'GET').toUpperCase(), configured = Boolean(settings.enabled && settings.apiKey);
    if (path.endsWith('/config')) {
      if (!['GET', 'HEAD'].includes(method)) return jsonResponse(405, {error: 'GET 요청을 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});
      const body = path === SCRIPT_CONFIG ? {configured, minMinutes: 1, maxMinutes: 60, formats: ['txt', 'md', 'pdf', 'docx'], maxFileBytes: 10485760, maxInputCharacters: 100000}
        : path === IMAGE_CONFIG ? {configured, maxReferences: 5, maxReferenceBytes: MAX_REFERENCE_BYTES, maxTotalReferenceBytes: MAX_REFERENCES_BYTES, sizes: SIZES, qualities: QUALITIES}
        : {configured, model: settings.transcribeModel, maxChunkSeconds: 300, maxAudioBytes: 9600044, languages: ['ko', 'en', 'auto'], reason: configured ? '' : '설정에서 OpenAI API 키를 입력해 주세요.'};
      return jsonResponse(200, body, method === 'HEAD');
    }
    if (method !== 'POST') return jsonResponse(405, {error: 'POST 요청을 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});
    if (!configured) return jsonResponse(503, {error: '설정에서 OpenAI API 키를 입력해 주세요.', code: 'NOT_CONFIGURED'});
    if (activeController) return jsonResponse(429, {error: '다른 AI 작업이 진행 중이에요. 완료하거나 취소한 뒤 다시 시도해 주세요.', code: 'OPENAI_BUSY'});
    const controller = new AbortController(), sequence = ++generation, current = {...settings};
    const forward = () => controller.abort();options.signal?.addEventListener('abort', forward, {once: true});activeController = controller;
    try {
      let result;
      if (path === SCRIPT_GENERATE) {
        const input = validateScriptRequest(appInput(options, 512 * 1024));
        const response = await requestProvider('responses', {key: current.apiKey, body: JSON.stringify(buildScriptRequest(input, current.scriptModel)), signal: controller.signal});
        result = parseScriptResponse(response, input);
      } else if (path === IMAGE_GENERATE) {
        const input = imageSettings(appInput(options, 30 * 1024 * 1024)), {body, promptUsed} = imageRequest(input, current.imageModel);
        const response = await requestProvider('images/edits', {key: current.apiKey, body, signal: controller.signal});
        result = parseImage(response, input, promptUsed);
      } else {
        const {settings: input, body} = buildDirectTranscriptRequest(appInput(options, 14 * 1024 * 1024), current.transcribeModel);
        const response = await requestProvider('audio/transcriptions', {key: current.apiKey, body, signal: controller.signal});
        result = parseTranscriptResponse(response, input, current.transcribeModel);
      }
      if (controller.signal.aborted) throw abortError();
      return jsonResponse(200, result);
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') throw abortError();
      const safe = error instanceof DirectOpenAiError || (Number.isInteger(error?.status) && typeof error?.code === 'string');
      return jsonResponse(safe ? error.status : 502, {error: safe ? error.message : 'OpenAI 작업을 마치지 못했어요. 기존 자료와 결과는 유지돼요.', code: safe ? error.code : 'OPENAI_FAILED'});
    } finally {
      options.signal?.removeEventListener('abort', forward);if (sequence === generation) activeController = null;
    }
  }
  return {getDirectSettings, setDirectSettings, clearDirectSettings, setDirectEnabled, checkDirectKey, directApiFetch};
}

const client = createDirectOpenAi();
export const getDirectSettings = () => client.getDirectSettings();
export const setDirectSettings = value => client.setDirectSettings(value);
export const clearDirectSettings = () => client.clearDirectSettings();
export const setDirectEnabled = value => client.setDirectEnabled(value);
export const checkDirectKey = (key, options) => client.checkDirectKey(key, options);
export const directApiFetch = (path, options) => client.directApiFetch(path, options);
