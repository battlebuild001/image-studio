import {normalizePronunciations} from './pronunciation.js';
import {normalizeDiagramCard, normalizeVisualReview, DIAGRAM_TYPES} from './production-visual-protocol.js';

/** Credential-free, schema-one production tools state shared by backups and workspaces. */
export const MAX_PRODUCTION_BYTES = 2 * 1024 * 1024;
const DOMAINS = new Set(['version', 'speech', 'changes', 'budget', 'versions', 'visual', 'diagrams', 'channel', 'shorts', 'publishing']);
const ID = /^[a-zA-Z0-9_-]{1,180}$/u;
const DENIED = /(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credentials?|private[_-]?key)|^(?:__proto__|prototype|constructor|token|secret|raw[_-]?provider(?:response)?|provider[_-]?response|base64|b64_json)$/iu;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => {throw new Error(message || '제작 관리 자료의 형식이나 크기를 확인해 주세요.');};
const encoder = new TextEncoder();
function finite(value, min, max, label) {if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} 값을 확인해 주세요.`);return value;}
function text(value, max, label) {if (typeof value !== 'string' || Array.from(value).length > max) fail(`${label} 형식이나 길이를 확인해 주세요.`);return value;}
function stamp(value) {if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) fail('제작 자료의 저장 시각을 확인해 주세요.');}
function identifier(value) {if (typeof value !== 'string' || !ID.test(value)) fail('제작 자료의 식별자를 확인해 주세요.');}

/** Never carry credentials, raw responses or embedded media into portable project data. */
export function cloneProductionData(value, {maxBytes = MAX_PRODUCTION_BYTES} = {}) {
  let nodes = 0;
  function clone(input, depth) {
    if (++nodes > 40000 || depth > 16) fail('제작 관리 자료가 너무 복잡해요. 이전 버전을 정리해 주세요.');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') {if (!Number.isFinite(input)) fail();return input;}
    if (typeof input === 'string') {
      if (input.length > 300000 || /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/u.test(input) || /^data:(?:image|audio|video)\//iu.test(input)) fail('제작 자료에는 API 키나 미디어 원문을 저장할 수 없어요.');
      return input.replace(/\u0000/gu, '');
    }
    if (Array.isArray(input)) {if (input.length > 1000) fail('제작 목록이 너무 길어요.');return input.map(item => clone(item, depth + 1));}
    if (!plain(input) || Object.keys(input).length > 200) fail();
    const result = {};
    for (const [key, item] of Object.entries(input)) {
      if (item === undefined) continue;
      if (DENIED.test(key) || key.length > 100) fail('제작 관리에는 인증 정보나 원본 API 응답을 넣을 수 없어요.');
      result[key] = clone(item, depth + 1);
    }
    return result;
  }
  const result = clone(value, 0);
  if (encoder.encode(JSON.stringify(result)).byteLength > maxBytes) fail('제작 관리 자료는 합계 2MiB 이하로 줄여 주세요. 이전 버전을 정리해 주세요.');
  return result;
}

function validateSpeech(value) {
  if (!plain(value)) fail();
  if (value.pronunciations !== undefined) value.pronunciations = normalizePronunciations(value.pronunciations);
  if (value.updatedAt !== undefined) stamp(value.updatedAt);
}

function list(value, max, label, each) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} 항목 수를 확인해 주세요.`);
  value.forEach(each);
}
function optionalText(value, key, max) {if (value[key] !== undefined) text(value[key], max, key);}
function notes(value) {list(value, 12, '참고 사항', item => text(item, 1000, '참고 사항'));}
function metadata(value) {
  optionalText(value, 'model', 100);
  if (value.createdAt !== undefined) stamp(value.createdAt);
}
function validateVisual(value) {
  optionalText(value, 'inputKey', 1000);optionalText(value, 'summary', 4000);optionalText(value, 'model', 100);
  if (value.reviewedAt !== undefined) stamp(value.reviewedAt);
  if (value.sceneIds !== undefined) list(value.sceneIds, 200, '점검 장면', identifier);
  if (value.findings !== undefined) normalizeVisualReview({summary: value.summary ?? '', findings: value.findings, notes: value.notes ?? [], model: value.model ?? '', createdAt: value.reviewedAt ?? ''}, value.sceneIds ?? []);
  if (value.notes !== undefined) notes(value.notes);
}
function validateDiagrams(value) {
  for (const [key, max] of [['sourceText', 100000], ['inputKey', 1000], ['model', 100], ['title', 200]]) optionalText(value, key, max);
  if (value.generatedAt !== undefined && value.generatedAt !== '') stamp(value.generatedAt);
  if (value.requestedType !== undefined && !DIAGRAM_TYPES.includes(value.requestedType)) fail('자료 화면 종류를 확인해 주세요.');
  if (value.cards !== undefined) {
    const seen = new Set();
    list(value.cards, 4, '자료 화면', (card, index) => {const normalized = normalizeDiagramCard(card, index);if (seen.has(normalized.id)) fail('자료 화면 식별자가 중복돼요.');seen.add(normalized.id);});
  }
  if (value.notes !== undefined) notes(value.notes);
}
function validateChannel(value) {
  optionalText(value, 'name', 120);optionalText(value, 'tone', 2000);optionalText(value, 'presetId', 180);
  if (value.updatedAt !== undefined) stamp(value.updatedAt);
  for (const key of ['intro', 'outro']) if (value[key] !== undefined) {
    const card = value[key];if (!plain(card) || typeof card.enabled !== 'boolean') fail('인트로·아웃트로 설정을 확인해 주세요.');
    optionalText(card, 'title', 200);optionalText(card, 'subtitle', 500);
    if (card.duration !== undefined) finite(card.duration, 1, 15, '제목 화면 길이');
  }
}
function validateShorts(value) {
  optionalText(value, 'sourceKey', 250000);
  if (value.targetSeconds !== undefined && ![30, 60].includes(value.targetSeconds)) fail('쇼츠 길이는 30초 또는 60초로 정해 주세요.');
  if (value.result === undefined || value.result === null) return;
  const result = value.result;if (!plain(result)) fail('쇼츠 구간 자료를 확인해 주세요.');
  text(result.title, 200, '쇼츠 제목');text(result.hook, 300, '쇼츠 도입');notes(result.notes);metadata(result);
  let previous = 0, total = 0;
  list(result.segments, 8, '쇼츠 구간', segment => {
    if (!plain(segment)) fail('쇼츠 구간을 확인해 주세요.');
    finite(segment.start, 0, 3600, '구간 시작');finite(segment.end, 0, 3600, '구간 끝');text(segment.label, 300, '구간 설명');
    if (segment.end - segment.start < .25 || segment.start < previous - .001) fail('쇼츠 구간은 시간순으로 겹치지 않게 정해 주세요.');
    previous = segment.end;total += segment.end - segment.start;
  });
  if (!result.segments.length || total > (value.targetSeconds ?? 60) + .5) fail('쇼츠 구간 합계가 목표 길이를 넘어요.');
}
function validatePublishing(value) {
  optionalText(value, 'sourceKey', 250000);
  if (value.selectedTitle !== undefined && (!Number.isInteger(value.selectedTitle) || value.selectedTitle < 0 || value.selectedTitle > 4)) fail('게시 제목 선택을 확인해 주세요.');
  if (value.result === undefined || value.result === null) return;
  const result = value.result;if (!plain(result)) fail('게시 자료를 확인해 주세요.');
  list(result.titles, 5, '게시 제목', item => text(item, 200, '게시 제목'));
  if (!result.titles.length || (value.selectedTitle ?? 0) >= result.titles.length) fail('게시 제목을 한 개 이상 준비해 주세요.');
  text(result.description, 8000, '게시 설명');notes(result.notes);metadata(result);
  list(result.tags, 30, '게시 태그', item => text(item, 100, '게시 태그'));
  let previous = -1;
  list(result.chapters, 60, '챕터', chapter => {if (!plain(chapter)) fail();finite(chapter.start, 0, 3600, '챕터 시간');text(chapter.title, 200, '챕터 제목');if (chapter.start <= previous) fail('챕터는 시간순으로 정해 주세요.');previous = chapter.start;});
  // A local draft may have no image yet; it still has editable publishing text.
  list(result.thumbnailConcepts, 3, '썸네일 후보', concept => {if (!plain(concept)) fail();text(concept.headline, 120, '썸네일 문구');text(concept.prompt, 2000, '썸네일 구성');if (concept.sceneId !== '') identifier(concept.sceneId);});
}
function validateChanges(value) {
  if (value.updatedAt !== undefined) stamp(value.updatedAt);
  if (value.baseline !== undefined && value.baseline !== null) {
    const baseline = value.baseline;if (!plain(baseline)) fail('변경 비교 기준을 확인해 주세요.');
    if (baseline.scenes !== undefined) list(baseline.scenes, 200, '비교 기준 장면', scene => {
      if (!plain(scene)) fail('비교 기준 장면을 확인해 주세요.');identifier(scene.sceneId);optionalText(scene, 'caption', 2000);optionalText(scene, 'captionKey', 1000);
      if (scene.imageId !== undefined && scene.imageId !== null) identifier(scene.imageId);
      for (const key of ['start', 'end']) if (scene[key] !== undefined) finite(scene[key], 0, 3600, '비교 기준 시간');
      for (const key of ['displayStart', 'displayEnd']) if (scene[key] !== undefined && (!Number.isInteger(scene[key]) || scene[key] < 0 || scene[key] > 100000)) fail('비교 기준 문자 위치를 확인해 주세요.');
    });
    optionalText(baseline, 'displayText', 100000);
    for (const key of ['narrationKey', 'displayKey']) optionalText(baseline, key, 1000);
    if (baseline.capturedAt !== undefined) stamp(baseline.capturedAt);
  }
  if (value.lastVoicePatch !== undefined && value.lastVoicePatch !== null) {
    const patch = value.lastVoicePatch;if (!plain(patch)) fail('부분 음성 적용 기록을 확인해 주세요.');
    if (patch.sceneIds !== undefined) list(patch.sceneIds, 200, '부분 음성 장면', identifier);
    optionalText(patch, 'spokenText', 10000);optionalText(patch, 'displayText', 20000);
    for (const key of ['start', 'end', 'replacementDuration']) if (patch[key] !== undefined) finite(patch[key], 0, 3600, '부분 음성 시간');
    if (patch.appliedAt !== undefined) stamp(patch.appliedAt);
  }
}
function validateBudget(value) {
  if (!plain(value)) fail();
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail('예산 사용 여부를 확인해 주세요.');
  if (value.currency !== undefined && !['USD', 'KRW'].includes(value.currency)) fail('예산 통화를 확인해 주세요.');
  if (value.limit !== undefined) finite(value.limit, 0, 1e12, '예산');
  if (value.exchangeRate !== undefined) finite(value.exchangeRate, .000001, 1e6, '환율');
  if (value.spentUsd !== undefined) finite(value.spentUsd, 0, 1e12, '누적 예상 사용액');
  if (value.rates !== undefined) {
    if (!plain(value.rates)) fail('예상 단가를 확인해 주세요.');
    for (const rate of Object.values(value.rates)) finite(rate, 0, 1e6, '예상 단가');
  }
  if (value.ledger !== undefined) {
    if (!Array.isArray(value.ledger) || value.ledger.length > 100) fail('비용 기록은 최근 100개까지 저장할 수 있어요.');
    for (const entry of value.ledger) {
      if (!plain(entry)) fail();identifier(entry.id);stamp(entry.at);text(entry.label, 500, '비용 기록 이름');text(entry.route, 200, '요청 종류');
      finite(entry.estimatedUsd, 0, 1e9, '예상 비용');if (!['reserved', 'completed', 'uncertain'].includes(entry.status)) fail('비용 기록 상태를 확인해 주세요.');
    }
  }
}
function validateVersions(value) {
  if (!Array.isArray(value) || value.length > 30) fail('저장된 버전은 30개 이하로 정리해 주세요.');
  const seen = new Set();
  for (const entry of value) {
    if (!plain(entry)) fail();identifier(entry.id);if (seen.has(entry.id)) fail('버전 식별자는 중복될 수 없어요.');seen.add(entry.id);
    if (!['script', 'image', 'voice'].includes(entry.kind)) fail('버전 종류를 확인해 주세요.');
    text(entry.label, 300, '버전 이름');stamp(entry.createdAt);
    if (entry.sceneId !== undefined) identifier(entry.sceneId);
    if (entry.assetId !== undefined) identifier(entry.assetId);
    if (entry.kind !== 'script' && !entry.assetId) fail('이미지·음성 버전에는 원본 미디어가 필요해요.');
    if (entry.script !== undefined) text(entry.script, 100000, '대본 버전');
    if (entry.displayScript !== undefined) text(entry.displayScript, 100000, '화면 자막 버전');
    if (entry.project !== undefined || entry.production !== undefined || entry.versions !== undefined) fail('버전 안에 프로젝트 기록을 중첩할 수 없어요.');
  }
}

