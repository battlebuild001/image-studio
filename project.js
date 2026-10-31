/** BLKOUT Image Studio: project model, captions, and local storage. */

import {normalizeTopicResearchResult} from './topic-research-protocol.js';

export const SCHEMA_VERSION = 1;
export const MAX_BACKUP_BYTES = 250 * 1024 * 1024;
export const MAX_ASSET_BYTES = 180 * 1024 * 1024;
const MAX_REFERENCE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const DB_NAME = 'bth-blkout-image-studio';
export const DB_VERSION = 3;
const MOTIONS = new Set(['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'subtle-zoom', 'subtle-drift', 'none', 'custom']);
const EFFECTS = ['none', 'dust', 'fog', 'light'];
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
    focusX: 0.5,
    focusY: 0.5,
    endX: 0.5,
    endY: 0.5,
    zoomStart: 1,
    zoomEnd: 1.12,
    effect: 'none',
    effectIntensity: 0.25,
    ...overrides,
  };
}

export function createProject(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: createId('episode'),
    title: '새 콘텐츠 프로젝트',
    aspect: '16:9',
    scenes: [],
    captions: [],
    captionMode: 'auto',
    captionAnalysis: null,
    scriptDraft: null,
    scenePlan: null,
    imageStudio: {background: '', style: '', negativePrompt: '', prompt: '',
      size: '1536x864', quality: 'medium', references: []},
    ...overrides,
    settings: {
      transition: 0.4,
      subtitles: true,
      branding: true,
      aiImageNotice: false,
      aiImageNoticePosition: 'bottom-center',
      fontSize: 48,
      bgmVolume: 0.12,
      narrationVolume: 1,
      captionFont: 'sans',
      captionColor: '#ffffff',
      captionBackground: '#070a0d',
      captionOpacity: 0.83,
      captionStroke: '#000000',
      captionStrokeWidth: 0,
      captionPosition: 'bottom',
      bgmFadeIn: 0,
      bgmFadeOut: 0,
      ducking: false,
      ...(overrides.settings || {}),
    },
    audio: {narrationId: null, bgmId: null, narrationStart: 0, narrationEnd: null, narrationOffset: 0,
      bgmStart: 0, bgmEnd: null, ...(overrides.audio || {})},
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
function choice(value, fallback, options, label) {
  if (value === undefined || value === null) return fallback;
  if (!options.includes(value)) fail(`지원하지 않는 ${label}입니다.`);
  return value;
}
function colorValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) fail('색상은 #RRGGBB 형식이어야 합니다.');
  return value.toLowerCase();
}
function booleanValue(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail(`${label} 설정을 확인해 주세요.`);
  return value;
}

/** Speech cues retain source-file timestamps so nondestructive audio edits can remap them. */
function validateCaptionAnalysis(input, captions) {
  if (!plainObject(input)) fail('음성 분석 자막에는 분석 정보가 필요합니다.');
  const sourceStart = finiteNumber(input.sourceStart, undefined, 0, 86400, '분석한 음성 시작점');
  const sourceEnd = finiteNumber(input.sourceEnd, undefined, 0, 86400, '분석한 음성 종료점');
  if (sourceStart === undefined || sourceEnd === undefined || sourceEnd <= sourceStart) {
    fail('분석한 음성 구간을 확인해 주세요.');
  }
  if (captions.some(cue => cue.start < sourceStart || cue.end > sourceEnd)) {
    fail('음성 분석 자막의 시간은 분석한 원본 음성 구간 안에 있어야 합니다.');
  }
  const language = textValue(input.language, '', 40, '음성 분석 언어').trim();
  const model = textValue(input.model, '', 120, '음성 분석 모델').trim();
  if (!language || !model) fail('음성 분석 언어와 모델을 확인해 주세요.');
  if (!['word', 'segment'].includes(input.granularity)) fail('음성 분석 시간 단위를 확인해 주세요.');
  if (typeof input.createdAt !== 'string' || input.createdAt.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(input.createdAt) || !Number.isFinite(Date.parse(input.createdAt))) {
    fail('음성 분석 날짜를 확인해 주세요.');
  }
  return {
    narrationId: validId(input.narrationId, false, '분석한 내레이션'),
    sourceStart, sourceEnd, language, model,
    granularity: input.granularity,
    createdAt: new Date(input.createdAt).toISOString(),
  };
}

