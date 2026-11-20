import test from 'node:test';
import assert from 'node:assert/strict';
import {BGM_PRESETS, BGM_SAMPLE_RATE, estimateBgmBytes, normalizeBgmOptions, generateBgmWav} from '../dist/bgm-generator.js';
import {createProject, createScene} from '../dist/project.js';
import {getBgmSource} from '../dist/bgm-studio.js';

async function decode(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), BGM_SAMPLE_RATE);assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), bytes.length - 44);
  return {bytes, samples: Float64Array.from({length: (bytes.length - 44) / 2}, (_, index) => view.getInt16(44 + index * 2, true) / 32768)};
}
const immediate = async () => {};
function metrics(samples) {
  let sum = 0, peak = 0, jump = 0;
  for (let index = 0; index < samples.length; index++) {sum += samples[index] ** 2;peak = Math.max(peak, Math.abs(samples[index]));if (index) jump = Math.max(jump, Math.abs(samples[index] - samples[index - 1]));}
  return {rms: Math.sqrt(sum / samples.length), peak, jump};
}
function magnitude(samples, hz, start, duration) {
  let real = 0, imaginary = 0;const first = Math.round(start * BGM_SAMPLE_RATE), frames = Math.round(duration * BGM_SAMPLE_RATE);
  for (let at = 0; at < frames; at++) {const phase = 2 * Math.PI * hz * at / BGM_SAMPLE_RATE, window = .5 - .5 * Math.cos(2 * Math.PI * at / (frames - 1)), sample = samples[first + at] * window;real += sample * Math.cos(phase);imaginary += sample * Math.sin(phase);}
  return 4 * Math.hypot(real, imaginary) / frames;
}

test('all three presets create real, correctly timed PCM music with headroom and soft edges', async () => {
  const fingerprints = [];
  for (const preset of BGM_PRESETS) {
    const result = await generateBgmWav({durationSeconds: 5.125, preset: preset.id, seed: 103}, {yieldControl: immediate});
    assert.equal(result.blob.type, 'audio/wav');assert.equal(result.blob.size, estimateBgmBytes(5.125));
    const {samples, bytes} = await decode(result.blob), {rms, peak, jump} = metrics(samples);
    assert.ok(Math.abs(samples.length / BGM_SAMPLE_RATE - 5.125) < 1 / BGM_SAMPLE_RATE);
    assert.ok(rms > .009 && rms < .2, `${preset.id} RMS ${rms}`);
    assert.ok(peak < .401, `${preset.id} peak ${peak}`);assert.ok(jump < .075, `${preset.id} sample discontinuity ${jump}`);
    assert.equal(samples[0], 0);assert.equal(samples.at(-1), 0);
    const first = metrics(samples.slice(0, Math.round(.08 * BGM_SAMPLE_RATE))).rms, middle = metrics(samples.slice(2 * BGM_SAMPLE_RATE, 3 * BGM_SAMPLE_RATE)).rms;
    assert.ok(first < middle * .15, `${preset.id} must fade in`);
    fingerprints.push(Buffer.from(bytes).toString('base64').slice(1000, 1200));
  }
  assert.equal(new Set(fingerprints).size, 3, 'presets must sound different');
});

test('a seed produces deterministic music and another variation changes actual samples', async () => {
  const options = {durationSeconds: .75, preset: 'explanation', seed: 42};
  const a = await generateBgmWav(options, {yieldControl: immediate}), b = await generateBgmWav(options, {yieldControl: immediate}), c = await generateBgmWav({...options, seed: 43}, {yieldControl: immediate});
  assert.deepEqual(await a.blob.arrayBuffer(), await b.blob.arrayBuffer());assert.notDeepEqual(await a.blob.arrayBuffer(), await c.blob.arrayBuffer());
});

test('the ambient output contains several chord tones and changing melodic content rather than one hum', async () => {
  const {samples} = await decode((await generateBgmWav({durationSeconds: 12, preset: 'ambient', seed: 1}, {yieldControl: immediate})).blob);
  const chordTones = [44, 51, 56, 60].map(note => magnitude(samples, 440 * 2 ** ((note - 69) / 12), 2, 3));
  assert.ok(chordTones.filter(value => value > .006).length >= 3, JSON.stringify(chordTones));
  const lowEnergy = magnitude(samples, 440 * 2 ** ((32 - 69) / 12), 2, 3);
  assert.ok(lowEnergy > .02, 'a separate bass voice should be present');
  assert.notDeepEqual(samples.slice(2 * BGM_SAMPLE_RATE, 3 * BGM_SAMPLE_RATE), samples.slice(6 * BGM_SAMPLE_RATE, 7 * BGM_SAMPLE_RATE));
});

