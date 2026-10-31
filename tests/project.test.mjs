import assert from 'node:assert/strict';
import {test} from 'node:test';

const module = await import('../dist/project.js');
const {createProject, createScene, validateProject, parseSrt, exportSrt, splitScript,
  distributeDurations, getTimeline, getCaptions, exportProjectBackup, importProjectBackup,
  duplicateScenes, updateScenes, splitScene, mergeScenes, shiftCaptions, referencedAssetIds} = module;

test('new workspaces use a neutral default title while existing project titles survive validation and backup', async () => {
  assert.equal(createProject().title, '새 콘텐츠 프로젝트');
  const missingTitle = createProject();delete missingTitle.title;
  assert.equal(validateProject(missingTitle).title, '새 콘텐츠 프로젝트');
  for (const title of ['BLKOUT 설정 이야기', '사만 설정 정리', '에오지 이야기', '데이터 분석']) {
    const original = createProject({title});
    assert.equal(validateProject(original).title, title);
    const restored = await importProjectBackup(await exportProjectBackup(original, new Map()));
    assert.equal(restored.project.title, title);
    assert.equal(restored.project.schemaVersion, 1);
  }
});

test('weighted scene timing preserves exact audio length and minimums', () => {
  const scenes = [createScene({caption: '짧게.'}), createScene({caption: '이 문장은 더 길어서 더 많은 시간이 배분되어야 합니다.'}), createScene()];
  const result = distributeDurations(scenes, 31.257);
  assert.ok(Math.abs(result.reduce((sum, scene) => sum + scene.duration, 0) - 31.257) < 1e-10);
  assert.ok(result[1].duration > result[0].duration);
  assert.ok(result.every(scene => scene.duration >= 0.5));
  assert.equal(scenes[0].duration, 6, 'original scenes are not mutated');
  const equal = distributeDurations([createScene(), createScene(), createScene()], 30);
  assert.deepEqual(equal.map(scene => scene.duration), [10, 10, 10]);
  assert.throws(() => distributeDurations(scenes, 0.2), /너무 많/);
  assert.throws(() => distributeDurations([createScene()], 660), /장면을 추가/);
  const long = distributeDurations([createScene({caption: '긴 원고'.repeat(100)}), createScene()], 900);
  assert.deepEqual(long.map(scene => scene.duration), [600, 300]);
  assert.doesNotThrow(() => validateProject(createProject({scenes: long})));
});

test('SRT import keeps exact timestamps, multiline Korean, ordering, and 1ms export rounding', () => {
  const raw = '\uFEFF2\r\n00:00:04,125 --> 00:00:06,999\r\n둘째 자막\r\n\r\n1\r\n00:00:00,050 --> 00:00:02,333\r\n<b>블랙아웃</b>\r\n더스터 이야기\r\n';
  const cues = parseSrt(raw);
  assert.deepEqual(cues, [
    {start: 0.05, end: 2.333, text: '블랙아웃\n더스터 이야기'},
    {start: 4.125, end: 6.999, text: '둘째 자막'},
  ]);
  assert.deepEqual(parseSrt(exportSrt(cues)), cues);
  assert.throws(() => parseSrt('1\n00:00:05,000 --> 00:00:02,000\n역전'), /종료 시각/);
  assert.throws(() => parseSrt('1\n00:72:05,000 --> 00:72:06,000\n잘못된 시간'), /00~59/);
  assert.throws(() => parseSrt('안녕하세요'), /시각/);
});

test('script segmentation is bounded and preserves all source words', () => {
  const text = '첫 번째 문장입니다. 두 번째 문장도 이어집니다. 아주아주길게붙여쓴문장도누락하지않고잘라야합니다.\n다음 장면입니다.';
  const chunks = splitScript(text, {maxChars: 18});
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 18));
  assert.equal(chunks.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
  assert.equal(chunks.at(-1), '다음 장면입니다.');
});

test('automatic captions stay within their scene, preserve text, and SRT ignores automatic weighting', () => {
  const project = createProject({scenes: [
    createScene({duration: 9.3, caption: '이 장면은 길이가 긴 한국어 대본으로 되어 있습니다. 장면의 마지막까지 자막이 올바른 순서로 배분되어야 합니다.'}),
    createScene({duration: 5.1, caption: '둘째 장면입니다.'}),
  ]});
  assert.equal(getTimeline(project).duration, 14.4);
  const cues = getCaptions(project);
  assert.equal(cues[0].start, 0);
  assert.equal(cues.at(-1).end, 14.4);
  for (let index = 1; index < cues.length; index++) assert.ok(Math.abs(cues[index].start - cues[index - 1].end) < 1e-10);
  assert.equal(cues.map(cue => cue.text).join('').replace(/\s/g, ''), project.scenes.map(scene => scene.caption).join('').replace(/\s/g, ''));
  project.captionMode = 'srt';
  project.captions = [{start: 2.2, end: 6.4, text: '직접 맞춘 자막'}];
  assert.deepEqual(getCaptions(project), project.captions);
  assert.notEqual(getCaptions(project), project.captions);
});

