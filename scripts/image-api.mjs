import {buildImagePrompt} from '../dist/image-prompt.js';
export {buildImagePrompt} from '../dist/image-prompt.js';
import http from 'node:http';
import https from 'node:https';
import {randomBytes} from 'node:crypto';

const MAX_REFERENCES = 5;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_REFERENCE_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const JSON_LIMIT = 30 * 1024 * 1024;
const RESPONSE_LIMIT = 30 * 1024 * 1024;
const ENDPOINT = 'https://api.openai.com/v1/images/edits';
const SIZES = ['1536x864', '864x1536', '1024x1024'];
const QUALITIES = ['low', 'medium', 'high'];
const ROLES = ['concept', 'background', 'character', 'style', 'other'];
const MIME_EXTENSIONS = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'};

class ImageApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = message => new ImageApiError(400, 'INVALID_INPUT', message);

function textField(value, fallback, max, label) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || Array.from(value).length > max) throw invalid(`${label} 형식이나 길이를 확인해 주세요.`);
  return value.replace(/\u0000/g, '').trim();
}

function canonicalBase64(value, maxBytes, code = 'INVALID_IMAGE') {
  if (typeof value === 'string' && value.length > Math.ceil(maxBytes / 3) * 4) {
    throw new ImageApiError(code === 'INVALID_AI_IMAGE' ? 502 : 413, code === 'INVALID_AI_IMAGE' ? code : 'IMAGE_TOO_LARGE', '이미지 데이터가 너무 큽니다. 크기를 줄여 다시 시도해 주세요.');
  }
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ImageApiError(code === 'INVALID_AI_IMAGE' ? 502 : 400, code, '이미지 데이터를 읽지 못했습니다. 올바른 PNG·JPG·WebP 파일로 다시 시도해 주세요.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) throw new ImageApiError(code === 'INVALID_AI_IMAGE' ? 502 : 413, code === 'INVALID_AI_IMAGE' ? code : 'IMAGE_TOO_LARGE', '이미지 데이터가 너무 큽니다. 크기를 줄여 다시 시도해 주세요.');
  if (!bytes.length || bytes.toString('base64') !== value) {
    throw new ImageApiError(code === 'INVALID_AI_IMAGE' ? 502 : 400, code, '이미지 데이터의 크기나 형식이 올바르지 않습니다.');
  }
  return bytes;
}

function boundedDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= 16384 && height <= 16384 && width * height <= 40_000_000;
}

function pngImage(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let position = 8, chunks = 0, pixels = false;
  while (position + 12 <= bytes.length && ++chunks <= 10000) {
    const length = bytes.readUInt32BE(position), type = bytes.toString('ascii', position + 4, position + 8);
    if (position + 12 + length > bytes.length) return false;
    if (position === 8 && (type !== 'IHDR' || length !== 13 || !boundedDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20)))) return false;
    if (type === 'IDAT' && length) pixels = true;
    if (type === 'IEND') return length === 0 && pixels && position + 12 === bytes.length;
    position += length + 12;
  }
  return false;
}

function jpegImage(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes.at(-1) !== 0xd9) return false;
  let offset = 2, segments = 0, dimensions = false;
  while (offset + 1 < bytes.length && ++segments <= 10000) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) return dimensions && offset + 2 < bytes.length;
    if (marker === 0xd9) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || !boundedDimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return false;
      dimensions = true;
    }
    offset += length;
  }
  return false;
}

