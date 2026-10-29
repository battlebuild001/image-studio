import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject, createScene} from '../dist/project.js';
import {createPreviewAudio, getAudioGain, getAudioWindow, getSceneAt, renderFrame} from '../dist/engine.js';

function buffer(seconds, sampleAt = () => 0) {
  const sampleRate = 1000;
  const data = Float32Array.from({length: seconds * sampleRate}, (_, i) => sampleAt(i / sampleRate));
  return {duration: seconds, sampleRate, length: data.length, numberOfChannels: 1, getChannelData: () => data};
}
function fixture() {
  const project = createProject({
    scenes: [createScene({duration: 6})],
    audio: {narrationId: 'voice', bgmId: 'music', narrationStart: 1, narrationEnd: 5, bgmStart: 0.5, bgmEnd: 1.5},
    settings: {narrationVolume: 1.5, bgmVolume: 0.4, bgmFadeIn: 1, bgmFadeOut: 2},
  });
  const assets = new Map([
    ['voice', {audioBuffer: buffer(8, time => time >= 2 && time < 3 ? 0.1 : 0)}],
    ['music', {audioBuffer: buffer(2)}],
  ]);
  return {project, assets};
}

test('audio windows retain nondestructive source trims and reject out-of-file bounds', () => {
  const {project, assets} = fixture();
  assert.deepEqual(getAudioWindow(project, assets, 'narration'), {start: 1, end: 5, duration: 4});
  assert.deepEqual(getAudioWindow(project, assets, 'bgm'), {start: 0.5, end: 1.5, duration: 1});
  project.audio.narrationEnd = 9;
  assert.throws(() => getAudioWindow(project, assets, 'narration'), /파일 길이/);
  project.audio.narrationEnd = null;
  assert.equal(getAudioWindow(project, assets, 'narration').duration, 7);
});

test('trimmed narration ends independently of video; BGM fades follow video time', () => {
  const {project, assets} = fixture();
  assert.equal(getAudioGain(project, assets, 'narration', 0), 1.5);
  assert.equal(getAudioGain(project, assets, 'narration', 4), 0);
  assert.equal(getAudioGain(project, assets, 'bgm', 0), 0);
  assert.equal(getAudioGain(project, assets, 'bgm', 0.5), 0.2);
  assert.equal(getAudioGain(project, assets, 'bgm', 2), 0.4, 'looping source does not restart the video fade');
  assert.equal(getAudioGain(project, assets, 'bgm', 5), 0.2);
  assert.equal(getAudioGain(project, assets, 'bgm', 6), 0);
});

test('ducking responds to speech energy in the trimmed voice, not silent narration spans', () => {
  const {project, assets} = fixture();
  project.settings.bgmFadeIn = project.settings.bgmFadeOut = 0;
  project.settings.ducking = true;
  assert.equal(getAudioGain(project, assets, 'bgm', 0.2), 0.4);
  assert.equal(getAudioGain(project, assets, 'bgm', 1.5), 0.1);
  assert.equal(getAudioGain(project, assets, 'bgm', 3), 0.4);
  project.settings.narrationVolume = 0;
  assert.equal(getAudioGain(project, assets, 'bgm', 1.5), 0.4, 'muted narration does not duck music');
});

test('narration timeline delay leaves an intro silent and shifts speech ducking with the voice', () => {
  const {project, assets} = fixture();
  project.scenes[0].duration = 10;
  project.audio.narrationOffset = 2;
  project.settings.bgmFadeIn = project.settings.bgmFadeOut = 0;
  project.settings.ducking = true;
  assert.equal(getAudioGain(project, assets, 'narration', 1.99), 0);
  assert.equal(getAudioGain(project, assets, 'narration', 2), 1.5);
  assert.equal(getAudioGain(project, assets, 'narration', 5.99), 1.5);
  assert.equal(getAudioGain(project, assets, 'narration', 6), 0);
  assert.equal(getAudioGain(project, assets, 'bgm', 1.5), 0.4, 'intro music is not ducked');
  assert.equal(getAudioGain(project, assets, 'bgm', 2.2), 0.4, 'silence within the trimmed voice remains unducked');
  assert.equal(getAudioGain(project, assets, 'bgm', 3.5), 0.1, 'speech energy is sampled at the delayed source timestamp');
  assert.equal(getAudioGain(project, assets, 'bgm', 7), 0.4);
});

test('render snapshot is invalidated after framing and custom motion edits', () => {
  const project = createProject({scenes: [createScene({duration: 4, motion: 'custom', focusX: 0.2, endX: 0.8, zoomEnd: 1.7})]});
  assert.equal(getSceneAt(project, 2).scene.focusX, 0.2);
  project.scenes[0].focusX = 0.9;
  project.scenes[0].zoomEnd = 2.1;
  assert.equal(getSceneAt(project, 2).scene.focusX, 0.9);
  assert.equal(getSceneAt(project, 2).scene.zoomEnd, 2.1);
});