function speechProject(overrides = {}) {
  return createProject({
    scenes: [createScene({duration: 30, caption: '시간 추정 대본은 음성 자막에 사용하지 않습니다.'})],
    captionMode: 'speech',
    captions: [
      {start: 11, end: 12.5, text: '첫 번째 발화'},
      {start: 14.25, end: 16.75, text: '두 번째 발화'},
      {start: 18.5, end: 20, text: '마지막 발화'},
    ],
    captionAnalysis: {narrationId: 'speech-audio', sourceStart: 10, sourceEnd: 22,
      language: 'ko', model: 'whisper-1', granularity: 'word', createdAt: '2026-10-29T10:20:30.000Z'},
    audio: {narrationId: 'speech-audio', narrationStart: 10, narrationEnd: 22, narrationOffset: 3},
    ...overrides,
  });
}

test('speech captions retain source timestamps while trim and narration delay remap timeline cues', () => {
  const project = validateProject(speechProject());
  const original = structuredClone(project.captions);
  assert.deepEqual(getCaptions(project), [
    {start: 4, end: 5.5, text: '첫 번째 발화'},
    {start: 7.25, end: 9.75, text: '두 번째 발화'},
    {start: 11.5, end: 13, text: '마지막 발화'},
  ]);
  project.audio.narrationStart = 12;
  project.audio.narrationEnd = 19;
  project.audio.narrationOffset = 1.5;
  assert.deepEqual(getCaptions(project), [
    {start: 1.5, end: 2, text: '첫 번째 발화'},
    {start: 3.75, end: 6.25, text: '두 번째 발화'},
    {start: 8, end: 8.5, text: '마지막 발화'},
  ]);
  assert.deepEqual(project.captions, original, 'source times never stretch or mutate');
  const srt = parseSrt(exportSrt(project));
  assert.deepEqual(srt, getCaptions(project), 'SRT uses the remapped video timeline');
  project.audio.narrationOffset += 4;
  assert.equal(getCaptions(project)[0].start, 5.5, 'prepended cards move captions with the narration offset');
});

test('speech caption expansion, silence and source replacement never invent timing or reuse a different voice', () => {
  const project = validateProject(speechProject());
  project.audio.narrationStart = 5;
  project.audio.narrationEnd = 30;
  project.audio.narrationOffset = 0;
  assert.deepEqual(getCaptions(project), project.captions.map(cue => ({...cue, start: cue.start - 5, end: cue.end - 5})),
    'expanding the trim retains only analyzed speech at its true position');
  project.audio.narrationEnd = null;
  assert.equal(getCaptions(project).at(-1).end, 15);
  project.audio.narrationStart = 21;
  project.audio.narrationEnd = 22;
  assert.deepEqual(getCaptions(project), [], 'a silent trim does not get synthetic scene-text captions');
  project.audio.narrationStart = 10;
  project.audio.narrationId = 'replacement-audio';
  assert.deepEqual(getCaptions(project), [], 'old captions are hidden when the narration is replaced');
  assert.deepEqual([...referencedAssetIds(project)], ['replacement-audio'], 'analysis metadata does not retain removed audio');
  project.audio.narrationId = null;
  assert.deepEqual(getCaptions(project), []);
});

test('speech metadata and source cues survive portable backups without changing the schema version', async () => {
  const project = speechProject();
  const assets = new Map([['speech-audio', {name: 'speech.wav', blob: new Blob(['RIFFtestaudio'], {type: 'audio/wav'})}]]);
  const loaded = await importProjectBackup(await exportProjectBackup(project, assets));
  assert.equal(loaded.project.schemaVersion, 1);
  assert.deepEqual(loaded.project, validateProject(project));
  assert.deepEqual(loaded.project.captions, project.captions);
  assert.deepEqual(getCaptions(loaded.project), getCaptions(project));
  assert.equal(await loaded.assets.get('speech-audio').blob.text(), 'RIFFtestaudio');
  const manual = structuredClone(project);
  manual.captionMode = 'srt';
  manual.captions = getCaptions(project);
  assert.equal(validateProject(manual).captionAnalysis, null, 'manual Apply drops the source-time interpretation');
  assert.deepEqual(getCaptions(validateProject(manual)), getCaptions(project));
  manual.captionMode = 'auto';
  assert.equal(validateProject(manual).captionAnalysis, null);
});