function scriptText(value, fallback, max, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || Array.from(value).length > max) fail(`${label} 형식이나 길이를 확인해 주세요.`);
  return value.replace(/\u0000/g, '');
}
function scriptInteger(value, fallback, min, max, label) {
  const number = finiteNumber(value, fallback, min, max, label);
  if (!Number.isInteger(number)) fail(`${label} 값은 정수로 입력해 주세요.`);
  return number;
}
function scriptSource(input) {
  if (!plainObject(input)) fail('대본 출처 형식을 확인해 주세요.');
  const raw = scriptText(input.url, '', 2048, '대본 출처 주소');
  if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) fail('대본 출처 주소가 올바르지 않습니다.');
  let url;
  try { url = new URL(raw); } catch { fail('대본 출처 주소가 올바르지 않습니다.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.href.length > 2048) {
    fail('대본 출처에는 사용자 정보가 없는 HTTP 또는 HTTPS 주소만 사용할 수 있습니다.');
  }
  return {title: scriptText(input.title, url.hostname, 500, '대본 출처 제목'), url: url.href};
}
function scriptTimestamp(value) {
  const input = scriptText(value, '', 40, '대본 검색 시각');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input)) fail('대본 검색 시각이 올바르지 않습니다.');
  const timestamp = new Date(input);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString().slice(0, 19) !== input.slice(0, 19)) {
    fail('대본 검색 시각이 올바르지 않습니다.');
  }
  return timestamp.toISOString();
}

/** Topic collection is independent of editable sources and spoken narration. */
function validateTopicResearch(input) {
  if (!plainObject(input)) fail('주제 자료 수집 설정 형식을 확인해 주세요.');
  return {
    topic: scriptText(input.topic, '', 500, '자료 수집 주제'),
    instructions: scriptText(input.instructions, '', 2000, '자료 수집 방향'),
    result: input.result === undefined || input.result === null ? null : normalizeTopicResearchResult(input.result),
  };
}