function webpImage(bytes) {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12, chunks = 0, dimensions = false, pixels = false;
  while (offset + 8 <= bytes.length && ++chunks <= 10000) {
    const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), from = offset + 8;
    if (from + size > bytes.length) return false;
    if (type === 'VP8X') {
      if (size < 10 || !boundedDimensions(1 + bytes.readUIntLE(from + 4, 3), 1 + bytes.readUIntLE(from + 7, 3))) return false;
      dimensions = true;
    } else if (type === 'VP8 ') {
      if (size < 10 || !bytes.subarray(from + 3, from + 6).equals(Buffer.from([0x9d, 0x01, 0x2a])) ||
          !boundedDimensions(bytes.readUInt16LE(from + 6) & 0x3fff, bytes.readUInt16LE(from + 8) & 0x3fff)) return false;
      dimensions = true; pixels = true;
    } else if (type === 'VP8L') {
      if (size < 5 || bytes[from] !== 0x2f) return false;
      const width = 1 + bytes[from + 1] + ((bytes[from + 2] & 0x3f) << 8);
      const height = 1 + (bytes[from + 2] >> 6) + (bytes[from + 3] << 2) + ((bytes[from + 4] & 0x0f) << 10);
      if (!boundedDimensions(width, height)) return false;
      dimensions = true; pixels = true;
    }
    offset = from + size + (size % 2);
  }
  return offset === bytes.length && dimensions && pixels;
}

function isImage(bytes, mimeType) {
  return mimeType === 'image/png' ? pngImage(bytes) : mimeType === 'image/jpeg' ? jpegImage(bytes) : mimeType === 'image/webp' ? webpImage(bytes) : false;
}

export function validateImageRequest(input) {
  if (!plainObject(input)) throw invalid('이미지 생성 요청 형식을 확인해 주세요.');
  const fields = new Set(['prompt', 'background', 'style', 'negativePrompt', 'size', 'quality', 'references']);
  if (Object.keys(input).some(key => !fields.has(key))) throw invalid('지원하지 않는 이미지 생성 설정입니다.');
  const prompt = textField(input.prompt, undefined, 10000, '장면 요청');
  if (!prompt) throw invalid('생성할 장면의 내용을 입력해 주세요.');
  const size = input.size ?? '1536x864', quality = input.quality ?? 'medium';
  if (!SIZES.includes(size)) throw invalid('가로·세로·정사각형 중 출력 크기를 선택해 주세요.');
  if (!QUALITIES.includes(quality)) throw invalid('지원하는 이미지 품질을 선택해 주세요.');
  if (!Array.isArray(input.references) || input.references.length < 1 || input.references.length > MAX_REFERENCES) {
    throw invalid('기준으로 사용할 레퍼런스 이미지를 1~5장 선택해 주세요.');
  }
  let total = 0;
  const references = input.references.map((reference, index) => {
    if (!plainObject(reference) || Object.keys(reference).some(key => !['label', 'role', 'mimeType', 'data'].includes(key))) throw invalid('레퍼런스 이미지 정보를 확인해 주세요.');
    const label = textField(reference.label, `참조 이미지 ${index + 1}`, 120, '레퍼런스 이름').replace(/[\u0000-\u001f\u007f]/g, ' ');
    const role = reference.role ?? 'concept', mimeType = reference.mimeType;
    if (!ROLES.includes(role)) throw invalid('레퍼런스의 역할을 확인해 주세요.');
    if (!Object.hasOwn(MIME_EXTENSIONS, mimeType)) throw invalid('레퍼런스에는 PNG·JPG·WebP 이미지를 사용해 주세요.');
    if (typeof reference.data === 'string' && reference.data.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4) {
      throw new ImageApiError(413, 'IMAGE_TOO_LARGE', '레퍼런스 이미지 한 장은 10MB 이하로 줄여 주세요.');
    }
    const bytes = canonicalBase64(reference.data, MAX_REFERENCE_BYTES);
    total += bytes.length;
    if (total > MAX_TOTAL_REFERENCE_BYTES) throw new ImageApiError(413, 'REFERENCES_TOO_LARGE', '전송할 레퍼런스 이미지 합계는 20MB 이하로 줄여 주세요.');
    if (!isImage(bytes, mimeType)) throw invalid('레퍼런스의 실제 이미지 형식이 올바르지 않습니다. PNG·JPG·WebP로 다시 저장해 주세요.');
    return {label: label || `참조 이미지 ${index + 1}`, role, mimeType, bytes};
  });
  // Stable ordering makes the first main-concept image the provider's first input.
  references.sort((left, right) => Number(right.role === 'concept') - Number(left.role === 'concept'));
  return {prompt, size, quality, references,
    background: textField(input.background, '', 20000, '배경 설정'),
    style: textField(input.style, '', 4000, '화풍 설정'),
    negativePrompt: textField(input.negativePrompt, '', 2000, '피할 요소')};
}