test('speech analysis requires bounded source coordinates and complete valid provenance', () => {
  assert.throws(() => validateProject(speechProject({captionAnalysis: null})), /분석 정보/);
  for (const mutation of [
    p => {p.captionAnalysis.sourceStart = undefined;},
    p => {p.captionAnalysis.sourceEnd = 10;},
    p => {p.captionAnalysis.sourceEnd = Infinity;},
    p => {p.captionAnalysis.sourceEnd = 86401;},
    p => {p.captionAnalysis.narrationId = '../unsafe';},
    p => {p.captionAnalysis.language = '';},
    p => {p.captionAnalysis.model = '';},
    p => {p.captionAnalysis.granularity = 'estimated';},
    p => {p.captionAnalysis.createdAt = 'tomorrow';},
    p => {p.captions[0].start = 9.999;},
    p => {p.captions.at(-1).end = 22.001;},
  ]) {
    const project = speechProject();
    mutation(project);
    assert.throws(() => validateProject(project));
  }
  assert.equal(validateProject(speechProject({captions: []})).captions.length, 0, 'silent analysis can remain empty');
  assert.equal(validateProject(createProject()).captionAnalysis, null);
});

test('portable backup roundtrips binary images/audio and trims unused assets', async () => {
  const project = createProject({scenes: [createScene({imageId: 'image-one', caption: '<img src=x onerror=alert(1)>표시 문자열'})], audio: {narrationId: 'voice-one'}});
  const pixels = new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2, 3]);
  const samples = new Uint8Array([82, 73, 70, 70, 255, 254, 0, 1]);
  const assets = new Map([
    ['image-one', {name: '사진.png', blob: new Blob([pixels], {type: 'image/png'})}],
    ['voice-one', {name: '목소리.wav', blob: new Blob([samples], {type: 'audio/wav'})}],
    ['unused-image', {name: 'unused', blob: new Blob(['unused'], {type: 'image/png'})}],
  ]);
  const blob = await exportProjectBackup(project, assets);
  const loaded = await importProjectBackup(blob);
  assert.deepEqual(loaded.project, validateProject(project));
  assert.equal(loaded.assets.size, 2);
  assert.equal(loaded.assets.get('image-one').name, '사진.png');
  assert.deepEqual(new Uint8Array(await loaded.assets.get('image-one').blob.arrayBuffer()), pixels);
  assert.deepEqual(new Uint8Array(await loaded.assets.get('voice-one').blob.arrayBuffer()), samples);
  assert.equal(loaded.project.scenes[0].caption, project.scenes[0].caption, 'plain text stays plain text; UI must use textContent');
});

test('corrupt media, invalid schemas and duplicate scene IDs are rejected', async () => {
  const project = createProject({scenes: [createScene({imageId: 'image-one'})]});
  await assert.rejects(exportProjectBackup(project, new Map()), /필요한 이미지/);
  const doc = {kind: 'bth-image-studio', version: 1, project, assets: [{id: 'image-one', type: 'image/png', data: '!bad'}]};
  await assert.rejects(importProjectBackup(doc), /손상/);
  doc.assets[0].data = btoa('hello');
  doc.assets[0].type = 'text/html';
  await assert.rejects(importProjectBackup(doc), /이미지 파일 형식/);
  assert.throws(() => validateProject({...project, schemaVersion: 9}), /지원/);
  assert.throws(() => validateProject({...project, scenes: [project.scenes[0], project.scenes[0]]}), /중복/);
});

test('old version-one backups gain safe defaults without changing media or SRT timing', async () => {
  const oldProject = {
    schemaVersion: 1, id: 'old-project', title: '이전 작업', aspect: '16:9',
    scenes: [{id: 'old-scene', duration: 6, caption: '이전 대본', imageId: 'old-image', motion: 'none', fit: 'cover'}],
    settings: {fontSize: 42}, audio: {}, captionMode: 'srt',
    captions: [{start: 0.125, end: 5.987, text: '정확한 시간'}],
  };
  const legacy = {kind: 'bth-image-studio', version: 1, project: oldProject,
    assets: [{id: 'old-image', name: 'old.png', type: 'image/png', data: btoa('old-pixels')}]};
  const loaded = await importProjectBackup(legacy);
  assert.equal(loaded.project.schemaVersion, 1);
  assert.deepEqual(loaded.project.captions, oldProject.captions);
  assert.equal(loaded.project.scenes[0].focusX, 0.5);
  assert.equal(loaded.project.scenes[0].zoomEnd, 1.12);
  assert.equal(loaded.project.settings.captionColor, '#ffffff');
  assert.equal(loaded.project.settings.ducking, false);
  assert.equal(loaded.project.audio.narrationStart, 0);
  assert.equal(loaded.project.audio.narrationEnd, null);
  assert.equal(loaded.project.audio.narrationOffset, 0);
  assert.equal(loaded.project.scriptDraft, null);
  assert.deepEqual(loaded.project.imageStudio, {background: '', style: '', negativePrompt: '', prompt: '',
    size: '1536x864', quality: 'medium', references: []});
  const restored = await importProjectBackup(await exportProjectBackup(loaded.project, loaded.assets));
  assert.deepEqual(restored.project, loaded.project);
  assert.equal(await restored.assets.get('old-image').blob.text(), 'old-pixels');
});

