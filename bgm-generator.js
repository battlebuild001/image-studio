/** Small, local instrumental synthesizer. No network, microphone or provider API. */
export const BGM_SAMPLE_RATE = 22050;
export const BGM_MAX_SECONDS = 3600;
export const BGM_PRESETS = Object.freeze([
  Object.freeze({id: 'ambient', label: '차분한 앰비언트', description: '느린 화음과 부드러운 멜로디', bpm: 64}),
  Object.freeze({id: 'explanation', label: '설명용 리듬', description: '가벼운 박자와 반복되는 건반', bpm: 88}),
  Object.freeze({id: 'tension', label: '긴장감', description: '낮은 화음과 절제된 리듬', bpm: 76}),
]);
const MAX_BYTES = 180 * 1024 * 1024;
const TAU = Math.PI * 2;
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));

function abort(signal) {
  if (signal?.aborted) throw new DOMException('배경음악 만들기를 취소했어요.', 'AbortError');
}
export function estimateBgmBytes(durationSeconds) {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < .5 || durationSeconds > BGM_MAX_SECONDS) {
    throw new Error('배경음악 길이는 0.5초부터 60분까지 만들 수 있어요. 대본의 타이밍을 먼저 확인해 주세요.');
  }
  return 44 + Math.round(durationSeconds * BGM_SAMPLE_RATE) * 2;
}
export function normalizeBgmOptions({durationSeconds, preset = 'ambient', seed = 1, maxBytes = MAX_BYTES} = {}) {
  const bytes = estimateBgmBytes(durationSeconds);
  if (!BGM_PRESETS.some(item => item.id === preset)) throw new Error('배경음악 분위기를 선택해 주세요.');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('배경음악 변주 번호를 확인해 주세요.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 44 || maxBytes > MAX_BYTES || bytes > maxBytes) {
    throw new Error('배경음악을 보관할 공간이 부족해요. 프로젝트 미디어 합계는 180MB까지 사용할 수 있어요.');
  }
  return {durationSeconds: Math.round(durationSeconds * BGM_SAMPLE_RATE) / BGM_SAMPLE_RATE, preset, seed, bytes};
}
function randomFrom(seed) {
  let value = seed >>> 0;
  return () => {value = (value + 0x6D2B79F5) >>> 0;let n = Math.imul(value ^ value >>> 15, 1 | value);n ^= n + Math.imul(n ^ n >>> 7, 61 | n);return ((n ^ n >>> 14) >>> 0) / 4294967296;};
}
const frequency = midi => 440 * 2 ** ((midi - 69) / 12);
const smooth = value => {const x = Math.max(0, Math.min(1, value));return x * x * (3 - 2 * x);};

/** Build a bounded 32-beat phrase. Notes that cross the boundary wrap with their
 * complete envelopes, so repeating the phrase introduces no discontinuity. */