test('musical phrase repeats without a hard join and the long result preserves exact requested duration', async () => {
  const {samples} = await decode((await generateBgmWav({durationSeconds: 35, preset: 'explanation', seed: 5}, {yieldControl: immediate})).blob);
  const boundary = Math.round(32 * 60 / 88 * BGM_SAMPLE_RATE), jump = Math.abs(samples[boundary] - samples[boundary - 1]);
  assert.ok(jump < .025, `phrase boundary jump ${jump}`);assert.equal(samples.length, 35 * BGM_SAMPLE_RATE);
  const after = metrics(samples.slice(boundary + BGM_SAMPLE_RATE, boundary + 2 * BGM_SAMPLE_RATE));assert.ok(after.rms > .01);
});

test('limits and projected bytes reject invalid or oversized requests before any audio work', () => {
  assert.equal(estimateBgmBytes(3600), 158760044);assert.ok(estimateBgmBytes(3600) < 180 * 1024 * 1024);
  for (const value of [undefined, null, '5', NaN, Infinity, 0, -.1, .49, 3600.001]) assert.throws(() => estimateBgmBytes(value), /길이|타이밍/u);
  for (const seed of [-1, 1.5, NaN, 0x100000000]) assert.throws(() => normalizeBgmOptions({durationSeconds: 5, seed}), /변주/u);
  assert.throws(() => normalizeBgmOptions({durationSeconds: 5, preset: 'provider-model'}), /분위기/u);
  assert.throws(() => normalizeBgmOptions({durationSeconds: 20, maxBytes: 1000}), /공간/u);
});

test('composition and long-file encoding yield and honor cancellation without returning partial music', async () => {
  const before = new AbortController();before.abort();let yields = 0;
  await assert.rejects(generateBgmWav({durationSeconds: 3}, {signal: before.signal, yieldControl: async () => {yields++;}}), {name: 'AbortError'});assert.equal(yields, 0);
  for (const phase of ['compose', 'encode']) {
    const controller = new AbortController();let reached = false;
    await assert.rejects(generateBgmWav({durationSeconds: 3600}, {signal: controller.signal, yieldControl: async () => {yields++;}, onProgress: progress => {if (progress.phase === phase) {reached = true;controller.abort();}}}), {name: 'AbortError'});
    assert.equal(reached, true);
  }
  assert.ok(yields > 1);
});

test('BGM source follows real narration trim and offset, timeline and workspace while ignoring its own BGM replacement', () => {
  const project = createProject({id: 'bgm-source', scenes: [createScene({id: 'one', duration: 8})], scriptDraft: {draftScript: '대본'}}), assets = new Map();let workspace = 'a';
  const api = {getProject: () => project, getAssets: () => assets, getWorkspaceId: () => workspace};
  const first = getBgmSource(api);assert.equal(first.durationSeconds, 8);
  assets.set('voice', {duration: 20, blob: new Blob(['voice'])});project.audio.narrationId = 'voice';project.audio.narrationStart = 3;project.audio.narrationEnd = 15;project.audio.narrationOffset = 2;
  const voice = getBgmSource(api);assert.equal(voice.durationSeconds, 14);assert.equal(voice.basedOn, '음성 길이');assert.notEqual(first.key, voice.key);
  project.audio.bgmId = 'new-music';assert.equal(getBgmSource(api).key, voice.key);
  workspace = 'b';assert.notEqual(getBgmSource(api).key, voice.key);
  project.audio.narrationEnd = 30;assert.throws(() => getBgmSource(api), /범위/u);
});

test('an unconfirmed edited script uses its current estimate instead of stale previous scene duration', () => {
  const project = createProject({id: 'edited-script', scenes: [createScene({duration: 180})]}), assets = new Map();
  let state = {text: '새 대본', durationSeconds: 24, timingConfirmed: false};
  const api = {getProject: () => project, getAssets: () => assets, getSimpleScriptState: () => state};
  const draft = getBgmSource(api);assert.equal(draft.durationSeconds, 24);assert.equal(draft.basedOn, '대본 예상 길이');
  state = {...state, text: '바뀐 새 대본'};assert.notEqual(getBgmSource(api).key, draft.key);
  assets.set('voice', {duration: 30, blob: new Blob(['voice'])});project.audio.narrationId = 'voice';
  assert.equal(getBgmSource(api).durationSeconds, 30, 'real narration takes precedence over an estimate and stale scenes');
  state = {...state, timingConfirmed: true};assert.equal(getBgmSource(api).durationSeconds, 180, 'reviewed or manually edited scene duration stays authoritative');
});