test('custom framing, caption styles and audio trims survive validation and backup', async () => {
  const project = createProject({scenes: [createScene({imageId: 'image', motion: 'custom',
    focusX: 0.1, focusY: 0.2, endX: 0.9, endY: 0.8, zoomStart: 1.2, zoomEnd: 2.5})],
    settings: {captionFont: 'serif', captionColor: '#AABBCC', captionBackground: '#123456',
      captionOpacity: 0.25, captionStroke: '#778899', captionStrokeWidth: 3,
      captionPosition: 'top', bgmFadeIn: 1.5, bgmFadeOut: 2, ducking: true},
    audio: {narrationId: 'voice', narrationStart: 1.25, narrationEnd: 5.75, narrationOffset: 2.5, bgmStart: 2, bgmEnd: 10}});
  const assets = new Map([['image', {blob: new Blob(['pixels'], {type: 'image/png'})}],
    ['voice', {blob: new Blob(['samples'], {type: 'audio/wav'})}]]);
  const restored = await importProjectBackup(await exportProjectBackup(project, assets));
  assert.deepEqual(restored.project, validateProject(project));
  assert.equal(restored.project.settings.captionColor, '#aabbcc');
  assert.equal(restored.project.audio.narrationOffset, 2.5);
  for (const value of [-0.1, 1.1, NaN, '0.5']) {
    assert.throws(() => validateProject({...project, scenes: [{...project.scenes[0], focusX: value}]}));
  }
  for (const patch of [{captionColor: 'red'}, {captionBackground: 'url(x)'},
    {captionFont: 'arbitrary-font'}, {captionPosition: 'outside'}, {captionOpacity: 2},
    {captionStrokeWidth: 9}, {bgmFadeIn: -1}, {ducking: 'true'}]) {
    assert.throws(() => validateProject({...project, settings: {...project.settings, ...patch}}));
  }
  for (const audio of [{narrationStart: -1}, {narrationStart: 5, narrationEnd: 5},
    {bgmStart: 10, bgmEnd: 2}, {narrationEnd: Infinity}, {narrationOffset: -1},
    {narrationOffset: 3600.01}, {narrationOffset: NaN}, {narrationOffset: '2.5'}]) {
    assert.throws(() => validateProject({...project, audio: {...project.audio, ...audio}}));
  }
});

test('duplicate and bulk edit are immutable, preserve original IDs and obey project limits', () => {
  const project = createProject({scenes: [createScene({id: 'one', imageId: 'image', duration: 3}),
    createScene({id: 'two', imageId: 'image', duration: 4})]});
  const before = structuredClone(project);
  const result = duplicateScenes(project, ['one', 'two']);
  assert.equal(result.scenes.length, 4);
  assert.equal(new Set(result.scenes.map(scene => scene.id)).size, 4);
  assert.equal(result.scenes[0].id, 'one');
  assert.equal(result.scenes[2].id, 'two');
  assert.equal(result.scenes[1].imageId, 'image');
  const changed = updateScenes(result, ['one', 'two'], {duration: 7.25, motion: 'pan-left', fit: 'contain'});
  assert.equal(changed.scenes[0].duration, 7.25);
  assert.equal(changed.scenes[2].motion, 'pan-left');
  assert.equal(changed.scenes[1].duration, 3, 'unselected clone keeps its settings');
  assert.deepEqual(project, before);
  assert.throws(() => updateScenes(project, ['one'], {duration: 0.1}));
  assert.throws(() => updateScenes(project, ['one'], {id: 'rewritten'}));
  assert.throws(() => duplicateScenes(project, ['missing']), /선택/);
  const full = createProject({scenes: Array.from({length: 200}, () => createScene({duration: 1}))});
  assert.throws(() => duplicateScenes(full, [full.scenes[0].id]), /200/);
  const long = createProject({scenes: Array.from({length: 6}, () => createScene({duration: 600}))});
  assert.throws(() => duplicateScenes(long, [long.scenes[0].id]), /60분/);
});

test('split and merge preserve total duration, image references, Unicode and exact SRT cues', () => {
  const scene = createScene({id: 'one', imageId: 'same', duration: 9.75,
    caption: '첫 번째 문장입니다. 두 번째 🛰️ 문장입니다.', motion: 'custom',
    focusX: 0.2, endX: 0.8, zoomStart: 1, zoomEnd: 2});
  const project = createProject({scenes: [scene], captionMode: 'srt',
    captions: [{start: 0.1, end: 9.55, text: '별도로 맞춘 자막'}]});
  const divided = splitScene(project, 'one', 3.25);
  assert.equal(divided.scenes.length, 2);
  assert.equal(getTimeline(divided).duration, 9.75);
  assert.equal(divided.scenes[0].caption + divided.scenes[1].caption, scene.caption);
  assert.equal(divided.scenes[0].endX, divided.scenes[1].focusX);
  assert.equal(divided.scenes[0].zoomEnd, divided.scenes[1].zoomStart);
  assert.deepEqual(divided.captions, project.captions);
  const joined = mergeScenes(divided, divided.scenes.map(item => item.id));
  assert.equal(joined.scenes.length, 1);
  assert.equal(joined.scenes[0].duration, 9.75);
  assert.equal(joined.scenes[0].imageId, 'same');
  assert.equal(joined.scenes[0].endX, 0.8);
  assert.deepEqual(joined.captions, project.captions);
  assert.throws(() => splitScene(project, 'one', 0.1), /0.25/);
  assert.throws(() => splitScene(project, 'one', 9.6), /0.25/);
  const different = createProject({scenes: [createScene({id: 'a', imageId: 'a-image'}),
    createScene({id: 'b', imageId: 'b-image'}), createScene({id: 'c', imageId: 'a-image'})]});
  assert.throws(() => mergeScenes(different, ['a', 'b']), /같은 이미지/);
  assert.throws(() => mergeScenes(different, ['a', 'c']), /연속/);
  const tooLong = createProject({scenes: [createScene({id: 'a', duration: 400}), createScene({id: 'b', duration: 400})]});
  assert.throws(() => mergeScenes(tooLong, ['a', 'b']), /장면 길이/);
});

