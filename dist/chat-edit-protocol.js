/** Bounded, executable data for reviewed chat edits; never executable model code. */
const ID = /^[A-Za-z0-9_-]{1,180}$/u;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => {throw new Error(message || 'AI 편집안의 형식이나 범위를 확인하지 못했어요. 원래 영상은 유지했어요.');};
const sameKeys = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const text = (value, max, required = false) => {if (typeof value !== 'string' || Array.from(value).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || required && !value.trim()) fail();return value;};
const number = (value, min, max) => {if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail();return value;};
const bool = value => {if (typeof value !== 'boolean') fail();return value;};
const choice = values => value => {if (!values.includes(value)) fail();return value;};
const bounded = (min, max) => value => number(value, min, max);
const color = value => {if (typeof value !== 'string' || !/^#[A-Fa-f0-9]{6}$/u.test(value)) fail();return value.toLowerCase();};

export const CHAT_SCENE_FIELDS = Object.freeze({
  duration: bounded(.25, 600), motion: choice(['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'subtle-zoom', 'subtle-drift', 'none', 'custom']),
  fit: choice(['cover', 'contain']), focusX: bounded(0, 1), focusY: bounded(0, 1), endX: bounded(0, 1), endY: bounded(0, 1),
  zoomStart: bounded(1, 3), zoomEnd: bounded(1, 3), effect: choice(['none', 'dust', 'fog', 'light']), effectIntensity: bounded(0, 1), exposure: bounded(-1, 1),
});
export const CHAT_SETTING_FIELDS = Object.freeze({
  subtitles: bool, branding: bool, fontSize: bounded(20, 100), captionFont: choice(['sans', 'serif', 'mono']), captionColor: color,
  captionBackground: color, captionOpacity: bounded(0, 1), captionStroke: color, captionStrokeWidth: bounded(0, 8),
  captionPosition: choice(['top', 'center', 'bottom']), transition: bounded(0, 3), bgmVolume: bounded(0, 1), narrationVolume: bounded(0, 2), ducking: bool,
});
const fieldType = name => ['motion', 'fit', 'effect', 'captionFont', 'captionColor', 'captionBackground', 'captionStroke', 'captionPosition'].includes(name) ? 'string' : ['subtitles', 'branding', 'ducking'].includes(name) ? 'boolean' : 'number';
const object = properties => ({type: 'object', additionalProperties: false, properties, required: Object.keys(properties)});
const nullablePatch = fields => object(Object.fromEntries(Object.keys(fields).map(name => [name, {type: [fieldType(name), 'null']}])));
export const CHAT_EDIT_SCHEMA = object({
  summary: {type: 'string'},
  operations: {type: 'array', items: {anyOf: [
    object({type: {type: 'string', enum: ['scene']}, sceneId: {type: 'string'}, patch: nullablePatch(CHAT_SCENE_FIELDS)}),
    object({type: {type: 'string', enum: ['settings']}, patch: nullablePatch(CHAT_SETTING_FIELDS)}),
    object({type: {type: 'string', enum: ['trim-start']}, seconds: {type: 'number'}}),
  ]}},
  notes: {type: 'array', items: {type: 'string'}},
});
export const CHAT_EDIT_INSTRUCTIONS = `영상의 실제 설정을 바꾸기 위한 검토용 편집안을 작성하세요. 실제 변경/업로드/이미지생성/음성합성은 실행하지 않습니다. context.instruction의 요청만 반영하고 제공된 scene id와 허용된 속성만 사용하세요. operations는 최대30개입니다. scene의 patch는 명시적으로 바꿀 속성만 값을 넣고 나머지 모두 null, settings patch도 같습니다. 어둡게/밝게는 scene.exposure(-1~1, 0기본, 음수어둡게)로, 확대/이동은 실제motion/focusX/focusY/endX/endY/zoomStart/zoomEnd로 표현하세요. caption이나 대본, 제목, 이미지/음성 asset id, URL, 키, 임의 코드, 프로젝트삭제는 바꿀 수 없습니다. 단순 scene duration은 내레이션이 없는 영상에서만 변경할 수 있습니다. 내레이션이 있는 영상의 시작 구간 삭제는 trim-start seconds 한 개로 표현합니다. trim-start는 전체영상 0초부터 해당 초까지(인트로 포함) 제거하며 원본음성과 남은자막도 같이 잘라 보존합니다. trim-start와 scene.duration 변경을 섞지 마세요. 같은 속성을 두 번 수정하거나 제거될 장면을 수정하지 마세요. settings는 실제 글꼴/색상/위치/전환/음량과 표시만 바꿉니다. 지시가 모호하면 과도한 변경을 만들지 말고 notes에 필요한 구체화를 설명하세요. 지원하지 않는 요청은 operations:[]와 notes의 설명으로 답하세요. summary와 notes는 한국어로 쓰고 사실상 지원되지 않는 작업을 완료했다고 주장하지 마세요. 모든 계획은 사용자가 전후 차이를 확인하고 적용 버튼을 눌러야 실행됩니다.`;

export function validateChatEditInput(context, options = {}, images = []) {
  if (!sameKeys(context, ['projectId', 'title', 'aspect', 'durationSeconds', 'selectedSceneIds', 'scenes', 'settings', 'audio', 'instruction']) || typeof context.projectId !== 'string' || !ID.test(context.projectId) || !['16:9', '9:16'].includes(context.aspect)) fail('편집할 프로젝트와 화면 비율을 확인해 주세요.');
  text(context.title, 200);text(context.instruction, 4000, true);number(context.durationSeconds, .25, 3600);
  if (!sameKeys(options, []) || !Array.isArray(images) || images.length) fail('채팅 편집은 실제 설정 자료만 사용해요. 이미지나 추가 옵션은 전송하지 않아요.');
  if (!Array.isArray(context.scenes) || !context.scenes.length || context.scenes.length > 200) fail('편집할 장면을 먼저 만들어 주세요.');
  const ids = new Set();let previousEnd = 0;
  for (const scene of context.scenes) {
    if (!sameKeys(scene, ['id', 'start', 'end', 'caption', ...Object.keys(CHAT_SCENE_FIELDS)]) || typeof scene.id !== 'string' || !ID.test(scene.id) || ids.has(scene.id)) fail();
    ids.add(scene.id);text(scene.caption, 20000);number(scene.start, 0, 3600);number(scene.end, .25, 3600);
    if (Math.abs(scene.start - previousEnd) > .00001 || Math.abs(scene.end - scene.start - scene.duration) > .00001) fail('편집 요청의 장면 시간표가 현재 영상과 달라요.');
    for (const [key, validate] of Object.entries(CHAT_SCENE_FIELDS)) validate(scene[key]);previousEnd = scene.end;
  }
  if (Math.abs(previousEnd - context.durationSeconds) > .00001 || !Array.isArray(context.selectedSceneIds) || context.selectedSceneIds.length > 200 || new Set(context.selectedSceneIds).size !== context.selectedSceneIds.length || context.selectedSceneIds.some(id => !ids.has(id))) fail();
  if (!sameKeys(context.settings, Object.keys(CHAT_SETTING_FIELDS))) fail();
  for (const [key, validate] of Object.entries(CHAT_SETTING_FIELDS)) validate(context.settings[key]);
  if (!sameKeys(context.audio, ['narration', 'bgm']) || typeof context.audio.narration !== 'boolean' || typeof context.audio.bgm !== 'boolean') fail();
  return context;
}
function patchValue(value, fields) {
  if (!sameKeys(value, Object.keys(fields))) fail('허용되지 않은 편집 속성이 포함되어 적용하지 않았어요.');
  const result = {};
  for (const [key, input] of Object.entries(value)) if (input !== null) result[key] = fields[key](input);
  if (!Object.keys(result).length) fail('실제 변경할 속성이 없는 편집안이에요.');
  return result;
}
export function normalizeChatEditResult(value, context) {
  if (!sameKeys(value, ['summary', 'operations', 'notes']) || !Array.isArray(value.operations) || value.operations.length > 30 || !Array.isArray(value.notes) || value.notes.length > 12) fail();
  const summary = text(value.summary, 4000, true), notes = value.notes.map(item => text(item, 1000, true)), known = new Map((context?.scenes || []).map(scene => [scene.id, scene]));
  const touched = new Set();let trimming = null, durations = false;
  const operations = value.operations.map(operation => {
    if (operation?.type === 'scene') {
      if (!sameKeys(operation, ['type', 'sceneId', 'patch']) || typeof operation.sceneId !== 'string' || !ID.test(operation.sceneId) || context && !known.has(operation.sceneId)) fail('현재 영상에 없는 장면을 수정하는 편집안은 적용하지 않았어요.');
      const patch = patchValue(operation.patch, CHAT_SCENE_FIELDS);
      for (const key of Object.keys(patch)) {const marker = `scene:${operation.sceneId}:${key}`;if (touched.has(marker)) fail('같은 장면 속성을 중복 수정하는 편집안이에요.');touched.add(marker);}
      if (patch.duration !== undefined) {durations = true;if (context?.audio?.narration) fail('내레이션이 있는 장면의 길이만 바꾸면 싱크가 달라져요. 시작 구간을 제거하거나 싱크 다시 맞추기를 사용해 주세요.');}
      return {type: 'scene', sceneId: operation.sceneId, patch};
    }
    if (operation?.type === 'settings') {
      if (!sameKeys(operation, ['type', 'patch'])) fail();const patch = patchValue(operation.patch, CHAT_SETTING_FIELDS);
      for (const key of Object.keys(patch)) {const marker = `settings:${key}`;if (touched.has(marker)) fail('같은 영상 설정을 중복 수정하는 편집안이에요.');touched.add(marker);}
      return {type: 'settings', patch};
    }
    if (operation?.type === 'trim-start') {
      if (!sameKeys(operation, ['type', 'seconds']) || trimming !== null) fail('시작 구간 자르기는 한 번만 지정할 수 있어요.');
      trimming = number(operation.seconds, .001, (context?.durationSeconds ?? 3600) - .25);return {type: 'trim-start', seconds: trimming};
    }
    fail('지원하지 않는 편집 작업이 포함되어 있어요. 원래 영상은 유지했어요.');
  });
  if (trimming !== null && durations) fail('시작 구간 자르기와 장면 길이 변경은 나누어 요청해 주세요.');
  if (trimming !== null && operations.some(operation => operation.type === 'scene' && known.get(operation.sceneId)?.end <= trimming + 1e-7)) fail('잘라낼 장면에 다른 편집이 포함되어 있어요. 편집안을 나누어 주세요.');
  if (context && durations) {
    let total = context.durationSeconds;
    for (const operation of operations) if (operation.type === 'scene' && operation.patch.duration !== undefined) total += operation.patch.duration - known.get(operation.sceneId).duration;
    if (total > 3600.00001) fail('변경 후 영상 길이가 60분을 넘어요.');
  }
  return {summary, operations, notes};
}