/** Spoken drafts can be written before narration; researched results retain their separate evidence. */
function validateScriptDraft(input) {
  if (input === undefined || input === null) return null;
  if (!plainObject(input)) fail('대본 제작 자료 형식이 올바르지 않습니다.');
  let serialized;
  try { serialized = JSON.stringify(input); } catch { fail('대본 제작 자료 형식이 올바르지 않습니다.'); }
  if (typeof serialized !== 'string' || encoder.encode(serialized).byteLength > 600 * 1024) {
    fail('대본 제작 자료는 합계 600KiB 이하로 줄여 주세요.');
  }
  const targetMinutes = scriptInteger(input.targetMinutes, 8, 1, 60, '목표 분량');
  const charsPerMinute = scriptInteger(input.charsPerMinute, 330, 200, 500, '분당 글자 수');
  const narrationStyles = ['standard', 'korean', 'korean-digits', 'korean-native-digits'];
  const narrationStyle = input.narrationStyle ?? 'standard';
  if (!narrationStyles.includes(narrationStyle)) fail('대본 발음 표기 옵션을 확인해 주세요.');
  const sourceFidelities = ['summary', 'balanced', 'faithful'], detailLevels = ['concise', 'standard', 'expanded'];
  const sourceFidelity = input.sourceFidelity === undefined ? 'balanced' : input.sourceFidelity;
  const detailLevel = input.detailLevel === undefined ? 'standard' : input.detailLevel;
  if (!sourceFidelities.includes(sourceFidelity)) fail('원본 반영 정도 옵션을 확인해 주세요.');
  if (!detailLevels.includes(detailLevel)) fail('설명 상세도 옵션을 확인해 주세요.');
  let result = null;
  if (input.result !== undefined && input.result !== null) {
    const data = input.result;
    if (!plainObject(data) || data.webSearchUsed !== true) fail('웹 검색을 확인한 대본 결과만 저장할 수 있습니다.');
    if (!Array.isArray(data.sources) || !data.sources.length || data.sources.length > 30) {
      fail('대본 결과에는 1~30개의 확인된 출처가 필요합니다.');
    }
    const notes = data.notes ?? [];
    if (!Array.isArray(notes) || notes.length > 30) fail('대본 참고 사항은 30개 이하로 저장해 주세요.');
    if (typeof data.script !== 'string') fail('생성 대본 형식이 올바르지 않습니다.');
    const script = scriptText(data.script, '', 100000, '생성 대본');
    const resultPace = scriptInteger(data.charsPerMinute, charsPerMinute, 200, 500, '대본 분당 글자 수');
    const characters = Array.from(script.replace(/\s/g, '')).length;
    const resultStyle = data.narrationStyle ?? 'standard';
    if (!narrationStyles.includes(resultStyle)) fail('생성 대본 발음 표기 옵션을 확인해 주세요.');
    const resultFidelity = data.sourceFidelity === undefined ? 'balanced' : data.sourceFidelity;
    const resultDetail = data.detailLevel === undefined ? 'standard' : data.detailLevel;
    if (!sourceFidelities.includes(resultFidelity)) fail('생성 대본 원본 반영 정도 옵션을 확인해 주세요.');
    if (!detailLevels.includes(resultDetail)) fail('생성 대본 설명 상세도 옵션을 확인해 주세요.');
    result = {
      title: scriptText(data.title, '', 200, '생성 대본 제목'),
      summary: scriptText(data.summary, '', 20000, '자료 요약'),
      script,
      sources: data.sources.map(scriptSource),
      notes: notes.map(note => {
        if (typeof note !== 'string') fail('대본 참고 사항은 문자열이어야 합니다.');
        return scriptText(note, '', 2000, '대본 참고 사항');
      }),
      targetMinutes: scriptInteger(data.targetMinutes, targetMinutes, 1, 60, '대본 목표 분량'),
      charsPerMinute: resultPace,
      characters,
      estimatedMinutes: characters / resultPace,
      searchedAt: scriptTimestamp(data.searchedAt),
      webSearchUsed: true,
      narrationStyle: resultStyle,
      sourceFidelity: resultFidelity,
      detailLevel: resultDetail,
    };
  }
  if (input.draftScript !== undefined && typeof input.draftScript !== 'string') {
    fail('작성 대본 형식이 올바르지 않습니다.');
  }
  // An explicitly cleared editor stays empty even when previous research exists.
  // Older version-one projects kept their editable narration in result.script.
  const draftScript = input.draftScript === undefined
    ? result?.script ?? ''
    : scriptText(input.draftScript, '', 100000, '작성 대본');
  return {
    sourceText: scriptText(input.sourceText, '', 100000, '대본 참고 자료'),
    instructions: scriptText(input.instructions, '', 2000, '대본 작성 지시'),
    targetMinutes,
    charsPerMinute,
    narrationStyle,
    sourceFidelity,
    detailLevel,
    draftScript,
    result,
    ...(input.topicResearch === undefined || input.topicResearch === null ? {} : {topicResearch: validateTopicResearch(input.topicResearch)}),
  };
}

/** A confirmed schedule remains available after manual edits so it can be reviewed or undone.
 * Whether it still matches the current scenes belongs to the planning workflow.
 */