test('caption offset preserves gaps and lengths, rejecting negative time as one operation', () => {
  const cues = [{start: 0.25, end: 2.1, text: '첫째'}, {start: 2.5, end: 5.9, text: '둘째'}];
  const shifted = shiftCaptions(cues, 1.25);
  assert.deepEqual(shifted, [{start: 1.5, end: 3.35, text: '첫째'}, {start: 3.75, end: 7.15, text: '둘째'}]);
  assert.equal(cues[0].start, 0.25);
  assert.deepEqual(shiftCaptions(cues, -0.25)[0], {start: 0, end: 1.85, text: '첫째'});
  assert.throws(() => shiftCaptions(cues, -0.5), /0초/);
  assert.throws(() => shiftCaptions(cues, NaN));
  assert.deepEqual(shiftCaptions([], 1), []);
});

function scriptDraftFixture(overrides = {}) {
  return {
    sourceText: '제공한 설정 자료\n둘째 문단입니다.',
    instructions: '공식 자료를 우선하고 확인되지 않은 설정은 따로 적어 주세요.',
    targetMinutes: 8,
    charsPerMinute: 330,
    result: {
      title: '블랙아웃 설정 소개', summary: '제공 자료와 웹 검색 자료를 정리했습니다.',
      script: '첫 번째 🛰️ 문장입니다.\n\n두 번째 문장입니다.',
      sources: [{title: '공식 설정 자료', url: 'https://example.com/lore?chapter=1'}],
      notes: ['고유명사의 표기를 확인해 주세요.'],
      targetMinutes: 8, charsPerMinute: 330,
      characters: 999999, estimatedMinutes: -5,
      searchedAt: '2026-10-29T08:30:00Z', webSearchUsed: true,
    },
    ...overrides,
  };
}

test('script research drafts roundtrip with evidence and recompute duration metrics', async () => {
  assert.equal(createProject().scriptDraft, null);
  const project = createProject({scriptDraft: scriptDraftFixture()});
  project.scriptDraft.apiKey = 'never-persist-this-test-value';
  project.scriptDraft.result.providerConfig = {key: 'also-not-saved'};
  const canonical = validateProject(project);
  const result = canonical.scriptDraft.result;
  const count = Array.from(result.script.replace(/\s/g, '')).length;
  assert.equal(result.characters, count);
  assert.equal(result.estimatedMinutes, count / 330);
  assert.equal(result.searchedAt, '2026-10-29T08:30:00.000Z');
  assert.equal(canonical.scriptDraft.apiKey, undefined);
  assert.equal(result.providerConfig, undefined);
  const restored = await importProjectBackup(await exportProjectBackup(project, new Map()));
  assert.deepEqual(restored.project.scriptDraft, canonical.scriptDraft);
  assert.equal(restored.assets.size, 0);
  assert.deepEqual(restored.project.scriptDraft.result.sources, [{title: '공식 설정 자료', url: 'https://example.com/lore?chapter=1'}]);
});

test('local script drafts retain Unicode inputs, defaults and manual empty-script edits', () => {
  const sourceText = '🛰'.repeat(100000);
  const local = validateProject(createProject({scriptDraft: {sourceText}})).scriptDraft;
  assert.equal(local.sourceText, sourceText);
  assert.equal(local.targetMinutes, 8);
  assert.equal(local.charsPerMinute, 330);
  assert.equal(local.instructions, '');
  assert.equal(local.draftScript, '');
  assert.equal(local.result, null);
  const draft = scriptDraftFixture();
  draft.targetMinutes = 12;
  draft.result.script = '';
  const empty = validateProject(createProject({scriptDraft: draft})).scriptDraft;
  assert.equal(empty.result.targetMinutes, 8, 'generation metadata remains independent of a new goal');
  assert.equal(empty.result.characters, 0);
  assert.equal(empty.result.estimatedMinutes, 0);
});

