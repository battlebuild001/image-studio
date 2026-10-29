// Speech captions keep the recognizer's time boundaries. Never infer word times
// from the number of characters in a transcript.
const SAMPLE_RATE = 16000;
const MAX_CUES = 10000;

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('음성 분석을 취소했어요.', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal);
}

async function abortable(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = () => reject(abortError(signal));
      signal.addEventListener('abort', listener, {once: true});
    })]);
  } finally {
    signal.removeEventListener('abort', listener);
  }
}

function audioInfo(buffer, {start = 0, end = buffer?.duration} = {}) {
  if (!buffer || !Number.isInteger(buffer.length) || buffer.length < 1 ||
      !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 ||
      !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 ||
      buffer.numberOfChannels > 32 || typeof buffer.getChannelData !== 'function') {
    throw new Error('내레이션의 음성 데이터를 읽을 수 없어요. 파일을 다시 넣어주세요.');
  }
  const duration = buffer.length / buffer.sampleRate;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 ||
      end <= start || end > duration + 1 / buffer.sampleRate) {
    throw new Error('분석할 음성의 시작·종료 범위를 확인해 주세요.');
  }
  end = Math.min(end, duration);
  const channels = Array.from({length: buffer.numberOfChannels}, (_, index) => buffer.getChannelData(index));
  if (channels.some(channel => !channel || channel.length < buffer.length)) {
    throw new Error('내레이션의 음성 데이터가 올바르지 않아요.');
  }
  return {start, end, duration, channels, sampleRate: buffer.sampleRate};
}

// Prefer a quiet boundary near the end of a chunk. Chunks remain contiguous,
// with no overlap, so subsequent recognizer responses cannot duplicate a word.
export function planAudioChunks(buffer, {start = 0, end = buffer?.duration, maxSeconds = 300} = {}) {
  const info = audioInfo(buffer, {start, end});
  if (!Number.isFinite(maxSeconds) || maxSeconds < 0.1 || maxSeconds > 300) {
    throw new Error('음성은 한 번에 300초 이하로 나눠 분석해야 해요.');
  }
  const ranges = [];
  let cursor = info.start;
  while (info.end - cursor > maxSeconds + 1e-8) {
    const limit = cursor + maxSeconds;
    const searchStart = limit - Math.min(5, maxSeconds * 0.1);
    const step = Math.max(1, Math.round(info.sampleRate * 0.02));
    const sampleEnd = Math.floor(limit * info.sampleRate);
    const sampleStart = Math.ceil(searchStart * info.sampleRate);
    let bestEnergy = Infinity;
    let bestSample = sampleEnd;
    let energyTotal = 0;
    let windows = 0;
    for (let at = sampleStart; at + step <= sampleEnd; at += step) {
      let sum = 0;
      for (const channel of info.channels) {
        for (let sample = at; sample < at + step; sample++) sum += channel[sample] * channel[sample];
      }
      const energy = sum / (step * info.channels.length);
      energyTotal += energy;
      windows++;
      // Later equally quiet windows keep chunks as close to their limit as possible.
      if (energy <= bestEnergy) {
        bestEnergy = energy;
        bestSample = at + Math.floor(step / 2);
      }
    }
    const meanEnergy = windows ? energyTotal / windows : 0;
    const quiet = bestEnergy <= 1e-14 || bestEnergy <= Math.min(0.002 ** 2, meanEnergy * 0.04);
    const boundary = quiet ? bestSample / info.sampleRate : limit;
    ranges.push({start: cursor, end: boundary});
    cursor = boundary;
  }
  ranges.push({start: cursor, end: info.end});
  return ranges;
}

// Only skip digital silence (below practical PCM quantization), never quiet
// speech. VAD/energy is not used to fabricate any caption timing.
export function isSilentAudioChunk(buffer, range = {}) {
  const info = audioInfo(buffer, range);
  const first = Math.floor(info.start * info.sampleRate);
  const last = Math.min(buffer.length, Math.ceil(info.end * info.sampleRate));
  for (const channel of info.channels) {
    for (let index = first; index < last; index++) {
      if (!Number.isFinite(channel[index]) || Math.abs(channel[index]) > 1e-7) return false;
    }
  }
  return true;
}