function validateScenePlan(input) {
  if (input === undefined || input === null) return null;
  if (!plainObject(input) || input.version !== 1) fail('장면 이미지 계획 형식이 올바르지 않습니다.');
  let serialized;
  try { serialized = JSON.stringify(input); } catch { fail('장면 이미지 계획 형식이 올바르지 않습니다.'); }
  if (typeof serialized !== 'string' || encoder.encode(serialized).byteLength > 3 * 1024 * 1024) {
    fail('장면 이미지 계획은 합계 3MiB 이하로 줄여 주세요.');
  }
  const requiredNumber = (value, min, max, label) => {
    if (typeof value !== 'number') fail(`${label} 값을 숫자로 입력해 주세요.`);
    return finiteNumber(value, undefined, min, max, label);
  };
  const requiredText = (value, max, label) => {
    if (typeof value !== 'string') fail(`${label} 형식이나 길이를 확인해 주세요.`);
    return scriptText(value, '', max, label);
  };
  const intervalSeconds = requiredNumber(input.intervalSeconds, 1, 600, '이미지 전환 간격');
  const durationSeconds = requiredNumber(input.durationSeconds, 0.25, 3600, '장면 계획 전체 길이');
  if (!['target', 'narration', 'estimated', 'current'].includes(input.basis)) fail('장면 계획의 시간 기준이 올바르지 않습니다.');
  if (typeof input.confirmedAt !== 'string' || input.confirmedAt.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(input.confirmedAt)) {
    fail('장면 계획 확정 시각이 올바르지 않습니다.');
  }
  const confirmed = new Date(input.confirmedAt);
  if (!Number.isFinite(confirmed.getTime()) || confirmed.toISOString().slice(0, 19) !== input.confirmedAt.slice(0, 19)) {
    fail('장면 계획 확정 시각이 올바르지 않습니다.');
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 200) {
    fail('장면 계획은 1~200개 장면으로 구성해 주세요.');
  }
  const ids = new Set();let previousEnd = 0;
  const items = input.items.map(item => {
    if (!plainObject(item)) fail('장면 계획 항목이 올바르지 않습니다.');
    const sceneId = validId(item.sceneId, false, '계획한 장면');
    if (ids.has(sceneId)) fail('장면 계획에 중복된 장면 식별자가 있습니다.');
    ids.add(sceneId);
    const start = requiredNumber(item.start, 0, 3600, '장면 계획 시작 시각');
    const end = requiredNumber(item.end, 0, 3600, '장면 계획 종료 시각');
    if (Math.abs(start - previousEnd) > 0.001 || end <= start || end - start < 0.25 - 1e-9 || end - start > 600 + 1e-9) {
      fail('장면 계획의 시간은 빈틈이나 겹침 없이 이어지고 각 장면은 0.25~600초여야 합니다.');
    }
    previousEnd = end;
    return {sceneId, start, end,
      caption: textValue(requiredText(item.caption, 20000, '계획한 장면 대본'), '', 20000, '계획한 장면 대본'),
      prompt: requiredText(item.prompt, 6000, '장면 이미지 생성 요청')};
  });
  if (Math.abs(previousEnd - durationSeconds) > 0.001) fail('마지막 장면의 종료 시각이 계획한 전체 길이와 다릅니다.');
  const visualBrief = scriptText(input.visualBrief, '', 6000, '영상 전체 콘셉트');
  let visualPlan;
  if (input.visualPlan !== undefined && input.visualPlan !== null) {
    const value = input.visualPlan;
    if (!plainObject(value) || value.version !== 1) fail('영상 전체 이미지 구성 형식을 확인해 주세요.');
    const model = requiredText(value.model, 100, '영상 구성 모델');
    if (!/^[a-zA-Z0-9_.:-]{1,100}$/u.test(model) || /^sk-/iu.test(model)) fail('영상 구성 모델을 확인해 주세요.');
    const globalConcept = requiredText(value.globalConcept, 12000, '전체 영상 시각적 콘셉트');
    const inputKey = requiredText(value.inputKey, 600000, '영상 구성 입력 정보');
    if (!globalConcept.trim() || !inputKey.trim()) fail('영상 전체 구성의 콘셉트와 입력 정보가 필요해요.');
    visualPlan = {version: 1, createdAt: scriptTimestamp(value.createdAt), model, globalConcept, inputKey};
  }
  return {version: 1, intervalSeconds, durationSeconds, basis: input.basis,
    confirmedAt: confirmed.toISOString(), sourceScript: requiredText(input.sourceScript, 100000, '장면 계획 원본 대본'),
    narrationKey: requiredText(input.narrationKey, 1000, '장면 계획 내레이션 정보'), items,
    // Keep older schema-one timing plans byte-shape compatible until configured.
    ...(input.visualBrief === undefined ? {} : {visualBrief}), ...(visualPlan ? {visualPlan} : {})};
}