test('a manual spoken draft is saved before any narration or researched result exists', async () => {
  const text = '먼저 대본을 작성합니다. 🛰️\n\n완성한 대본으로 다음 단계에서 음성을 만듭니다.';
  const project = createProject({scriptDraft: {
    sourceText: '직접 제공한 참고 자료', draftScript: text,
    targetMinutes: 8, charsPerMinute: 330, result: null,
    voiceApiKey: 'never-save-this-test-credential',
  }});
  const canonical = validateProject(project);
  assert.equal(canonical.scenes.length, 0);
  assert.equal(canonical.audio.narrationId, null);
  assert.equal(canonical.scriptDraft.draftScript, text);
  assert.equal(canonical.scriptDraft.result, null, 'manual writing never invents web-search evidence');
  assert.equal(canonical.scriptDraft.voiceApiKey, undefined);
  const loaded = await importProjectBackup(await exportProjectBackup(canonical, new Map()));
  assert.equal(loaded.project.schemaVersion, 1);
  assert.deepEqual(loaded.project.scriptDraft, canonical.scriptDraft);
  assert.equal(loaded.assets.size, 0, 'a script-only backup needs no voice media or key');
});

test('legacy researched drafts populate the editor while explicit edits and deletion take priority', async () => {
  const legacy = scriptDraftFixture();
  const canonical = validateProject(createProject({scriptDraft: legacy}));
  assert.equal(canonical.scriptDraft.draftScript, legacy.result.script);
  const edited = '직접 고친 최종 음성 대본입니다.';
  canonical.scriptDraft.draftScript = edited;
  const editedProject = validateProject(canonical);
  assert.equal(editedProject.scriptDraft.draftScript, edited);
  assert.equal(editedProject.scriptDraft.result.script, legacy.result.script,
    'an independent manual draft does not silently rewrite the retained researched result');
  editedProject.scriptDraft.draftScript = '';
  const cleared = validateProject(editedProject);
  assert.equal(cleared.scriptDraft.draftScript, '');
  assert.equal(cleared.scriptDraft.result.webSearchUsed, true);
  const restored = await importProjectBackup(await exportProjectBackup(cleared, new Map()));
  assert.equal(restored.project.scriptDraft.draftScript, '', 'restoring a cleared draft never resurrects prior narration text');
});

test('manual spoken drafts preserve Unicode limits and cannot bypass research validation', () => {
  const text = '🛰'.repeat(100000);
  const project = validateProject(createProject({scriptDraft: {draftScript: text}}));
  assert.equal(project.scriptDraft.draftScript, text);
  for (const draftScript of [null, 42, [], {}, 'a'.repeat(100001)]) {
    assert.throws(() => validateProject(createProject({scriptDraft: {draftScript}})));
  }
  const fake = scriptDraftFixture({draftScript: '직접 쓴 대본이 있어도 허위 출처는 허용하지 않습니다.'});
  fake.result.webSearchUsed = false;
  assert.throws(() => validateProject(createProject({scriptDraft: fake})), /웹 검색/);
});

test('script drafts reject malformed, oversized, unsafe and unsearched results', () => {
  const badDrafts = [
    [], 'not-a-draft',
    {sourceText: 42}, {sourceText: 'a'.repeat(100001)}, {instructions: 'a'.repeat(2001)},
    {targetMinutes: 0}, {targetMinutes: 61}, {targetMinutes: 1.5}, {targetMinutes: '8'},
    {charsPerMinute: 199}, {charsPerMinute: 501}, {charsPerMinute: 330.5},
  ];
  for (const draft of badDrafts) assert.throws(() => validateProject(createProject({scriptDraft: draft})));
  const invalidResults = [
    {webSearchUsed: false}, {webSearchUsed: 'true'}, {sources: []},
    {sources: Array.from({length: 31}, () => ({url: 'https://example.com/'}))},
    {sources: [{url: 'javascript:alert(1)'}]}, {sources: [{url: 'data:text/html,hello'}]},
    {sources: [{url: 'file:///tmp/secret'}]}, {sources: [{url: '/relative'}]},
    {sources: [{url: 'https://username:password@example.com/'}]},
    {sources: [{url: 'https://example.com/\nignored'}]},
    {sources: [{title: 'x'.repeat(501), url: 'https://example.com/'}]},
    {script: 'x'.repeat(100001)}, {script: 123}, {script: undefined},
    {title: 'x'.repeat(201)}, {summary: 'x'.repeat(20001)},
    {notes: Array.from({length: 31}, () => '')}, {notes: [null]}, {notes: ['x'.repeat(2001)]},
    {searchedAt: '2026-02-30T00:00:00Z'}, {searchedAt: '2026-10-29'},
    {searchedAt: 'invalid'}, {targetMinutes: 8.5}, {charsPerMinute: 501},
  ];
  for (const patch of invalidResults) {
    const draft = scriptDraftFixture();
    Object.assign(draft.result, patch);
    assert.throws(() => validateProject(createProject({scriptDraft: draft})), JSON.stringify(patch).slice(0, 160));
  }
  const oversized = scriptDraftFixture({sourceText: '🛰'.repeat(100000)});
  oversized.result.script = '🛰'.repeat(100000);
  assert.throws(() => validateProject(createProject({scriptDraft: oversized})), /600KiB/);
});

