import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  planAudioChunks, isSilentAudioChunk, encodePcm16Wav, toBase64,
  groupTimedTranscript,
} from '../dist/speech-timing.js';

function audio(channels, sampleRate = 100) {
  const arrays = channels.map(samples => samples instanceof Float32Array ? samples : new Float32Array(samples));
  return {sampleRate, numberOfChannels: arrays.length, length: arrays[0].length,
    duration: arrays[0].length / sampleRate, getChannelData: index => arrays[index]};
}

test('eight-minute narration is split without gaps, duplicate ranges or exceeding five minutes', () => {
  const samples = new Float32Array(48000).fill(0.1);
  // A genuine quiet boundary near 298 seconds is preferred over cutting speech at 300.
  samples.fill(0, 29790, 29810);
  const chunks = planAudioChunks(audio([samples]), {start: 2, end: 478});
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].start, 2);
  assert.ok(chunks[0].end > 297.9 && chunks[0].end < 298.1);
  assert.equal(chunks[0].end, chunks[1].start);
  assert.equal(chunks[1].end, 478);
  assert.ok(chunks.every(range => range.end - range.start <= 300));
  assert.ok(Math.abs(chunks.reduce((sum, range) => sum + range.end - range.start, 0) - 476) < 1e-8);
});

test('constant speech uses the hard duration limit and trimmed short files stay a single chunk', () => {
  const buffer = audio([new Float32Array(70000).fill(0.03)]);
  assert.deepEqual(planAudioChunks(buffer, {start: 4, end: 650}), [
    {start: 4, end: 304}, {start: 304, end: 604}, {start: 604, end: 650},
  ]);
  assert.deepEqual(planAudioChunks(buffer, {start: 15, end: 16}), [{start: 15, end: 16}]);
  assert.throws(() => planAudioChunks(buffer, {start: -1, end: 2}), /범위/);
  assert.throws(() => planAudioChunks(buffer, {start: 1, end: 800}), /범위/);
  assert.throws(() => planAudioChunks(buffer, {maxSeconds: 301}), /300초/);
});

test('silence skipping considers every channel and retains very quiet speech or a single sample', () => {
  const left = new Float32Array(1000);
  const right = new Float32Array(1000);
  const buffer = audio([left, right]);
  assert.equal(isSilentAudioChunk(buffer), true);
  right[799] = 0.000001;
  assert.equal(isSilentAudioChunk(buffer), false);
  assert.equal(isSilentAudioChunk(buffer, {start: 0, end: 7}), true);
  right[799] = NaN;
  assert.equal(isSilentAudioChunk(buffer), false);
});

test('WAV bytes contain actual mono PCM16 samples with a matching header and lossless base64 transport', async () => {
  const blob = encodePcm16Wav(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
  assert.equal(blob.type, 'audio/wav');
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.readUInt32LE(40), 14);
  assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
  assert.deepEqual(Array.from({length: 7}, (_, index) => bytes.readInt16LE(44 + index * 2)),
    [-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  assert.deepEqual(Buffer.from(await toBase64(blob), 'base64'), bytes);
  const controller = new AbortController();controller.abort();
  await assert.rejects(toBase64(blob, {signal: controller.signal}), {name: 'AbortError'});
  assert.throws(() => encodePcm16Wav(new Float32Array([NaN])), /손상/);
});

test('captions use actual word bounds, source offsets and silence without spreading text across a gap', () => {
  const cues = groupTimedTranscript({duration: 12, text: '처음 이야기 다음 이야기입니다.', words: [
    {word: '처음', start: 0.3, end: 0.7}, {word: '이야기', start: 0.8, end: 1.4},
    {word: '다음', start: 4.2, end: 4.6}, {word: '이야기입니다.', start: 4.7, end: 6.1},
  ]}, {sourceStart: 30});
  assert.deepEqual(cues, [
    {start: 30.3, end: 31.4, text: '처음 이야기'},
    {start: 34.2, end: 36.1, text: '다음 이야기입니다.'},
  ]);
});

test('Korean spacing and transcript punctuation survive word boundaries and sentence grouping', () => {
  const result = {duration: 4, text: '“안녕하세요, 여러분.” 시작합니다!', words: [
    {word: '안녕', start: 0.1, end: 0.3}, {word: '하세요', start: 0.3, end: 0.5},
    {word: '여러분', start: 0.6, end: 1}, {word: '시작합니다', start: 2, end: 3},
  ]};
  assert.deepEqual(groupTimedTranscript(result), [
    {start: 0.1, end: 1, text: '“안녕하세요, 여러분.”'},
    {start: 2, end: 3, text: '시작합니다!'},
  ]);
});

test('length and duration split only at known word times; overlapping words stay together', () => {
  const result = {duration: 10, text: '가나다라마바사 아자차카타파하 다음', words: [
    {word: '가나다라마바사', start: 0.2, end: 2},
    {word: '아자차카타파하', start: 1.9, end: 3},
    {word: '다음', start: 3.1, end: 4.2},
  ]};
  assert.deepEqual(groupTimedTranscript(result, {maxChars: 8}), [
    {start: 0.2, end: 3, text: '가나다라마바사 아자차카타파하'},
    {start: 3.1, end: 4.2, text: '다음'},
  ]);
  assert.deepEqual(groupTimedTranscript({...result, words: [
    {word: '가나다라마바사', start: 0.2, end: 2},
    {word: '아자차카타파하', start: 2.1, end: 3},
    {word: '다음', start: 3.1, end: 4.2},
  ]}, {maxDuration: 2.5}), [
    {start: 0.2, end: 2, text: '가나다라마바사'},
    {start: 2.1, end: 4.2, text: '아자차카타파하 다음'},
  ]);
});

test('segment-only recognition retains exact segment times instead of inventing word alignment', () => {
  const text = '한 구간의 긴 문장입니다. 이 안의 단어 시간은 알 수 없습니다.';
  assert.deepEqual(groupTimedTranscript({duration: 12, text, segments: [{start: 1.2, end: 10.6, text}]}, {sourceStart: 300, maxChars: 5}),
    [{start: 301.2, end: 310.6, text}]);
  assert.deepEqual(groupTimedTranscript({duration: 2, text: '', words: [], segments: []}), []);
  assert.throws(() => groupTimedTranscript({duration: 2, text: '타이밍 없는 문장'}), /시간 정보/);
});

test('invalid, out-of-order and out-of-audio timestamps fail explicitly', () => {
  for (const words of [
    [{word: '오류', start: -1, end: 1}],
    [{word: '오류', start: 1, end: 5}],
    [{word: '오류', start: 2, end: 1}],
    [{word: '오류', start: NaN, end: 1}],
    [{word: '뒤', start: 2, end: 3}, {word: '앞', start: 1, end: 2}],
  ]) assert.throws(() => groupTimedTranscript({duration: 4, text: '오류', words}), /시간 정보/);
  assert.throws(() => groupTimedTranscript({duration: 4, text: '순간', words: [{word: '순간', start: 1, end: 1}]}), /발화 시간/);
  assert.throws(() => groupTimedTranscript({duration: NaN, text: ''}), /결과/);
});
