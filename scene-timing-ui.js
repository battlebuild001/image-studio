import {planTimedScenes, narrationPlanKey, scriptLength} from './script-planning.js';

const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const basisNames = {target: '지정한 목표 길이', narration: '내레이션의 실제 길이', current: '현재 영상의 길이', estimated: '대본 글자 수로 추정한 길이'};
const compact = value => String(value || '').normalize('NFC').replace(/\u0000|\s/gu, '');

function timestamp(value) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const minutes = Math.floor(milliseconds / 60000), seconds = (milliseconds % 60000) / 1000;
  const formatted = seconds.toFixed(3).replace(/0+$/u, '').replace(/\.$/u, '');
  return `${String(minutes).padStart(2, '0')}:${formatted.padStart(seconds < 10 ? formatted.includes('.') ? formatted.length + 1 : 2 : formatted.length, '0')}`;
}
function node(tag, className, text) {
  const value = document.createElement(tag);if (className) value.className = className;
  if (text !== undefined) value.textContent = text;return value;
}
function excerpt(value, maximum = 240) {
  const text = Array.from(String(value || ''));
  return text.length > maximum ? `${text.slice(0, maximum).join('')}…` : text.join('');
}

/** Preview only: no project mutation, media upload, or paid request occurs here. */
export function setupSceneTimingUi(api) {
  if (!$('sceneTimingStyles')) {
    const link = node('link');link.id = 'sceneTimingStyles';link.rel = 'stylesheet';
    link.href = new URL('./scene-timing-ui.css', import.meta.url).href;document.head.append(link);
  }
  const fields = {text: $('scriptText'), interval: $('imageChangeInterval'), goal: $('scriptGoalMinutes'),
    useGoal: $('scriptUseDuration'), keepImages: $('keepImages')};
  const summary = $('sceneTimingSummary'), basisText = $('sceneTimingBasis'), replaceNote = $('sceneTimingReplaceNote');
  const preview = $('sceneTimingPreview'), error = $('sceneTimingError'), confirm = $('applyScriptBtn');
  let preferExistingTimeline = false, cachedSignature = '', cached = null, cachedError = null, captionTiming = false;

  function inputs() {
    const project = api.getProject(), text = fields.text.value;
    const pace = project.scriptDraft?.charsPerMinute || 330;
    const characters = scriptLength(text, pace).characters;
    const intervalSeconds = Number(fields.interval.value);
    let totalSeconds, basis;
    if (fields.useGoal.checked) {
      const minutes = Number(fields.goal.value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) throw new Error('목표 분량은 1~60분 사이의 정수로 정해 주세요.');
      totalSeconds = minutes * 60;basis = 'target';
    } else {
      const narration = Number(api.getNarrationDuration?.() || 0);
      const existing = (project.scenes || []).reduce((sum, scene) => sum + scene.duration, 0);
      if (narration > 0) {totalSeconds = narration;basis = 'narration';}
      else if (preferExistingTimeline && existing > 0) {totalSeconds = existing;basis = 'current';}
      else {totalSeconds = Math.min(3600, Math.max(.25, characters / pace * 60));basis = 'estimated';}
    }
    const cues = api.getTimedCaptions?.() || [];
    const timedCaptions = ['narration', 'current'].includes(basis) && Array.isArray(cues) && cues.length &&
      compact(text) && compact(cues.map(cue => cue.text).join('')) === compact(text) &&
      cues.every(cue => typeof cue.text === 'string' && Number.isFinite(cue.start) && Number.isFinite(cue.end) &&
        cue.start >= 0 && cue.end > cue.start && cue.end <= totalSeconds + .001)
      ? cues.map(({start, end, text}) => ({start, end, text})) : [];
    return {project, text, characters, intervalSeconds, totalSeconds, basis, timedCaptions, narrationKey: narrationPlanKey(project)};
  }
  function prepare() {
    const input = inputs();
    const signature = JSON.stringify({project: input.project.id, scenes: input.project.scenes, text: input.text,
      interval: input.intervalSeconds, duration: input.totalSeconds, basis: input.basis,
      narrationKey: input.narrationKey, timedCaptions: input.timedCaptions, keepImages: fields.keepImages.checked});
    if (signature === cachedSignature) {if (cachedError) throw cachedError;return cached;}
    cachedSignature = signature;cached = null;cachedError = null;
    try {
      const planned = planTimedScenes(input.text, input.project.scenes, {intervalSeconds: input.intervalSeconds,
        totalSeconds: input.totalSeconds, targetBasis: input.basis, keepImages: fields.keepImages.checked, timedCaptions: input.timedCaptions});
      captionTiming = input.timedCaptions.length > 0;
      cached = {scenes: planned.scenes, scenePlan: {version: 1, intervalSeconds: planned.intervalSeconds,
        durationSeconds: planned.durationSeconds, basis: planned.basis, sourceScript: planned.sourceScript,
        narrationKey: input.narrationKey, items: planned.items}};
      return cached;
    } catch (cause) {cachedError = cause;throw cause;}
  }
  function renderPreview(value) {
    const plan = value.scenePlan, project = api.getProject();
    summary.textContent = `총 ${timestamp(plan.durationSeconds)} · ${plan.intervalSeconds}초마다 전환 · 이미지 ${plan.items.length}장`;
    basisText.textContent = `${basisNames[plan.basis] || '선택한 길이'}를 기준으로 나눴어요. ${captionTiming ? '대본과 일치하는 음성 분석·SRT의 실제 시간을 사용했어요.' : '대본 구간은 글자 수에 따른 추정이에요.'} 마지막 장면은 남은 시간만 표시합니다.`;
    const previousImages = project.scenes.filter(scene => scene.imageId).length;
    const retainedImages = value.scenes.filter(scene => scene.imageId).length;
    replaceNote.textContent = project.scenes.length
      ? `확정하면 기존 ${project.scenes.length}개 장면을 ${plan.items.length}개로 바꿔요.${previousImages ? ` 기존 이미지 ${previousImages}장 중 ${retainedImages}장을 순서대로 유지해요.` : ''} 지금은 기존 작업이 그대로 있어요.`
      : '확정해야 시간표에 맞춘 장면이 만들어져요. 이미지는 아직 생성하지 않습니다.';
    const rows = plan.items.map((item, index) => {
      const row = node('li', 'scene-timing-row');row.dataset.sceneId = item.sceneId;
      row.append(node('span', 'scene-timing-number', String(index + 1).padStart(2, '0')),
        node('span', 'scene-timing-range', `${timestamp(item.start)} → ${timestamp(item.end)}`));
      const content = node('div', 'scene-timing-content');
      content.append(node('p', 'scene-timing-caption', excerpt(item.caption) || '이 구간에는 대본이 없어요. 이미지 요청에서 내용을 정할 수 있어요.'));
      const details = node('details', 'scene-timing-prompt');details.append(node('summary', '', '이 구간의 이미지 요청 미리보기'), node('p', '', item.prompt));content.append(details);row.append(content);return row;
    });
    preview.replaceChildren(...rows);preview.dataset.sceneCount = String(plan.items.length);
  }
  function refresh() {
    fields.goal.disabled = !fields.useGoal.checked;
    const pace = api.getProject().scriptDraft?.charsPerMinute || 330, stats = scriptLength(fields.text.value, pace);
    $('scriptStats').textContent = `${stats.characters.toLocaleString()}자 · 약 ${stats.estimatedMinutes.toFixed(1)}분 (추정)`;
    for (const preset of document.querySelectorAll('[data-image-interval]')) {
      preset.setAttribute('aria-pressed', String(Number(preset.dataset.imageInterval) === Number(fields.interval.value)));
    }
    try {
      const value = prepare();error.textContent = '';confirm.disabled = false;renderPreview(value);return value;
    } catch (cause) {
      error.textContent = cause?.message || '대본과 이미지 전환 간격을 확인해 주세요.';
      summary.textContent = '전환 시간표를 아직 확정할 수 없어요.';basisText.textContent = '';replaceNote.textContent = '';
      preview.replaceChildren();preview.dataset.sceneCount = '0';confirm.disabled = true;return null;
    }
  }
  function getPlan() {return clone(prepare());}
  function reset(options = {}) {
    preferExistingTimeline = options.preferExistingTimeline === true;
    fields.interval.value = String(api.getProject().scenePlan?.intervalSeconds || 10);
    cachedSignature = '';cached = null;cachedError = null;return refresh();
  }
  for (const input of Object.values(fields)) for (const event of ['input', 'change']) input.addEventListener(event, refresh);
  for (const preset of document.querySelectorAll('[data-image-interval]')) preset.addEventListener('click', () => {
    fields.interval.value = preset.dataset.imageInterval;refresh();
  });
  refresh();return {refresh, getPlan, reset};
}