test('image studio defaults remain independent and canonical metadata excludes provider settings', () => {
  const first = createProject(), second = createProject();
  assert.deepEqual(first.imageStudio, {background: '', style: '', negativePrompt: '', prompt: '',
    size: '1536x864', quality: 'medium', references: []});
  assert.notEqual(first.imageStudio, second.imageStudio);
  assert.notEqual(first.imageStudio.references, second.imageStudio.references);
  const legacy = {...first};delete legacy.imageStudio;
  assert.deepEqual(validateProject(legacy).imageStudio, first.imageStudio);
  const imageStudio = validateProject(createProject({imageStudio: {
    background: '동일한 세계관의 배경 설정', providerConfig: {model: 'not-project-data'},
    generatedImage: 'not-project-data', references: [{assetId: 'reference', label: '🛰'.repeat(120)}],
  }})).imageStudio;
  assert.equal(imageStudio.background, '동일한 세계관의 배경 설정');
  assert.equal(imageStudio.size, '1536x864');
  assert.equal(imageStudio.quality, 'medium');
  assert.deepEqual(imageStudio.references, [{assetId: 'reference', label: '🛰'.repeat(120), role: 'concept', enabled: true}]);
  assert.equal(imageStudio.providerConfig, undefined);
  assert.equal(imageStudio.generatedImage, undefined);
});

test('image studio rejects malformed references, repeated IDs and unsupported generation settings', () => {
  const invalid = [
    [], 'settings', 7,
    {background: '가'.repeat(20001)}, {style: '가'.repeat(4001)},
    {negativePrompt: '가'.repeat(2001)}, {prompt: '가'.repeat(10001)}, {background: 123},
    {size: '4096x4096'}, {quality: 'unlimited'},
    {references: null}, {references: {}}, {references: [null]}, {references: [[]]},
    {references: [{assetId: ''}]}, {references: [{assetId: '../image'}]},
    {references: [{assetId: 'reference', label: 'x'.repeat(121)}]},
    {references: [{assetId: 'reference', role: 'arbitrary'}]},
    {references: [{assetId: 'reference', enabled: 'true'}]},
    {references: [{assetId: 'same'}, {assetId: 'same', enabled: false}]},
    {references: Array.from({length: 6}, (_, index) => ({assetId: `reference-${index}`}))},
  ];
  for (const imageStudio of invalid) {
    assert.throws(() => validateProject(createProject({imageStudio})), JSON.stringify(imageStudio).slice(0, 160));
  }
  const text = '🛰'.repeat(20000);
  assert.equal(validateProject(createProject({imageStudio: {background: text}})).imageStudio.background, text);
});

test('reference-only projects preserve enabled and disabled image bytes through portable backups', async () => {
  const project = createProject({imageStudio: {
    background: '황폐한 도시와 동일한 배경 설정', style: '낮은 채도의 애니메이션', negativePrompt: '문자·로고',
    prompt: '주인공의 다른 구도', size: '864x1536', quality: 'high',
    references: [
      {assetId: 'main-concept', label: '주요 컨셉', role: 'concept', enabled: true},
      {assetId: 'background', label: '도시 배경', role: 'background', enabled: false},
    ],
  }});
  const main = new Uint8Array([137, 80, 78, 71, 0, 255, 19, 42]);
  const background = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const assets = new Map([
    ['main-concept', {name: '메인.png', blob: new Blob([main], {type: 'image/png'})}],
    ['background', {name: '배경.webp', blob: new Blob([background], {type: 'image/webp'})}],
    ['unused', {name: '쓰지 않는 이미지.png', blob: new Blob(['unused'], {type: 'image/png'})}],
  ]);
  assert.deepEqual([...referencedAssetIds(project)], ['main-concept', 'background']);
  const loaded = await importProjectBackup(await exportProjectBackup(project, assets));
  assert.deepEqual(loaded.project.imageStudio, validateProject(project).imageStudio);
  assert.equal(loaded.project.scenes.length, 0);
  assert.equal(loaded.assets.size, 2);
  assert.equal(loaded.project.imageStudio.references[1].enabled, false);
  assert.deepEqual(new Uint8Array(await loaded.assets.get('main-concept').blob.arrayBuffer()), main);
  assert.deepEqual(new Uint8Array(await loaded.assets.get('background').blob.arrayBuffer()), background);
});

