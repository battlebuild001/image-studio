import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
import {encodePcm16Wav} from '../dist/speech-timing.js';
import {buildDirectTranscriptRequest, modelName, parseTranscriptResponse, validateTranscriptAudio, validateTranscriptRequest} from '../dist/transcript-protocol.js';

async function audio() {
  const samples = new Float32Array(32000);
  for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index * Math.PI / 40) * .2;
  return new Uint8Array(await encodePcm16Wav(samples).arrayBuffer());
}
const b64 = bytes => Buffer.from(bytes).toString('base64');

test('shared transcription protocol executes without Node globals and uploads exact WAV bytes', async () => {
  const bytes = await audio();
  const source = await readFile(new URL('../dist/transcript-protocol.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bBuffer\b|from\s+['"]node:|\bprocess\./);
  const sandbox = {Uint8Array, DataView, atob, btoa, FormData, Blob};
  vm.runInNewContext(source.replace(/\bexport\s+/g, '') + '\nglobalThis.protocol = {buildDirectTranscriptRequest,parseTranscriptResponse};', sandbox);
  assert.equal(vm.runInNewContext('typeof Buffer', sandbox), 'undefined');
  const {settings, body} = sandbox.protocol.buildDirectTranscriptRequest({audio: b64(bytes), language: 'ko', prompt: '기체명과 고유명사'});
  assert.equal(settings.duration, 2);assert.deepEqual([...settings.bytes], [...bytes]);
  assert.equal(body.get('model'), 'whisper-1');assert.equal(body.get('response_format'), 'verbose_json');
  assert.deepEqual(body.getAll('timestamp_granularities[]'), ['word', 'segment']);
  assert.equal(body.get('language'), 'ko');assert.equal(body.get('prompt'), '기체명과 고유명사');
  const uploaded = body.get('file');assert.equal(uploaded.name, 'narration.wav');assert.equal(uploaded.type, 'audio/wav');
  assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), bytes);
});

test('shared WAV validation respects byte offsets and rejects malformed audio instead of trusting duration', async () => {
  const bytes = await audio(), padded = new Uint8Array(bytes.length + 64);padded.set(bytes, 32);
  const ranged = padded.subarray(32, 32 + bytes.length);
  assert.equal(validateTranscriptAudio(ranged).duration, 2);
  assert.equal(validateTranscriptAudio(Buffer.from(bytes)).duration, 2);
  const invalid = new Uint8Array(bytes), view = new DataView(invalid.buffer);
  view.setUint16(22, 2, true);assert.throws(() => validateTranscriptAudio(invalid), error => error.code === 'INVALID_INPUT');
  assert.throws(() => validateTranscriptAudio(bytes.buffer), error => error.status === 400);
  for (const input of [{audio: b64(bytes), duration: 99}, {audio: 'narration.wav'}, {audio: 'Zh=='},
    {audio: b64(bytes), language: 'unsupported'}, {audio: b64(bytes), prompt: '한'.repeat(1001)}]) {
    assert.throws(() => validateTranscriptRequest(input), error => error.status === 400);
  }
});

test('direct multipart can detect language automatically while requiring a timestamp-capable model', async () => {
  const bytes = await audio(), input = {audio: b64(bytes), language: 'auto', prompt: ''};
  const {body} = buildDirectTranscriptRequest(input);
  assert.equal(body.has('language'), false);assert.equal(body.has('prompt'), false);
  assert.equal([...body.keys()].filter(key => key === 'file').length, 1);
  assert.throws(() => buildDirectTranscriptRequest(input, 'gpt-4o-transcribe'), error => error.code === 'INVALID_TRANSCRIPT_MODEL');
  assert.equal(modelName('whisper-1'), 'whisper-1');
});

test('shared provider parser preserves speech gaps and refuses text without actual timing', async () => {
  const settings = validateTranscriptRequest({audio: b64(await audio()), language: 'ko'});
  const response = {text: '첫 말 다음 말', duration: 2, language: 'korean',
    words: [{word: '첫 말', start: .1, end: .4}, {word: '다음 말', start: 1.4, end: 1.8}],
    segments: [{text: '첫 말', start: .1, end: .4}, {text: '다음 말', start: 1.4, end: 1.8}]};
  const parsed = parseTranscriptResponse(response, settings);
  assert.deepEqual(parsed.words, response.words);assert.equal(parsed.words[1].start, 1.4);assert.equal(parsed.duration, 2);
  assert.equal(parsed.granularity, 'word');
  const segments = parseTranscriptResponse({...response, words: undefined}, settings);
  assert.equal(segments.granularity, 'segment');assert.deepEqual(segments.segments, response.segments);
  for (const malformed of [{text: '시간이 없는 결과'}, {...response, duration: 999},
    {...response, words: [{word: '범위 밖', start: 1, end: 10}]}, {...response, text: ''}]) {
    assert.throws(() => parseTranscriptResponse(malformed, settings), error => error.code === 'INVALID_TRANSCRIPT');
  }
});