export function encodePcm16Wav(samples, sampleRate = SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) || samples.length < 1 ||
      !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
      samples.length > 300 * sampleRate) {
    throw new Error('변환할 음성 데이터의 형식이나 길이를 확인해 주세요.');
  }
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  function ascii(offset, text) {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  }
  ascii(0, 'RIFF');view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, 'WAVE');ascii(12, 'fmt ');view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);view.setUint16(34, 16, true);
  ascii(36, 'data');view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    if (!Number.isFinite(samples[index])) throw new Error('음성에 손상된 샘플이 있어요. 파일을 다시 넣어주세요.');
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], {type: 'audio/wav'});
}

export async function encodeAudioChunk(buffer, range, {signal} = {}) {
  checkAbort(signal);
  const info = audioInfo(buffer, range);
  if (info.end - info.start > 300 + 1e-7) throw new Error('음성을 300초 이하로 나눠 주세요.');
  const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('이 브라우저는 음성 변환을 지원하지 않아요. 최신 Chrome을 사용해 주세요.');
  const length = Math.max(1, Math.round((info.end - info.start) * SAMPLE_RATE));
  const context = new OfflineContext(1, length, SAMPLE_RATE);
  const source = context.createBufferSource();
  const splitter = context.createChannelSplitter(buffer.numberOfChannels);
  source.buffer = buffer;
  source.connect(splitter);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const gain = context.createGain();
    gain.gain.value = 1 / buffer.numberOfChannels;
    splitter.connect(gain, channel);
    gain.connect(context.destination);
  }
  source.start(0, info.start, length / SAMPLE_RATE);
  const rendered = await abortable(context.startRendering(), signal);
  checkAbort(signal);
  return encodePcm16Wav(rendered.getChannelData(0));
}

export async function toBase64(blob, {signal} = {}) {
  checkAbort(signal);
  if (!(blob instanceof Blob)) throw new Error('전송할 음성 파일이 올바르지 않아요.');
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const cancel = () => reader.abort();
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      reader.onload = () => {cleanup();resolve(String(reader.result).split(',')[1]);};
      reader.onerror = () => {cleanup();reject(new Error('음성 파일을 읽지 못했어요.'));};
      reader.onabort = () => {cleanup();reject(abortError(signal));};
      signal?.addEventListener('abort', cancel, {once: true});
      reader.readAsDataURL(blob);
    });
  }
  const bytes = new Uint8Array(await abortable(blob.arrayBuffer(), signal));
  const pieces = [];
  for (let at = 0; at < bytes.length; at += 32768) pieces.push(String.fromCharCode(...bytes.subarray(at, at + 32768)));
  checkAbort(signal);
  return btoa(pieces.join(''));
}

function validateTimedItems(items, duration, textKey) {
  if (!Array.isArray(items) || items.length > 50000) throw new Error('음성 인식의 시간 정보가 올바르지 않아요.');
  let previousStart = -Infinity;
  return items.map(item => {
    if (!item || typeof item[textKey] !== 'string' ||
        !Number.isFinite(item.start) || !Number.isFinite(item.end) ||
        item.start < 0 || item.end < item.start || item.end > duration + 0.001 ||
        item.start < previousStart) {
      throw new Error('음성 인식의 시간 정보가 음성 길이나 순서에 맞지 않아요.');
    }
    previousStart = item.start;
    return {start: item.start, end: Math.min(duration, item.end), text: item[textKey].trim()};
  }).filter(item => item.text);
}

function fallbackWordText(words) {
  return words.map((word, index) => ({...word, spaceBefore: index > 0 && !/^[,.;:!?…。，、！？)\]}”’]/u.test(word.text)}));
}