test('shared reference and scene images are stored once and reference removal preserves scene media', async () => {
  const project = createProject({scenes: [createScene({imageId: 'shared-image'})],
    imageStudio: {references: [{assetId: 'shared-image'}, {assetId: 'only-reference', enabled: false}]}});
  const assets = new Map([
    ['shared-image', {blob: new Blob(['shared'], {type: 'image/png'})}],
    ['only-reference', {blob: new Blob(['reference'], {type: 'image/jpeg'})}],
  ]);
  const document = JSON.parse(await (await exportProjectBackup(project, assets)).text());
  assert.equal(document.assets.length, 2);
  assert.equal(document.assets.filter(asset => asset.id === 'shared-image').length, 1);
  project.imageStudio.references = [];
  assert.deepEqual([...referencedAssetIds(project)], ['shared-image']);
  const withoutReferences = await importProjectBackup(await exportProjectBackup(project, assets));
  assert.equal(withoutReferences.assets.size, 1);
  assert.equal(await withoutReferences.assets.get('shared-image').blob.text(), 'shared');
  assert.deepEqual(withoutReferences.project.imageStudio.references, []);
});

test('reference image validation rejects missing media and audio disguised as reference assets', async () => {
  const project = createProject({imageStudio: {references: [{assetId: 'reference', enabled: false}]}});
  await assert.rejects(exportProjectBackup(project, new Map()), /필요한 이미지/);
  const assets = new Map([['reference', {blob: new Blob(['audio'], {type: 'audio/wav'})}]]);
  await assert.rejects(exportProjectBackup(project, assets), /이미지 파일 형식/);
  await assert.rejects(importProjectBackup({kind: 'bth-image-studio', version: 1, project,
    assets: [{id: 'reference', type: 'audio/wav', name: 'not-image.wav', data: btoa('audio')}] }), /이미지 파일 형식/);
});

test('reference size checks reject oversized originals before encoding and leave ordinary scene limits intact', async () => {
  const blob = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], {type: 'image/png'});
  let encoded = false;
  blob.arrayBuffer = async () => { encoded = true; throw new Error('encoding-test-boundary'); };
  const assets = new Map([['image', {blob}]]);
  const referenceProject = createProject({imageStudio: {references: [{assetId: 'image', enabled: false}]}});
  await assert.rejects(exportProjectBackup(referenceProject, assets), /한 장은 10MB/);
  assert.equal(encoded, false, 'oversized disabled references cannot reach base64 encoding');
  const sceneProject = createProject({scenes: [createScene({imageId: 'image'})]});
  await assert.rejects(exportProjectBackup(sceneProject, assets), /encoding-test-boundary/);
  assert.equal(encoded, true, 'the reference-only cap does not lower the ordinary scene media limit');
});

test('all reference originals count toward 20MiB even when disabled, and scene-shared IDs count once', async () => {
  const oversizedTotal = createProject({imageStudio: {references: [
    {assetId: 'one'}, {assetId: 'two', enabled: false}, {assetId: 'three', enabled: false},
  ]}});
  const sevenMiB = new Blob([new Uint8Array(7 * 1024 * 1024)], {type: 'image/webp'});
  let encoded = false;
  sevenMiB.arrayBuffer = async () => { encoded = true; throw new Error('encoding-test-boundary'); };
  const tooLarge = new Map(['one', 'two', 'three'].map(id => [id, {blob: sevenMiB}]));
  await assert.rejects(exportProjectBackup(oversizedTotal, tooLarge), /합계는 20MB/);
  assert.equal(encoded, false, 'the complete reference set is checked before any encoding');

  const tenMiB = new Blob([new Uint8Array(10 * 1024 * 1024)], {type: 'image/png'});
  tenMiB.arrayBuffer = async () => { throw new Error('canonical-size-validation-passed'); };
  const boundary = createProject({scenes: [createScene({imageId: 'shared'})],
    imageStudio: {references: [{assetId: 'shared'}, {assetId: 'other', enabled: false}]}});
  const accepted = new Map([['shared', {blob: tenMiB}], ['other', {blob: tenMiB}]]);
  await assert.rejects(exportProjectBackup(boundary, accepted), /canonical-size-validation-passed/);
});

test('backup media bounds allow 200 scene images, two audio files and five distinct references', async () => {
  const scenes = Array.from({length: 200}, (_, index) => createScene({imageId: `scene-image-${index}`, duration: 0.25}));
  const references = Array.from({length: 5}, (_, index) => ({assetId: `reference-${index}`}));
  const project = createProject({scenes, audio: {narrationId: 'voice', bgmId: 'music'}, imageStudio: {references}});
  const assets = new Map([...scenes.map(scene => [scene.imageId, {blob: new Blob(['pixels'], {type: 'image/png'})}]),
    ...references.map(reference => [reference.assetId, {blob: new Blob(['reference'], {type: 'image/png'})}]),
    ['voice', {blob: new Blob(['voice'], {type: 'audio/wav'})}], ['music', {blob: new Blob(['music'], {type: 'audio/wav'})}]]);
  const document = JSON.parse(await (await exportProjectBackup(project, assets)).text());
  assert.equal(document.assets.length, 207);
  assert.equal((await importProjectBackup(document)).assets.size, 207);
  document.assets.push({id: 'extra-image', name: 'extra.png', type: 'image/png', data: btoa('extra')});
  await assert.rejects(importProjectBackup(document), /프로젝트 미디어 목록/);
});