export function normalizeProductionState(input) {
  if (input === undefined || input === null) return null;
  if (!plain(input) || input.version !== 1 || Object.keys(input).some(key => !DOMAINS.has(key))) fail('제작 관리 자료 버전을 확인해 주세요.');
  const result = cloneProductionData(input);
  for (const key of DOMAINS) {
    if (key === 'version' || result[key] === undefined || result[key] === null) continue;
    if (key === 'versions') validateVersions(result[key]);
    else if (!plain(result[key])) fail('제작 관리 설정 형식을 확인해 주세요.');
  }
  if (result.speech) validateSpeech(result.speech);
  if (result.budget) validateBudget(result.budget);
  if (result.visual) validateVisual(result.visual);
  if (result.diagrams) validateDiagrams(result.diagrams);
  if (result.channel) validateChannel(result.channel);
  if (result.shorts) validateShorts(result.shorts);
  if (result.publishing) validatePublishing(result.publishing);
  if (result.changes) validateChanges(result.changes);
  return result;
}

export function referencedProductionAssetIds(projectOrState) {
  const state = projectOrState?.production ?? projectOrState;
  return new Set((state?.versions || []).filter(entry => ['image', 'voice'].includes(entry.kind)).map(entry => entry.assetId).filter(Boolean));
}
export function referencedProductionImageIds(projectOrState) {
  const state = projectOrState?.production ?? projectOrState;
  return new Set((state?.versions || []).filter(entry => entry.kind === 'image').map(entry => entry.assetId).filter(Boolean));
}