/** Reference metadata points to the same local Blob store as scene images. */
function validateImageStudio(input) {
  if (input === undefined || input === null) input = {};
  if (!plainObject(input)) fail('고정 이미지 레퍼런스 설정 형식이 올바르지 않습니다.');
  const references = input.references === undefined ? [] : input.references;
  if (!Array.isArray(references) || references.length > 5) fail('고정 레퍼런스 이미지는 최대 5장까지 저장할 수 있습니다.');
  const ids = new Set();
  return {
    background: scriptText(input.background, '', 20000, '배경 설정'),
    style: scriptText(input.style, '', 4000, '이미지 화풍'),
    negativePrompt: scriptText(input.negativePrompt, '', 2000, '피할 이미지 요소'),
    prompt: scriptText(input.prompt, '', 10000, '장면 이미지 요청'),
    size: choice(input.size, '1536x864', ['1536x864', '864x1536', '1024x1024'], '생성 이미지 크기'),
    quality: choice(input.quality, 'medium', ['low', 'medium', 'high'], '생성 이미지 품질'),
    references: references.map(reference => {
      if (!plainObject(reference)) fail('레퍼런스 이미지 정보 형식이 올바르지 않습니다.');
      const assetId = validId(reference.assetId, false, '레퍼런스 이미지');
      if (ids.has(assetId)) fail('같은 레퍼런스 이미지를 중복해서 등록할 수 없습니다.');
      ids.add(assetId);
      return {
        assetId,
        label: scriptText(reference.label, '', 120, '레퍼런스 이름'),
        role: choice(reference.role, 'concept', ['concept', 'background', 'character', 'style', 'other'], '레퍼런스 역할'),
        enabled: booleanValue(reference.enabled, true, '레퍼런스 사용'),
      };
    }),
  };
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
      focusX: finiteNumber(scene.focusX, 0.5, 0, 1, '이미지 가로 위치'),
      focusY: finiteNumber(scene.focusY, 0.5, 0, 1, '이미지 세로 위치'),
      endX: finiteNumber(scene.endX, 0.5, 0, 1, '이동 종료 가로 위치'),
      endY: finiteNumber(scene.endY, 0.5, 0, 1, '이동 종료 세로 위치'),
      zoomStart: finiteNumber(scene.zoomStart, 1, 1, 3, '시작 확대 배율'),
      zoomEnd: finiteNumber(scene.zoomEnd, 1.12, 1, 3, '종료 확대 배율'),
      effect: choice(scene.effect, 'none', EFFECTS, '장면 효과'),
      effectIntensity: finiteNumber(scene.effectIntensity, 0.25, 0, 1, '장면 효과 강도'),
    };
  });
  if (scenes.reduce((sum, scene) => sum + scene.duration, 0) > 3600.001) fail('한 프로젝트의 길이는 최대 60분입니다.');
  const settings = input.settings || {};
  if (!plainObject(settings)) fail('프로젝트 설정 형식이 올바르지 않습니다.');
  const audio = input.audio || {};
  if (!plainObject(audio)) fail('음성 설정 형식이 올바르지 않습니다.');
  const audioRange = {};
  for (const kind of ['narration', 'bgm']) {
    const start = finiteNumber(audio[`${kind}Start`], 0, 0, 3600, '오디오 시작점');
    const end = finiteNumber(audio[`${kind}End`], null, 0, 3600, '오디오 종료점');
    if (end !== null && end <= start) fail('오디오 종료점은 시작점보다 늦어야 합니다.');
    audioRange[`${kind}Start`] = start;
    audioRange[`${kind}End`] = end;
  }
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
  const captionMode = input.captionMode ?? 'auto';
  if (!['auto', 'srt', 'speech'].includes(captionMode)) fail('지원하지 않는 자막 모드입니다.');
  const captionAnalysis = captionMode === 'speech' ? validateCaptionAnalysis(input.captionAnalysis, canonicalCaptions) : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: validId(input.id, false, '프로젝트'),
    title: textValue(input.title, '새 콘텐츠 프로젝트', 200, '제목'),
    aspect: input.aspect,
    scenes,
    captions: canonicalCaptions,
    captionMode,
    captionAnalysis,
    scriptDraft: validateScriptDraft(input.scriptDraft),
    scenePlan: validateScenePlan(input.scenePlan),
    imageStudio: validateImageStudio(input.imageStudio),
    settings: {
      transition: finiteNumber(settings.transition, 0.4, 0, 3, '전환 시간'),
      subtitles: settings.subtitles !== false,
      branding: settings.branding !== false,
      aiImageNotice: booleanValue(settings.aiImageNotice, false, 'AI 생성 이미지 안내'),
      aiImageNoticePosition: choice(settings.aiImageNoticePosition, 'bottom-center', ['bottom-center', 'bottom-left'], 'AI 생성 이미지 안내 위치'),
      fontSize: finiteNumber(settings.fontSize, 48, 20, 100, '자막 크기'),
      bgmVolume: finiteNumber(settings.bgmVolume, 0.12, 0, 1, '배경음악 볼륨'),
      narrationVolume: finiteNumber(settings.narrationVolume, 1, 0, 2, '내레이션 볼륨'),
      captionFont: choice(settings.captionFont, 'sans', ['sans', 'serif', 'mono'], '자막 글꼴'),
      captionColor: colorValue(settings.captionColor, '#ffffff'),
      captionBackground: colorValue(settings.captionBackground, '#070a0d'),
      captionOpacity: finiteNumber(settings.captionOpacity, 0.83, 0, 1, '자막 배경 불투명도'),
      captionStroke: colorValue(settings.captionStroke, '#000000'),
      captionStrokeWidth: finiteNumber(settings.captionStrokeWidth, 0, 0, 8, '자막 테두리 두께'),
      captionPosition: choice(settings.captionPosition, 'bottom', ['top', 'center', 'bottom'], '자막 위치'),
      bgmFadeIn: finiteNumber(settings.bgmFadeIn, 0, 0, 10, '음악 페이드 인'),
      bgmFadeOut: finiteNumber(settings.bgmFadeOut, 0, 0, 10, '음악 페이드 아웃'),
      ducking: booleanValue(settings.ducking, false, '음악 자동 음량'),
    },
    audio: {
      narrationId: validId(audio.narrationId, true, '내레이션'),
      bgmId: validId(audio.bgmId, true, '배경음악'),
      narrationOffset: finiteNumber(audio.narrationOffset, 0, 0, 3600, '내레이션 시작 위치'),
      ...audioRange,
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

function selectedSceneIds(project, ids) {
  if (!Array.isArray(ids) || !ids.length) fail('장면을 먼저 선택해 주세요.');
  const selected = new Set(ids);
  if (selected.size !== ids.length || ids.some(id => !project.scenes.some(scene => scene.id === id))) {
    fail('선택한 장면을 찾을 수 없습니다. 다시 선택해 주세요.');
  }
  return selected;
}

/** Pure editing operations: validation failures never partly modify the caller. */
export function duplicateScenes(input, ids) {
  const project = validateProject(input);
  const selected = selectedSceneIds(project, ids);
  project.scenes = project.scenes.flatMap(scene => selected.has(scene.id)
    ? [scene, {...scene, id: createId('scene')}]
    : [scene]);
  return validateProject(project);
}

export function updateScenes(input, ids, patch) {
  const project = validateProject(input);
  const selected = selectedSceneIds(project, ids);
  const allowed = new Set(['duration', 'caption', 'motion', 'fit', 'focusX', 'focusY', 'endX', 'endY', 'zoomStart', 'zoomEnd', 'effect', 'effectIntensity']);
  if (!plainObject(patch) || Object.keys(patch).some(key => !allowed.has(key))) {
    fail('장면에 적용할 설정을 확인해 주세요.');
  }
  project.scenes = project.scenes.map(scene => selected.has(scene.id) ? {...scene, ...patch} : scene);
  return validateProject(project);
}

export function splitScene(input, id, localSeconds) {
  const project = validateProject(input);
  const index = project.scenes.findIndex(scene => scene.id === id);
  if (index < 0) fail('나눌 장면을 선택해 주세요.');
  const scene = project.scenes[index];
  if (!Number.isFinite(localSeconds) || localSeconds < 0.25 || scene.duration - localSeconds < 0.25) {
    fail('장면 양쪽에 최소 0.25초가 남는 위치에서 나눠 주세요.');
  }
  const ratio = localSeconds / scene.duration;
  const chars = Array.from(scene.caption);
  let cut = Math.round(chars.length * ratio);
  // Prefer a word boundary, while keeping every character and Unicode code point.
  const nearby = chars.map((char, at) => /\s/.test(char) ? at + 1 : -1)
    .filter(at => at > 0 && at < chars.length && Math.abs(at - cut) <= 12);
  if (nearby.length) cut = nearby.reduce((best, at) => Math.abs(at - cut) < Math.abs(best - cut) ? at : best);
  const first = {...scene, duration: localSeconds, caption: chars.slice(0, cut).join('')};
  const second = {...scene, id: createId('scene'), duration: scene.duration - localSeconds, caption: chars.slice(cut).join('')};
  if (scene.motion === 'custom') {
    first.endX = second.focusX = scene.focusX + (scene.endX - scene.focusX) * ratio;
    first.endY = second.focusY = scene.focusY + (scene.endY - scene.focusY) * ratio;
    first.zoomEnd = second.zoomStart = scene.zoomStart + (scene.zoomEnd - scene.zoomStart) * ratio;
  }
  project.scenes.splice(index, 1, first, second);
  return validateProject(project);
}

export function mergeScenes(input, ids) {
  const project = validateProject(input);
  const selected = selectedSceneIds(project, ids);
  if (selected.size < 2) fail('합칠 장면을 두 개 이상 선택해 주세요.');
  const indexes = project.scenes.map((scene, index) => selected.has(scene.id) ? index : -1).filter(index => index >= 0);
  if (indexes.at(-1) - indexes[0] + 1 !== indexes.length) fail('연속된 장면만 합칠 수 있습니다.');
  const scenes = indexes.map(index => project.scenes[index]);
  if (!scenes.every(scene => scene.imageId === scenes[0].imageId)) {
    fail('같은 이미지를 사용하는 연속 장면만 합칠 수 있습니다.');
  }
  const merged = {...scenes[0], duration: scenes.reduce((sum, scene) => sum + scene.duration, 0),
    caption: scenes.map(scene => scene.caption.trim()).filter(Boolean).join('\n')};
  if (merged.motion === 'custom') {
    merged.endX = scenes.at(-1).endX;
    merged.endY = scenes.at(-1).endY;
    merged.zoomEnd = scenes.at(-1).zoomEnd;
  }
  project.scenes.splice(indexes[0], scenes.length, merged);
  return validateProject(project);
}

/** Shift imported cues as a group: never clamp individual negative timestamps. */
export function shiftCaptions(cues, offset) {
  if (!Number.isFinite(offset)) fail('자막 이동 시간을 초 단위 숫자로 입력해 주세요.');
  if (!Array.isArray(cues)) fail('자막 목록을 확인해 주세요.');
  const shifted = cues.map(cue => ({...cue, start: cue.start + offset, end: cue.end + offset}));
  if (shifted.some(cue => cue.start < 0)) fail('자막 시작 시간이 0초보다 앞설 수 없습니다.');
  return validateProject(createProject({captions: shifted, captionMode: 'srt'})).captions;
}

/** SRT preserves timeline times; speech preserves source times; auto estimates text weights. */
export function getCaptions(project) {
  if (project?.captionMode === 'srt') return (project.captions || []).map(cue => ({...cue}));
  if (project?.captionMode === 'speech') {
    const analysis = project.captionAnalysis;
    const audio = project.audio || {};
    if (!analysis || audio.narrationId !== analysis.narrationId) return [];
    const trimStart = audio.narrationStart ?? 0;
    const trimEnd = audio.narrationEnd ?? analysis.sourceEnd;
    const offset = audio.narrationOffset ?? 0;
    const windowStart = Math.max(trimStart, analysis.sourceStart);
    const windowEnd = Math.min(trimEnd, analysis.sourceEnd);
    if (windowEnd <= windowStart) return [];
    return (project.captions || []).flatMap(cue => {
      const start = Math.max(cue.start, windowStart);
      const end = Math.min(cue.end, windowEnd);
      return end > start ? [{start: offset + start - trimStart, end: offset + end - trimStart, text: cue.text}] : [];
    });
  }
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
    ...(project.imageStudio?.references || []).map(reference => reference.assetId),
  ].filter(Boolean));
}

