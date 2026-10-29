export const VOICE_SAMPLE_RATE = 24000;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 180 * 1024 * 1024;

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('음성 생성을 취소했어요.', 'AbortError');
}
async function abortable(promise, signal) {
  checkAbort(signal);
  if (!signal) return promise;
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = () => reject(new DOMException('음성 생성을 취소했어요.', 'AbortError'));
      signal.addEventListener('abort', listener, {once: true});
    })]);
  } finally {signal.removeEventListener('abort', listener);}
}
function decodeBase64(chunk) {
  if (!chunk || !['audio/mpeg', 'audio/wav', 'audio/x-wav'].includes(chunk.mimeType) ||
      typeof chunk.audio !== 'string' || !chunk.audio || chunk.audio.length % 4 ||
      chunk.audio.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.audio)) {
    throw new Error('음성 생성 결과의 파일 형식이 올바르지 않아요.');
  }
  const binary = atob(chunk.audio);
  if (btoa(binary) !== chunk.audio) throw new Error('음성 생성 결과를 읽을 수 없어요.');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/** Decode every real provider chunk, then render continuous mono PCM. MP3 bytes
 * cannot simply be concatenated: decoder padding and headers are not a timeline. */
export async function combineVoiceChunks(chunks, {signal} = {}) {
  checkAbort(signal);
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > 100) throw new Error('생성된 음성 구간을 확인해 주세요.');
  const OfflineContext = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineContext) throw new Error('이 브라우저에서는 음성 파일을 합칠 수 없어요. 최신 Chrome을 사용해 주세요.');
  const decoder = new OfflineContext(1, 1, VOICE_SAMPLE_RATE);
  const buffers = [];let inputBytes = 0, frames = 0;
  for (const chunk of chunks) {
    checkAbort(signal);
    const bytes = decodeBase64(chunk);inputBytes += bytes.length;
    if (inputBytes > MAX_INPUT_BYTES) throw new Error('생성된 음성 데이터가 너무 큽니다. 대본을 나누어 만들어 주세요.');
    let buffer;
    try {buffer = await abortable(decoder.decodeAudioData(bytes.buffer), signal);}
    catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new Error('생성된 음성을 재생 가능한 파일로 읽지 못했어요. 기존 음성은 유지돼요.');
    }
    checkAbort(signal);
    if (!buffer?.length || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 8 || buffer.sampleRate !== VOICE_SAMPLE_RATE) {
      throw new Error('생성된 음성의 채널·샘플 정보를 확인해 주세요.');
    }
    frames += buffer.length;
    if (frames / VOICE_SAMPLE_RATE > 3600 || 44 + frames * 2 > MAX_OUTPUT_BYTES) {
      throw new Error('음성은 최대 60분·180MiB까지 만들 수 있어요. 대본을 나누어 주세요.');
    }
    buffers.push(buffer);
  }
  const context = new OfflineContext(1, frames, VOICE_SAMPLE_RATE);
  const nodes = [];let cursor = 0;
  for (const buffer of buffers) {
    const source = context.createBufferSource(), splitter = context.createChannelSplitter(buffer.numberOfChannels);
    source.buffer = buffer;source.connect(splitter);nodes.push(source, splitter);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const gain = context.createGain();gain.gain.value = 1 / buffer.numberOfChannels;
      splitter.connect(gain, channel);gain.connect(context.destination);nodes.push(gain);
    }
    source.start(cursor / VOICE_SAMPLE_RATE);cursor += buffer.length;
  }
  let rendered;
  try {rendered = await abortable(context.startRendering(), signal);}
  finally {for (const node of nodes) {try {node.disconnect();} catch {}}}
  checkAbort(signal);
  const bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes);
  const ascii = (offset, value) => {for (let at = 0; at < value.length; at++) view.setUint8(offset + at, value.charCodeAt(at));};
  ascii(0, 'RIFF');view.setUint32(4, bytes.byteLength - 8, true);ascii(8, 'WAVE');ascii(12, 'fmt ');
  view.setUint32(16, 16, true);view.setUint16(20, 1, true);view.setUint16(22, 1, true);
  view.setUint32(24, VOICE_SAMPLE_RATE, true);view.setUint32(28, VOICE_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);view.setUint16(34, 16, true);ascii(36, 'data');view.setUint32(40, frames * 2, true);
  const samples = rendered.getChannelData(0);
  for (let at = 0; at < samples.length; at++) {
    if (!Number.isFinite(samples[at])) throw new Error('생성된 음성에 손상된 샘플이 있어요.');
    const value = Math.max(-1, Math.min(1, samples[at]));
    view.setInt16(44 + at * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    if (at > 0 && at % 1048576 === 0) {await new Promise(resolve => setTimeout(resolve, 0));checkAbort(signal);}
  }
  checkAbort(signal);
  return new Blob([bytes], {type: 'audio/wav'});
}
