/** BLKOUT Image Studio: project model, captions, and local storage. */

export const SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 250 * 1024 * 1024;
export const MAX_ASSET_BYTES = 180 * 1024 * 1024;
const DB_NAME = 'bth-blkout-image-studio';
const DB_VERSION = 1;
const MOTIONS = new Set(['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'none']);
const FITS = new Set(['cover', 'contain']);
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,180}$/;
const encoder = new TextEncoder();

export function createId(prefix = 'id') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

export function createScene(overrides = {}) {
  return {
    id: createId('scene'),
    duration: 6,
    caption: '',
    imageId: null,
    motion: 'zoom-in',
    fit: 'cover',
    ...overrides,
  };
}

export function createProject(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: createId('episode'),
    title: 'BLKOUT 설정 이야기',
    aspect: '16:9',
    scenes: [],
    captions: [],
    captionMode: 'auto',
    ...overrides,
    settings: {
      transition: 0.4,
      subtitles: true,
      branding: true,
      fontSize: 48,
      bgmVolume: 0.12,
      narrationVolume: 1,
      ...(overrides.settings || {}),
    },
    audio: {narrationId: null, bgmId: null, ...(overrides.audio || {})},
  };
}

function fail(message) { throw new Error(message); }
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function textValue(value, fallback, max, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) fail(`${label} 형식이나 길이를 확인해 주세요.`);
  return value.replace(/\u0000/g, '');
}
function finiteNumber(value, fallback, min, max, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${label} 값은 ${min}~${max} 범위여야 합니다.`);
  }
  return value;
}
function validId(value, nullable, label) {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(`${label} 식별자가 올바르지 않습니다.`);
  return value;
}

/** Canonical validation also prevents imported data from changing arbitrary settings. */
export function validateProject(input) {
  if (!plainObject(input)) fail('프로젝트 파일 형식이 올바르지 않습니다.');
  if (input.schemaVersion !== SCHEMA_VERSION) fail('이 버전의 프로젝트 파일은 지원하지 않습니다.');
  if (!Array.isArray(input.scenes) || input.scenes.length > 200) fail('장면은 최대 200개까지 저장할 수 있습니다.');
  if (!['16:9', '9:16'].includes(input.aspect)) fail('지원하지 않는 화면 비율입니다.');
  const ids = new Set();
  const scenes = input.scenes.map((scene, index) => {
    if (!plainObject(scene)) fail(`${index + 1}번 장면 형식이 올바르지 않습니다.`);
    const id = validId(scene.id, false, '장면');
    if (ids.has(id)) fail('중복된 장면 식별자가 있습니다.');
    ids.add(id);
    if (!MOTIONS.has(scene.motion ?? 'zoom-in')) fail('지원하지 않는 화면 움직임입니다.');
    if (!FITS.has(scene.fit ?? 'cover')) fail('지원하지 않는 이미지 맞춤 방식입니다.');
    return {
      id,
      duration: finiteNumber(scene.duration, 6, 0.25, 600, '장면 길이'),
      caption: textValue(scene.caption, '', 20000, '장면 대본'),
      imageId: validId(scene.imageId, true, '이미지'),
      motion: scene.motion ?? 'zoom-in',
      fit: scene.fit ?? 'cover',
    };
  });
  if (scenes.reduce((sum, scene) => sum + scene.duration, 0) > 3600.001) fail('한 프로젝트의 길이는 최대 60분입니다.');
  const settings = input.settings || {};
  if (!plainObject(settings)) fail('프로젝트 설정 형식이 올바르지 않습니다.');
  const audio = input.audio || {};
  if (!plainObject(audio)) fail('음성 설정 형식이 올바르지 않습니다.');
  const captions = input.captions || [];
  if (!Array.isArray(captions) || captions.length > 10000) fail('자막은 최대 10,000개까지 사용할 수 있습니다.');
  let previousStart = -1;
  const canonicalCaptions = captions.map((cue, index) => {
    if (!plainObject(cue)) fail(`${index + 1}번 자막 형식이 올바르지 않습니다.`);
    const start = finiteNumber(cue.start, undefined, 0, 86400, '자막 시작 시각');
    const end = finiteNumber(cue.end, undefined, 0, 86400, '자막 종료 시각');
    if (start === undefined || end === undefined || end <= start) fail(`${index + 1}번 자막의 시간이 올바르지 않습니다.`);
    if (start < previousStart) fail('자막을 시작 시각 순서대로 정렬해 주세요.');
    previousStart = start;
    const text = textValue(cue.text, '', 10000, '자막');
    return {start, end, text};
  });
  if (!['auto', 'srt'].includes(input.captionMode ?? 'auto')) fail('지원하지 않는 자막 모드입니다.');
  return {
    schemaVersion: SCHEMA_VERSION,
    id: validId(input.id, false, '프로젝트'),
    title: textValue(input.title, 'BLKOUT 설정 이야기', 200, '제목'),
    aspect: input.aspect,
    scenes,
    captions: canonicalCaptions,
    captionMode: input.captionMode ?? 'auto',
    settings: {
      transition: finiteNumber(settings.transition, 0.4, 0, 3, '전환 시간'),
      subtitles: settings.subtitles !== false,
      branding: settings.branding !== false,
      fontSize: finiteNumber(settings.fontSize, 48, 20, 100, '자막 크기'),
      bgmVolume: finiteNumber(settings.bgmVolume, 0.12, 0, 1, '배경음악 볼륨'),
      narrationVolume: finiteNumber(settings.narrationVolume, 1, 0, 2, '내레이션 볼륨'),
    },
    audio: {
      narrationId: validId(audio.narrationId, true, '내레이션'),
      bgmId: validId(audio.bgmId, true, '배경음악'),
    },
  };
}

const charLength = text => Array.from(text).length;

function splitLongText(value, maxChars) {
  const chunks = [];
  let line = '';
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const joined = line ? `${line} ${word}` : word;
    if (charLength(joined) <= maxChars) { line = joined; continue; }
    if (line) { chunks.push(line); line = ''; }
    const chars = Array.from(word);
    while (chars.length > maxChars) chunks.push(chars.splice(0, maxChars).join(''));
    line = chars.join('');
  }
  if (line) chunks.push(line);
  return chunks;
}

/** Paragraphs and explicit line breaks are preserved as scene boundaries. */
export function splitScript(text, {maxChars = 90} = {}) {
  if (typeof text !== 'string') return [];
  maxChars = Math.max(12, Math.min(1000, Math.floor(maxChars)));
  const result = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split(/\n+/)) {
    const cleaned = paragraph.trim().replace(/[\t ]+/g, ' ');
    if (!cleaned) continue;
    if (charLength(cleaned) <= maxChars) { result.push(cleaned); continue; }
    const sentences = cleaned.split(/(?<=[.!?。！？])\s+/);
    let current = '';
    for (const sentence of sentences) {
      if (charLength(sentence) > maxChars) {
        if (current) { result.push(current); current = ''; }
        const pieces = splitLongText(sentence, maxChars);
        result.push(...pieces.slice(0, -1));
        current = pieces.at(-1) || '';
      } else if (!current || charLength(`${current} ${sentence}`) <= maxChars) {
        current = current ? `${current} ${sentence}` : sentence;
      } else {
        result.push(current);
        current = sentence;
      }
    }
    if (current) result.push(current);
  }
  return result;
}

function readingWeight(text) {
  const clean = String(text || '').trim();
  if (!clean) return 1;
  const chars = charLength(clean.replace(/\s+/g, ''));
  const pauses = (clean.match(/[.!?。！？,，:;…]/g) || []).length * 1.8;
  return Math.max(1, chars + pauses);
}

/** Estimate by text weight, not speech recognition. Keeps exact total duration. */
export function distributeDurations(scenes, totalSeconds, {minDuration = 0.5} = {}) {
  if (!Array.isArray(scenes) || scenes.length === 0) return [];
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) fail('음성 길이를 확인해 주세요.');
  if (totalSeconds > 3600) fail('자동 배분은 최대 60분까지 지원합니다.');
  if (totalSeconds < scenes.length * 0.25) fail('음성에 비해 장면이 너무 많습니다. 장면 수를 줄여 주세요.');
  if (totalSeconds > scenes.length * 600) fail('장면 하나는 최대 10분입니다. 장면을 추가한 뒤 다시 배분해 주세요.');
  const floor = Math.max(0.25, Math.min(Number(minDuration) || 0.5, totalSeconds / scenes.length));
  const weights = scenes.map(scene => readingWeight(scene.caption));
  const durations = scenes.map(() => floor);
  let remaining = Math.max(0, totalSeconds - floor * scenes.length);
  let active = scenes.map((_, index) => index);
  while (active.length && remaining > 1e-10) {
    const totalWeight = active.reduce((sum, index) => sum + weights[index], 0);
    const capped = active.filter(index => durations[index] + remaining * weights[index] / totalWeight > 600);
    if (!capped.length) {
      for (const index of active) durations[index] += remaining * weights[index] / totalWeight;
      remaining = 0;
    } else {
      for (const index of capped) {
        remaining -= 600 - durations[index];
        durations[index] = 600;
      }
      const cappedSet = new Set(capped);
      active = active.filter(index => !cappedSet.has(index));
    }
  }
  let allocated = 0;
  return scenes.map((scene, index) => {
    const duration = index === scenes.length - 1
      ? totalSeconds - allocated
      : Math.round(durations[index] * 1000000) / 1000000;
    allocated += duration;
    return {...scene, duration};
  });
}

export function getTimeline(project) {
  let duration = 0;
  const scenes = (project?.scenes || []).map((scene, index) => {
    const start = duration;
    duration += Math.max(0, Number(scene.duration) || 0);
    return {...scene, index, start, end: duration};
  });
  return {scenes, duration};
}

/** Imported SRT timing is retained; automatic mode is text-weight estimated. */
export function getCaptions(project) {
  if (project?.captionMode === 'srt') return (project.captions || []).map(cue => ({...cue}));
  const cues = [];
  for (const scene of getTimeline(project).scenes) {
    const pieces = splitScript(scene.caption || '', {maxChars: project.aspect === '9:16' ? 28 : 48});
    if (pieces.length === 0 || scene.duration <= 0) continue;
    const weights = pieces.map(readingWeight);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let start = scene.start;
    for (let index = 0; index < pieces.length; index++) {
      const end = index === pieces.length - 1 ? scene.end : start + scene.duration * weights[index] / totalWeight;
      cues.push({start, end, text: pieces[index]});
      start = end;
    }
  }
  return cues;
}

function parseTimestamp(value) {
  const match = value.trim().match(/^(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) fail(`자막 시간 형식을 읽을 수 없습니다: ${value.slice(0, 40)}`);
  const hours = Number(match[1] || 0), minutes = Number(match[2]), seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) fail('자막의 분과 초는 00~59 범위여야 합니다.');
  const milliseconds = Number(match[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

/** Read SRT, ignoring the numeric cue identifiers and common display-only tags. */
export function parseSrt(input) {
  if (typeof input !== 'string' || encoder.encode(input).byteLength > 5 * 1024 * 1024) fail('5MB 이하의 SRT 자막 파일을 사용해 주세요.');
  const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line || /^\d+$/.test(line) || /^WEBVTT(?:\s|$)/.test(line)) { index++; continue; }
    if (!line.includes('-->')) fail(`${index + 1}행에서 자막 시작·종료 시각을 찾을 수 없습니다.`);
    const parts = line.split('-->');
    if (parts.length !== 2) fail(`${index + 1}행의 자막 시간 형식이 올바르지 않습니다.`);
    const start = parseTimestamp(parts[0]);
    const end = parseTimestamp(parts[1].trim().split(/\s+/)[0]);
    if (end <= start) fail(`${cues.length + 1}번 자막은 종료 시각이 시작보다 늦어야 합니다.`);
    index++;
    const textLines = [];
    while (index < lines.length && lines[index].trim() !== '') {
      if (lines[index].includes('-->')) fail('자막 사이에 빈 줄을 넣어 주세요.');
      textLines.push(lines[index++]);
    }
    const text = textLines.join('\n').trim()
      .replace(/<\/?(?:b|i|u|font)(?:\s[^>]*)?>/gi, '')
      .replace(/\{\\[^}]*\}/g, '');
    if (text) cues.push({start, end, text});
    if (cues.length > 10000) fail('자막은 최대 10,000개까지 사용할 수 있습니다.');
  }
  if (!cues.length) fail('읽을 수 있는 자막이 없습니다. SRT 파일을 확인해 주세요.');
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

function formatTimestamp(seconds) {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(milliseconds / 3600000);
  const m = Math.floor(milliseconds / 60000) % 60;
  const s = Math.floor(milliseconds / 1000) % 60;
  const ms = milliseconds % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function exportSrt(projectOrCues) {
  const cues = Array.isArray(projectOrCues) ? projectOrCues : getCaptions(projectOrCues);
  return cues.filter(cue => cue.text?.trim() && cue.end > cue.start).map((cue, index) => {
    return `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text.trim()}\n`;
  }).join('\n');
}

export function referencedAssetIds(project) {
  return new Set([
    ...project.scenes.map(scene => scene.imageId),
    project.audio?.narrationId,
    project.audio?.bgmId,
  ].filter(Boolean));
}

function canonicalAssets(project, assets) {
  const result = [];
  let totalSize = 0;
  for (const id of referencedAssetIds(project)) {
    const asset = assets instanceof Map ? assets.get(id) : assets[id];
    if (!asset?.blob || !(asset.blob instanceof Blob)) fail('프로젝트에 필요한 이미지 또는 음성 파일이 없습니다. 다시 첨부해 주세요.');
    const type = asset.blob.type || asset.type || '';
    const image = project.scenes.some(scene => scene.imageId === id);
    if (image && !/^image\/(png|jpeg|webp|gif|avif|bmp|svg\+xml)$/i.test(type)) fail('지원하지 않는 이미지 파일 형식입니다.');
    if (!image && !/^audio\//i.test(type) && !['video/mp4', 'video/webm', 'application/octet-stream', ''].includes(type)) fail('지원하지 않는 음성 파일 형식입니다.');
    totalSize += asset.blob.size;
    if (totalSize > MAX_ASSET_BYTES) fail('프로젝트 미디어 합계는 180MB 이하로 줄여 주세요.');
    result.push({id, blob: asset.blob, name: String(asset.name || 'asset').slice(0, 300), type});
  }
  return result;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('이 브라우저에서는 자동 저장을 사용할 수 없습니다. 프로젝트 파일로 저장해 주세요.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', {keyPath: 'id'});
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('자동 저장 공간을 열지 못했습니다. 프로젝트 파일로 저장해 주세요.'));
    request.onblocked = () => reject(new Error('다른 탭에서 편집기를 닫은 뒤 다시 저장해 주세요.'));
  });
}

function transactionResult(transaction, db) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(new Error('자동 저장에 실패했습니다. 저장 공간을 확인하거나 프로젝트 파일로 저장해 주세요.')); };
    transaction.onabort = () => { db.close(); reject(new Error('자동 저장이 중단되었습니다. 프로젝트 파일로 저장해 주세요.')); };
  });
}

/** One atomic transaction stores project and all referenced Blob assets. */
export async function saveProject(input, assets) {
  const project = validateProject(input);
  const records = canonicalAssets(project, assets);
  const db = await openDatabase();
  const transaction = db.transaction(['projects', 'assets'], 'readwrite');
  const result = transactionResult(transaction, db);
  transaction.objectStore('projects').put({project, savedAt: new Date().toISOString()}, 'current');
  const store = transaction.objectStore('assets');
  store.clear();
  for (const record of records) store.put(record);
  await result;
}

export async function loadProject() {
  const db = await openDatabase();
  const transaction = db.transaction(['projects', 'assets'], 'readonly');
  let record, entries = [];
  const result = transactionResult(transaction, db);
  const projectRequest = transaction.objectStore('projects').get('current');
  const assetRequest = transaction.objectStore('assets').getAll();
  projectRequest.onsuccess = () => { record = projectRequest.result; };
  assetRequest.onsuccess = () => { entries = assetRequest.result; };
  await result;
  if (!record?.project) return null;
  const project = validateProject(record.project);
  const assets = new Map(entries.map(({id, ...asset}) => [id, asset]));
  canonicalAssets(project, assets);
  return {project, assets, savedAt: record.savedAt};
}

export async function clearSavedProject() {
  const db = await openDatabase();
  const transaction = db.transaction(['projects', 'assets'], 'readwrite');
  const result = transactionResult(transaction, db);
  transaction.objectStore('projects').clear();
  transaction.objectStore('assets').clear();
  await result;
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 32768;
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof base64 !== 'string' || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) fail('프로젝트 미디어 데이터가 손상되었습니다.');
  let binary;
  try { binary = atob(base64); } catch { fail('프로젝트 미디어 데이터를 읽지 못했습니다.'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function exportProjectBackup(input, assets) {
  const project = validateProject(input);
  const records = canonicalAssets(project, assets);
  const serialized = [];
  for (const record of records) {
    serialized.push({id: record.id, name: record.name, type: record.type, data: bytesToBase64(await record.blob.arrayBuffer())});
  }
  const result = new Blob([JSON.stringify({kind: 'bth-image-studio', version: SCHEMA_VERSION, exportedAt: new Date().toISOString(), project, assets: serialized})], {type: 'application/json'});
  if (result.size > MAX_BACKUP_BYTES) fail('프로젝트 파일이 250MB를 넘습니다. 이미지를 줄여 주세요.');
  return result;
}

export async function importProjectBackup(input) {
  let data = input;
  if (input instanceof Blob) {
    if (input.size > MAX_BACKUP_BYTES) fail('250MB 이하의 프로젝트 파일을 사용해 주세요.');
    data = await input.text();
  }
  if (typeof data === 'string') {
    if (data.length > MAX_BACKUP_BYTES || encoder.encode(data).byteLength > MAX_BACKUP_BYTES) fail('250MB 이하의 프로젝트 파일을 사용해 주세요.');
    try { data = JSON.parse(data); } catch { fail('프로젝트 파일을 읽을 수 없습니다. 올바른 JSON 파일을 선택해 주세요.'); }
  }
  if (!plainObject(data) || data.kind !== 'bth-image-studio' || data.version !== SCHEMA_VERSION) fail('BLKOUT Image Studio 프로젝트 파일을 선택해 주세요.');
  const project = validateProject(data.project);
  if (!Array.isArray(data.assets) || data.assets.length > 202) fail('프로젝트 미디어 목록이 올바르지 않습니다.');
  const assets = new Map();
  let totalBytes = 0;
  for (const entry of data.assets) {
    if (!plainObject(entry)) fail('프로젝트 미디어 항목이 올바르지 않습니다.');
    const id = validId(entry.id, false, '미디어');
    if (assets.has(id)) fail('프로젝트에 중복된 미디어가 있습니다.');
    const type = textValue(entry.type, '', 100, '미디어 형식');
    const name = textValue(entry.name, 'asset', 300, '파일 이름');
    if (typeof entry.data !== 'string' || entry.data.length > MAX_BACKUP_BYTES) fail('프로젝트 미디어 데이터가 너무 큽니다.');
    totalBytes += Math.floor(entry.data.length * 3 / 4);
    if (totalBytes > MAX_ASSET_BYTES + data.assets.length * 2) fail('프로젝트 미디어 합계는 180MB 이하여야 합니다.');
    const bytes = base64ToBytes(entry.data);
    assets.set(id, {blob: new Blob([bytes], {type}), name, type});
  }
  canonicalAssets(project, assets);
  const needed = referencedAssetIds(project);
  for (const id of assets.keys()) if (!needed.has(id)) assets.delete(id);
  return {project, assets};
}