export function canonicalAssets(project, assets) {
  const result = [];
  let totalSize = 0, referenceSize = 0;
  const referenceIds = new Set((project.imageStudio?.references || []).map(reference => reference.assetId));
  const imageIds = new Set([
    ...project.scenes.map(scene => scene.imageId),
    ...referenceIds,
  ].filter(Boolean));
  for (const id of referencedAssetIds(project)) {
    const asset = assets instanceof Map ? assets.get(id) : assets[id];
    if (!asset?.blob || !(asset.blob instanceof Blob)) fail('프로젝트에 필요한 이미지 또는 음성 파일이 없습니다. 다시 첨부해 주세요.');
    const type = asset.blob.type || asset.type || '';
    const image = imageIds.has(id);
    if (image && !/^image\/(png|jpeg|webp|gif|avif|bmp|svg\+xml)$/i.test(type)) fail('지원하지 않는 이미지 파일 형식입니다.');
    if (!image && !/^audio\//i.test(type) && !['video/mp4', 'video/webm', 'application/octet-stream', ''].includes(type)) fail('지원하지 않는 음성 파일 형식입니다.');
    if (referenceIds.has(id)) {
      if (asset.blob.size > MAX_REFERENCE_FILE_BYTES) fail('레퍼런스 이미지 한 장은 10MB 이하로 넣어주세요.');
      referenceSize += asset.blob.size;
      if (referenceSize > MAX_REFERENCE_BYTES) fail('고정 레퍼런스 이미지 합계는 20MB 이하로 줄여 주세요.');
    }
    totalSize += asset.blob.size;
    if (totalSize > MAX_ASSET_BYTES) fail('프로젝트 미디어 합계는 180MB 이하로 줄여 주세요.');
    result.push({id, blob: asset.blob, name: String(asset.name || 'asset').slice(0, 300), type});
  }
  return result;
}

export function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('이 브라우저에서는 자동 저장을 사용할 수 없습니다. 프로젝트 파일로 저장해 주세요.')); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let failed = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('library')) db.createObjectStore('library', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('libraryMeta')) db.createObjectStore('libraryMeta', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('workspaceMeta')) db.createObjectStore('workspaceMeta');
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) {db.close();return;}
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {failed = true;reject(new Error('자동 저장 공간을 열지 못했습니다. 프로젝트 파일로 저장해 주세요.'));};
    request.onblocked = () => {failed = true;reject(new Error('다른 탭에서 편집기를 닫은 뒤 다시 저장해 주세요.'));};
  });
}