async function composePhrase(preset, seed, {signal, onProgress, yieldControl}) {
  const config = BGM_PRESETS.find(item => item.id === preset), beat = 60 / config.bpm;
  const frames = Math.round(32 * beat * BGM_SAMPLE_RATE), phrase = new Float32Array(frames), rng = randomFrom(seed);
  const progression = preset === 'tension' ? [[45, 52, 57], [41, 48, 56], [43, 50, 58], [40, 47, 55]] : [[48, 55, 60, 63], [44, 51, 56, 60], [51, 58, 63, 67], [46, 53, 58, 62]];
  const events = [];
  for (let bar = 0; bar < 4; bar++) {
    const chord = progression[(bar + seed % 4) % 4], start = bar * 8 * beat;
    chord.forEach((note, index) => events.push({kind: 'pad', start, duration: 8 * beat + .7, note, gain: .075 / Math.sqrt(chord.length), phase: rng() * TAU + index}));
    events.push({kind: 'bass', start, duration: 7.6 * beat, note: chord[0] - 12, gain: .045, phase: rng() * TAU});
    const stride = preset === 'ambient' ? 2 : preset === 'tension' ? 1 : .5;
    for (let step = 0; step < 8; step += stride) {
      const note = chord[(Math.floor(step / stride) + bar + Math.floor(rng() * 2)) % chord.length] + 12;
      events.push({kind: 'pluck', start: start + step * beat, duration: preset === 'ambient' ? 2.8 : 1.1, note, gain: preset === 'ambient' ? .033 : .039, phase: 0});
    }
    if (preset !== 'ambient') for (let step = 0; step < 8; step += .5) {
      if (step % 2 === 0) events.push({kind: 'kick', start: start + step * beat, duration: .24, gain: preset === 'tension' ? .045 : .038, phase: 0});
      events.push({kind: 'hat', start: start + step * beat, duration: .075, gain: .008 + (step % 1 ? .004 : 0), phase: rng() * TAU});
    }
  }
  for (let index = 0; index < events.length; index++) {
    abort(signal);
    const event = events[index], first = Math.round(event.start * BGM_SAMPLE_RATE), count = Math.round(event.duration * BGM_SAMPLE_RATE), hz = frequency(event.note || 45);
    for (let at = 0; at < count; at++) {
      const t = at / BGM_SAMPLE_RATE, remaining = (count - 1 - at) / BGM_SAMPLE_RATE;
      let value;
      if (event.kind === 'pad') {
        const envelope = smooth(t / .75) * smooth(remaining / .75), wave = TAU * hz * t + event.phase;
        value = envelope * (Math.sin(wave) + .23 * Math.sin(2 * wave + .2) + .08 * Math.sin(3 * wave)) * (.92 + .08 * Math.sin(TAU * .11 * t + event.phase));
      } else if (event.kind === 'bass') {
        value = smooth(t / .04) * smooth(remaining / .25) * (Math.sin(TAU * hz * t + event.phase) + .12 * Math.sin(TAU * hz * 2 * t));
      } else if (event.kind === 'pluck') {
        const wave = TAU * hz * t;
        value = smooth(t / .012) * smooth(remaining / .09) * Math.exp(-t * (preset === 'ambient' ? 1.7 : 4)) * (Math.sin(wave) + .28 * Math.sin(2 * wave) + .1 * Math.sin(3 * wave));
      } else if (event.kind === 'kick') {
        value = smooth(t / .006) * smooth(remaining / .04) * Math.exp(-t * 20) * Math.sin(TAU * (45 * t + 42 / 32 * (1 - Math.exp(-32 * t))));
      } else {
        // A short, inharmonic metallic tick; no non-deterministic noise.
        value = smooth(t / .004) * smooth(remaining / .015) * Math.exp(-t * 58) * (Math.sin(TAU * 4703 * t + event.phase) + .5 * Math.sin(TAU * 6257 * t));
      }
      phrase[(first + at) % frames] += value * event.gain;
    }
    if (index % 8 === 0 || index === events.length - 1) {
      onProgress?.({phase: 'compose', completed: index + 1, total: events.length});
      await yieldControl();abort(signal);
    }
  }
  // Subtract the tiny DC component and normalize down only, keeping background
  // dynamics and leaving ample headroom before the editor's separate BGM gain.
  let sum = 0;for (const sample of phrase) sum += sample;
  const mean = sum / phrase.length;let peak = 0;
  for (const sample of phrase) peak = Math.max(peak, Math.abs(sample - mean));
  const scale = peak > .4 ? .4 / peak : 1;
  for (let at = 0; at < phrase.length; at++) phrase[at] = (phrase[at] - mean) * scale;
  return phrase;
}

/** Real PCM16 mono WAV, at a fixed bounded sample rate. Encoding is chunked and
 * cancellable; a long video repeats a musical phrase rather than allocating its
 * entire Float32 audio. Only the final WAV grows with the video length. */
export async function generateBgmWav(options, {signal, onProgress, yieldControl = yieldTask} = {}) {
  const checked = normalizeBgmOptions(options);abort(signal);
  const phrase = await composePhrase(checked.preset, checked.seed, {signal, onProgress, yieldControl});
  abort(signal);
  const buffer = new ArrayBuffer(checked.bytes), view = new DataView(buffer), frames = (checked.bytes - 44) / 2;
  const ascii = (at, value) => {for (let index = 0; index < value.length; index++) view.setUint8(at + index, value.charCodeAt(index));};
  ascii(0, 'RIFF');view.setUint32(4, checked.bytes - 8, true);ascii(8, 'WAVE');ascii(12, 'fmt ');view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);view.setUint16(22, 1, true);view.setUint32(24, BGM_SAMPLE_RATE, true);view.setUint32(28, BGM_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);view.setUint16(34, 16, true);ascii(36, 'data');view.setUint32(40, frames * 2, true);
  const attack = Math.min(1.5, checked.durationSeconds / 5), release = Math.min(2.5, checked.durationSeconds / 4), chunk = BGM_SAMPLE_RATE * 2;
  let peak = 0, squares = 0;
  for (let first = 0; first < frames; first += chunk) {
    abort(signal);const end = Math.min(first + chunk, frames);
    for (let at = first; at < end; at++) {
      const envelope = smooth(at / BGM_SAMPLE_RATE / attack) * smooth((frames - 1 - at) / BGM_SAMPLE_RATE / release);
      const sample = phrase[at % phrase.length] * envelope;
      peak = Math.max(peak, Math.abs(sample));squares += sample * sample;
      view.setInt16(44 + at * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    onProgress?.({phase: 'encode', completed: end, total: frames});await yieldControl();
  }
  abort(signal);
  return {blob: new Blob([buffer], {type: 'audio/wav'}), durationSeconds: checked.durationSeconds, sampleRate: BGM_SAMPLE_RATE, channels: 1, preset: checked.preset, seed: checked.seed, peak, rms: Math.sqrt(squares / frames)};
}
