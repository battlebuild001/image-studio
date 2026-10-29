import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const source = await readFile(new URL('../dist/project.js', import.meta.url), 'utf8');
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const {createProject, createScene, validateProject, parseSrt, exportSrt, splitScript,
  distributeDurations, getTimeline, getCaptions, exportProjectBackup, importProjectBackup} = module;

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