export function transactionResult(transaction, db) {
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

/** Named projects are independent of the current autosave and keep raw Blobs. */
export async function saveLibraryProject(input, assets, {thumbnail = ''} = {}) {
  const project = validateProject(input);
  const records = canonicalAssets(project, assets);
  if (typeof thumbnail !== 'string' || thumbnail.length > 2 * 1024 * 1024 ||
      (thumbnail && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(thumbnail))) {
    fail('프로젝트 미리보기 이미지를 확인해 주세요.');
  }
  const updatedAt = new Date().toISOString();
  const metadata = {id: project.id, title: project.title, sceneCount: project.scenes.length,
    duration: getTimeline(project).duration, updatedAt, thumbnail};
  const db = await openDatabase();
  const transaction = db.transaction(['library', 'libraryMeta'], 'readwrite');
  const result = transactionResult(transaction, db);
  transaction.objectStore('library').put({id: project.id, project, assets: records, updatedAt});
  transaction.objectStore('libraryMeta').put(metadata);
  await result;
  return metadata;
}

export async function listLibraryProjects() {
  const db = await openDatabase();
  const transaction = db.transaction('libraryMeta', 'readonly');
  const result = transactionResult(transaction, db);
  let entries = [];
  const request = transaction.objectStore('libraryMeta').getAll();
  request.onsuccess = () => { entries = request.result; };
  await result;
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadLibraryProject(id) {
  validId(id, false, '프로젝트');
  const db = await openDatabase();
  const transaction = db.transaction('library', 'readonly');
  const result = transactionResult(transaction, db);
  let record;
  const request = transaction.objectStore('library').get(id);
  request.onsuccess = () => { record = request.result; };
  await result;
  if (!record) fail('보관함에서 프로젝트를 찾을 수 없습니다.');
  const project = validateProject(record.project);
  const assets = new Map(record.assets.map(({id: assetId, ...asset}) => [assetId, asset]));
  canonicalAssets(project, assets);
  return {project, assets, savedAt: record.updatedAt};
}

export async function deleteLibraryProject(id) {
  validId(id, false, '프로젝트');
  const db = await openDatabase();
  const transaction = db.transaction(['library', 'libraryMeta'], 'readwrite');
  const result = transactionResult(transaction, db);
  transaction.objectStore('library').delete(id);
  transaction.objectStore('libraryMeta').delete(id);
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
  if (!Array.isArray(data.assets) || data.assets.length > 207) fail('프로젝트 미디어 목록이 올바르지 않습니다.');
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