function modelName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value) || ['gpt-image-1', 'dall-e-2', 'dall-e-3'].includes(value)) {
    throw new ImageApiError(503, 'INVALID_IMAGE_MODEL', '서버의 이미지 생성 모델 설정을 확인해 주세요.');
  }
  return value;
}

/** Actual reference bytes are multipart uploads; labels alone are never substituted. */
export function buildImageMultipart(settings, model = 'gpt-image-2') {
  model = modelName(model);
  if (['gpt-image-1.5', 'gpt-image-1-mini'].includes(model) && settings.size !== '1024x1024') {
    throw new ImageApiError(503, 'IMAGE_MODEL_SIZE_UNSUPPORTED', '설정된 이미지 모델은 이 화면 비율을 지원하지 않습니다. 정사각형을 선택하거나 서버 모델 설정을 확인해 주세요.');
  }
  const boundary = `----ImageStudio${randomBytes(16).toString('hex')}`;
  const buffers = [];
  const part = (name, value) => buffers.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  const promptUsed = buildImagePrompt(settings);
  part('model', model);part('prompt', promptUsed);part('size', settings.size);part('quality', settings.quality);
  part('n', '1');part('output_format', 'png');
  if (model === 'gpt-image-1.5') part('input_fidelity', 'high');
  if (model === 'gpt-image-1-mini') part('input_fidelity', 'low');
  for (const [index, reference] of settings.references.entries()) {
    const filename = `reference-${String(index + 1).padStart(2, '0')}.${MIME_EXTENSIONS[reference.mimeType]}`;
    buffers.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="${filename}"\r\nContent-Type: ${reference.mimeType}\r\n\r\n`), reference.bytes, Buffer.from('\r\n'));
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`));
  return {body: Buffer.concat(buffers), contentType: `multipart/form-data; boundary=${boundary}`, promptUsed, referenceCount: settings.references.length};
}

export function parseImageResponse(response, settings, promptUsed, now = new Date()) {
  const value = plainObject(response) && Array.isArray(response.data) && response.data.length === 1 ? response.data[0] : null;
  if (!plainObject(value) || typeof value.b64_json !== 'string') throw new ImageApiError(502, 'INVALID_AI_IMAGE', '생성된 이미지 파일을 받지 못했습니다. 기존 레퍼런스와 장면은 유지됩니다.');
  const bytes = canonicalBase64(value.b64_json, MAX_OUTPUT_BYTES, 'INVALID_AI_IMAGE');
  if (!pngImage(bytes)) throw new ImageApiError(502, 'INVALID_AI_IMAGE', '생성 결과가 올바른 PNG 이미지가 아닙니다. 기존 레퍼런스와 장면은 유지됩니다.');
  return {image: {mimeType: 'image/png', data: value.b64_json, name: `reference-scene-${now.getTime()}.png`},
    promptUsed, referenceCount: settings.references.length, size: settings.size, quality: settings.quality, generatedAt: now.toISOString()};
}