// Restore punctuation and Korean spacing from the actual full transcript when
// its word sequence matches, including unspaced Korean subword boundaries.
function alignWordText(words, transcript) {
  if (!transcript || !words.length) return fallbackWordText(words);
  let cursor = 0;
  const matches = [];
  for (const word of words) {
    const at = transcript.indexOf(word.text, cursor);
    if (at < 0 || /[\p{L}\p{N}]/u.test(transcript.slice(cursor, at))) return fallbackWordText(words);
    matches.push({...word, at, after: at + word.text.length});
    cursor = at + word.text.length;
  }
  if (/[\p{L}\p{N}]/u.test(transcript.slice(cursor))) return fallbackWordText(words);
  return matches.map((word, index) => {
    const next = matches[index + 1];
    const trailing = transcript.slice(word.after, next ? next.at : transcript.length);
    const previous = matches[index - 1];
    return {...word,
      text: `${index === 0 ? transcript.slice(0, word.at) : ''}${word.text}${trailing}`.trim(),
      spaceBefore: index > 0 && /\s/u.test(transcript.slice(previous.after, word.at)),
    };
  });
}

export function groupTimedTranscript(result, {sourceStart = 0, maxChars = 42, maxDuration = 5, maxGap = 0.65} = {}) {
  if (!result || !Number.isFinite(result.duration) || result.duration <= 0 ||
      typeof result.text !== 'string' || !Number.isFinite(sourceStart) || sourceStart < 0 ||
      !Number.isInteger(maxChars) || maxChars < 5 || maxChars > 200 ||
      !Number.isFinite(maxDuration) || maxDuration <= 0 || !Number.isFinite(maxGap) || maxGap < 0) {
    throw new Error('음성 인식 결과와 자막 설정을 확인해 주세요.');
  }
  const words = validateTimedItems(result.words ?? [], result.duration, 'word');
  const segments = validateTimedItems(result.segments ?? [], result.duration, 'text');
  if (!words.length) {
    if (!segments.length) {
      if (result.text.trim()) throw new Error('실제 발화 시간 정보가 없어서 자막을 맞출 수 없어요. 다시 분석해 주세요.');
      return [];
    }
    if (segments.length > MAX_CUES || segments.some(item => item.end <= item.start)) {
      throw new Error('음성 인식의 구간 시간을 확인해 주세요.');
    }
    return segments.map(item => ({start: sourceStart + item.start, end: sourceStart + item.end, text: item.text}));
  }
  const timedWords = alignWordText(words, result.text);
  const cues = [];
  let active = null;
  let sentenceEnd = false;
  const push = () => {
    if (!active) return;
    if (active.end <= active.start) {
      if (!cues.length) return;
      const previous = cues[cues.length - 1];
      previous.text += `${active.spaceBefore ? ' ' : ''}${active.text}`;
      previous.end = Math.max(previous.end, active.end);
    } else cues.push({start: active.start, end: active.end, text: active.text});
    active = null;
    if (cues.length > MAX_CUES) throw new Error('인식된 자막이 너무 많아요. 분석 범위를 줄여주세요.');
  };
  for (const word of timedWords) {
    const start = sourceStart + word.start;
    const end = sourceStart + word.end;
    const addition = `${word.spaceBefore ? ' ' : ''}${word.text}`;
    const overlap = active && start < active.end;
    if (active && active.end > active.start && !overlap && (sentenceEnd || start - active.end >= maxGap ||
        [...active.text + addition].length > maxChars || end - active.start > maxDuration)) push();
    if (!active) active = {start, end, text: word.text, spaceBefore: word.spaceBefore};
    else {active.text += addition;active.end = Math.max(active.end, end);}
    sentenceEnd = /[.!?。！？][”’"')\]}]*$/u.test(word.text);
  }
  push();
  if (!cues.length) throw new Error('발화 시간이 비어 있어서 자막을 맞출 수 없어요. 다시 분석해 주세요.');
  return cues;
}