test('renderer invalidates speech timing after in-place trim, delay, cue and narration changes', () => {
  const project = createProject({
    scenes: [createScene({duration: 20, imageId: 'still', motion: 'none'})],
    settings: {branding: false, transition: 0},
    audio: {narrationId: 'voice', narrationStart: 10, narrationEnd: 18, narrationOffset: 1},
    captionMode: 'speech',
    captions: [{start: 11, end: 12, text: '첫 발화'}, {start: 14, end: 16, text: '다음 발화'}],
    captionAnalysis: {narrationId: 'voice', sourceStart: 10, sourceEnd: 18, language: 'ko',
      model: 'whisper-1', granularity: 'word', createdAt: '2026-10-29T10:20:30.000Z'},
  });
  const assets = new Map([['still', {image: {width: 1280, height: 720}}]]);
  const text = [];
  const noop = () => {};
  const ctx = {canvas: {width: 1280, height: 720},
    save: noop, restore: noop, setTransform: noop, clearRect: noop, fillRect: noop,
    beginPath: noop, rect: noop, clip: noop, moveTo: noop, arcTo: noop,
    closePath: noop, fill: noop, drawImage: noop,
    createLinearGradient: () => ({addColorStop: noop}),
    measureText: value => ({width: Array.from(value).length * 20}),
    fillText: value => text.push(value),
  };
  const at = time => {text.length = 0;renderFrame(ctx, project, assets, time);return [...text];};
  assert.deepEqual(at(2.4), ['첫 발화']);
  assert.deepEqual(at(5.3), ['다음 발화']);

  project.audio.narrationOffset = 3;
  assert.deepEqual(at(2.4), [], 'previous caption time becomes silent after a narration delay');
  assert.deepEqual(at(4.4), ['첫 발화']);
  project.audio.narrationStart = 11.5;
  assert.deepEqual(at(3.25), ['첫 발화'], 'trimming the source moves and clips the active caption');
  assert.deepEqual(at(4.4), [], 'the former delayed position is not cached');
  project.audio.narrationEnd = 11.7;
  assert.deepEqual(at(3.25), [], 'a source-end trim clips the caption end');
  assert.deepEqual(at(3.1), ['첫 발화']);

  project.audio.narrationEnd = 18;
  Object.assign(project.captions[0], {start: 11.75, end: 12.25, text: '수정한 발화'});
  assert.deepEqual(at(3.1), [], 'an edited source cue replaces its former interval');
  assert.deepEqual(at(3.4), ['수정한 발화']);
  project.audio.narrationId = 'replacement';
  assert.deepEqual(at(3.4), [], 'captions from a replaced narration are hidden');
  project.audio.narrationId = 'voice';
  assert.deepEqual(at(3.4), ['수정한 발화']);
  project.captionAnalysis.narrationId = 'replacement';
  assert.deepEqual(at(3.4), [], 'in-place analysis provenance changes also invalidate the snapshot');
});

test('preview seeks into trimmed narration and loops only trimmed BGM; stopping releases nodes', async t => {
  const original = globalThis.AudioContext;
  const sources = [];
  class Context {
    state = 'running';
    currentTime = 10;
    destination = {};
    async resume() {}
    async close() { this.state = 'closed'; }
    createBufferSource() {
      const source = {connect() {}, disconnect() {this.disconnected = true;}, start(...args) {this.started = args;}, stop(...args) {this.stopped = args;}};
      sources.push(source);
      return source;
    }
    createGain() {return {connect() {}, disconnect() {}, gain: {setValueAtTime() {}, setValueCurveAtTime() {}}};}
  }
  globalThis.AudioContext = Context;
  t.after(() => {globalThis.AudioContext = original;});
  const {project, assets} = fixture();
  const preview = await createPreviewAudio(project, assets, 2.5);
  t.after(() => preview.stop());
  assert.deepEqual(sources[0].started, [10.01, 3.5]);
  assert.equal(sources[0].loop, false);
  assert.equal(sources[0].stopped[0], 11.51);
  assert.equal(sources[1].loop, true);
  assert.equal(sources[1].loopStart, 0.5);
  assert.equal(sources[1].loopEnd, 1.5);
  assert.deepEqual(sources[1].started, [10.01, 1]);
  assert.equal(sources[1].stopped[0], 13.51);
  preview.stop();
  assert.ok(sources.every(source => source.disconnected));
});

test('delayed narration preview seeks before its start, inside its trim and after its end', async t => {
  const original = globalThis.AudioContext;
  let sources = [];
  class Context {
    state = 'running';currentTime = 10;destination = {};
    async resume() {}
    async close() {this.state = 'closed';}
    createBufferSource() {
      const source = {connect() {}, disconnect() {}, start(...args) {this.started = args;}, stop(...args) {this.stopped = args;}};
      sources.push(source);return source;
    }
    createGain() {return {connect() {}, disconnect() {}, gain: {setValueAtTime() {}, setValueCurveAtTime() {}}};}
  }
  globalThis.AudioContext = Context;
  t.after(() => {globalThis.AudioContext = original;});
  const {project, assets} = fixture();
  project.audio.bgmId = null;
  project.audio.narrationOffset = 2;
  project.scenes[0].duration = 10;
  const before = await createPreviewAudio(project, assets, 0);
  t.after(() => before.stop());
  assert.deepEqual(sources[0].started, [12.01, 1]);
  assert.ok(Math.abs(sources[0].stopped[0] - 16.01) < 1e-9);
  before.stop();sources = [];
  const inside = await createPreviewAudio(project, assets, 3);
  t.after(() => inside.stop());
  assert.deepEqual(sources[0].started, [10.01, 2]);
  assert.equal(sources[0].stopped[0], 13.01);
  inside.stop();sources = [];
  const after = await createPreviewAudio(project, assets, 7);
  t.after(() => after.stop());
  assert.equal(sources.length, 0, 'no narration source is created after its delayed end');
  after.stop();
});