function providerError(status) {
  if (status === 401) return new ImageApiError(502, 'IMAGE_AUTH_FAILED', '이미지 생성 서비스의 인증을 확인해 주세요. 서버의 API 키 설정이 필요합니다.');
  if (status === 403) return new ImageApiError(502, 'IMAGE_ACCESS_DENIED', '이미지 모델 접근이 차단되었습니다. 서버의 모델 권한과 네트워크 설정을 확인해 주세요.');
  if (status === 429) return new ImageApiError(429, 'IMAGE_RATE_LIMITED', '이미지 생성 사용량 또는 요청 한도에 도달했습니다. 잠시 후 다시 시도하거나 사용량을 확인해 주세요.');
  if (status === 400 || status === 404) return new ImageApiError(502, 'IMAGE_CONFIGURATION_ERROR', '이미지 모델이 요청을 처리하지 못했습니다. 참조 파일과 서버 모델 설정을 확인해 주세요.');
  return new ImageApiError(502, 'IMAGE_SERVICE_UNAVAILABLE', '이미지 생성 서비스가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.');
}

export function createImageProviderRequest(env = process.env, requestImpl = https.request) {
  let proxyConfigured = false;
  return ({payload, key, signal}) => {
    if (!proxyConfigured) {
      const hasProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
      if (hasProxy && typeof http.setGlobalProxyFromEnv !== 'function') throw new ImageApiError(503, 'PROXY_RUNTIME_REQUIRED', '현재 프록시 환경에서는 Node.js 24.5 이상으로 서버를 실행해 주세요.');
      if (hasProxy) http.setGlobalProxyFromEnv(env);
      proxyConfigured = true;
    }
    return new Promise((resolve, reject) => {
      const request = requestImpl(ENDPOINT, {method: 'POST', signal, headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': payload.contentType, 'Content-Length': payload.body.length,
      }}, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {response.resume();reject(providerError(response.statusCode));return;}
        const chunks = [];let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > RESPONSE_LIMIT) {chunks.length = 0;request.destroy(new ImageApiError(502, 'IMAGE_RESPONSE_TOO_LARGE', '이미지 응답이 너무 큽니다. 크기나 품질을 줄여 다시 시도해 주세요.'));return;}
          chunks.push(chunk);
        });
        response.on('error', reject);response.on('aborted', () => reject(new Error('Image response interrupted')));
        response.on('end', () => {
          try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
          catch {reject(new ImageApiError(502, 'INVALID_AI_IMAGE', '이미지 생성 응답을 읽지 못했습니다. 다시 시도해 주세요.'));}
        });
      });
      request.on('error', reject);request.end(payload.body);
    });
  };
}

function send(res, status, data, head = false) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(head ? undefined : body);
}

function sameOrigin(req) {
  if (req.studioAuthenticated === true) return true;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  try {const origin = new URL(req.headers.origin);return ['http:', 'https:'].includes(origin.protocol) && origin.host.toLowerCase() === String(req.headers.host || '').toLowerCase();}
  catch {return false;}
}

function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {req.resume();throw new ImageApiError(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해 주세요.');}
  if (Number(req.headers['content-length']) > JSON_LIMIT) {req.resume();throw new ImageApiError(413, 'TOO_LARGE', '참조 이미지와 입력 내용이 너무 큽니다. 이미지 크기를 줄여 주세요.');}
  return new Promise((resolve, reject) => {
    let size = 0, done = false;const chunks = [];
    const fail = error => {if (!done) {done = true;chunks.length = 0;reject(error);}};
    req.on('data', chunk => {
      if (done) return;size += chunk.length;
      if (size > JSON_LIMIT) {fail(new ImageApiError(413, 'TOO_LARGE', '참조 이미지와 입력 내용이 너무 큽니다. 이미지 크기를 줄여 주세요.'));return;}
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;done = true;
      try {const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));if (!plainObject(input)) throw invalid('요청 형식을 확인해 주세요.');resolve(input);}
      catch (error) {reject(error instanceof ImageApiError ? error : invalid('요청 내용을 읽지 못했습니다. 다시 시도해 주세요.'));}
    });
    req.on('aborted', () => fail(new ImageApiError(499, 'CANCELLED', '이미지 생성 요청을 취소했습니다.')));
    req.on('error', () => fail(invalid('이미지 요청 자료를 받지 못했습니다.')));
  });
}

function withAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const pending = Promise.resolve(promise);pending.catch(() => {});
    const aborted = () => reject(new Error('Image generation aborted'));
    if (signal.aborted) {aborted();return;}
    signal.addEventListener('abort', aborted, {once: true});
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Same-origin, single-image generation, with no credential or paid-retry path in the browser. */
export function createImageApi({env = process.env, requestProvider = createImageProviderRequest(env), timeoutMs = 180_000} = {}) {
  let generating = false;
  const apiKey = () => env.IMAGE_AI_API_KEY || env.SCRIPT_AI_API_KEY || env.OPENAI_API_KEY || '';
  return async function handleImageApi(req, res, pathname) {
    if (!pathname.startsWith('/api/image/')) return false;
    if (pathname === '/api/image/config' && ['GET', 'HEAD'].includes(req.method)) {
      send(res, 200, {configured: Boolean(apiKey()), maxReferences: MAX_REFERENCES, maxReferenceBytes: MAX_REFERENCE_BYTES,
        maxTotalReferenceBytes: MAX_TOTAL_REFERENCE_BYTES, sizes: SIZES, qualities: QUALITIES}, req.method === 'HEAD');return true;
    }
    if (pathname !== '/api/image/generate') {req.resume();send(res, 404, {error: '요청한 이미지 기능을 찾지 못했습니다.', code: 'NOT_FOUND'});return true;}
    if (req.method !== 'POST') {req.resume();res.setHeader('Allow', 'POST');send(res, 405, {error: 'POST 요청으로 사용해 주세요.', code: 'METHOD_NOT_ALLOWED'});return true;}
    if (!sameOrigin(req)) {req.resume();send(res, 403, {error: '편집기와 같은 주소에서 요청해 주세요.', code: 'ORIGIN_NOT_ALLOWED'});return true;}
    let controller, timer, clientClosed, ownsSlot = false, timedOut = false;
    try {
      const settings = validateImageRequest(await readJson(req));
      if (!apiKey()) throw new ImageApiError(503, 'NOT_CONFIGURED', '이미지 생성 서비스가 아직 연결되지 않았습니다. 서버의 API 키 설정이 필요합니다.');
      if (generating) throw new ImageApiError(429, 'IMAGE_GENERATION_BUSY', '다른 이미지가 생성 중입니다. 완료하거나 취소한 뒤 다시 시도해 주세요.');
      const model = modelName(env.IMAGE_AI_MODEL || 'gpt-image-2');
      const payload = buildImageMultipart(settings, model);
      generating = true;ownsSlot = true;controller = new AbortController();
      clientClosed = () => {if (!res.writableEnded) controller.abort();};res.on('close', clientClosed);
      timer = setTimeout(() => {timedOut = true;controller.abort();}, timeoutMs);
      const response = await withAbort(requestProvider({payload, key: apiKey(), signal: controller.signal}), controller.signal);
      if (controller.signal.aborted) throw new Error('Image generation aborted');
      send(res, 200, parseImageResponse(response, settings, payload.promptUsed));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return true;
      if (timedOut || controller?.signal.aborted) send(res, 504, {error: '이미지 생성이 오래 걸리고 있습니다. 크기나 품질을 줄여 다시 시도해 주세요.', code: 'IMAGE_GENERATION_TIMEOUT'});
      else if (error instanceof ImageApiError) send(res, error.status, {error: error.message, code: error.code});
      else send(res, 502, {error: '이미지 생성 서비스에 연결하지 못했습니다. 서버의 네트워크와 연결 설정을 확인해 주세요.', code: 'IMAGE_CONNECTION_FAILED'});
    } finally {
      if (ownsSlot) generating = false;
      clearTimeout(timer);if (clientClosed) res.off('close', clientClosed);
    }
    return true;
  };
}
