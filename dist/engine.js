/**
 * Browser-only image video renderer.
 * Uploaded images/audio stay in the browser. No remote codecs or paid APIs.
 * Native MediaRecorder writes genuine MP4 when supported, otherwise WebM is an
 * explicit user choice. Export runs in real time and stops if the tab is hidden.
 */
import {getTimeline, getCaptions} from './project.js';

const FONT = '"Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = p => p * p * (3 - 2 * p);
const memo = new WeakMap();
const transitions = new WeakMap();
const MP4_TYPES = [
  'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
  'video/mp4;codecs=avc1.42002a,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1.4d002a,opus',
  'video/mp4',
];
const WEBM_TYPES = [
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('영상 만들기를 취소했습니다.', 'AbortError');
}

function snapshot(project) {
  const signature = [project.captionMode, project.aspect,
    ...(project.scenes || []).map(s => `${s.id}|${s.duration}|${s.caption || ''}|${s.imageId || ''}|${s.motion}|${s.fit}`),
    ...(project.captionMode === 'srt' ? project.captions || [] : []).map(c => `${c.start}|${c.end}|${c.text}`),
  ].join('\u0001');
  let cached = memo.get(project);
  if (!cached || cached.signature !== signature) {
    cached = {signature, ...getTimeline(project), captions: getCaptions(project)};
    memo.set(project, cached);
  }
  return cached;
}

export function getDuration(project) { return getTimeline(project).duration; }

export function getSceneAt(project, time = 0) {
  const timeline = snapshot(project);
  if (!timeline.scenes.length) return null;
  const t = clamp(Number(time) || 0, 0, Math.max(0, timeline.duration - 0.000001));
  const index = Math.max(0, timeline.scenes.findIndex(s => t < s.end));
  const scene = timeline.scenes[index];
  const localTime = clamp(t - scene.start, 0, scene.duration);
  return {scene, index, start: scene.start, end: scene.end, duration: scene.duration,
    localTime, progress: scene.duration > 0 ? localTime / scene.duration : 0};
}

/** Decode local assets once; does not require microphone/camera permission. */
export async function prepareAssets(assets, {signal} = {}) {
  for (const asset of assets.values()) {
    checkAbort(signal);
    const type = asset.blob?.type || asset.type || '';
    if ((type.startsWith('image/') || type === 'image' || /\.(png|jpe?g|webp|gif|avif)$/i.test(asset.name || '')) && !asset.image) {
      if (!asset.url && asset.blob) asset.url = URL.createObjectURL(asset.blob);
      try {
        if (typeof createImageBitmap === 'function' && asset.blob) {
          try {asset.image = await createImageBitmap(asset.blob);} catch {
            const img = new Image();img.src = asset.url;await img.decode();asset.image = img;
          }
        } else {
          const img = new Image();
          img.src = asset.url;
          await img.decode();
          asset.image = img;
        }
      } catch {
        throw new Error(`이미지 “${asset.name || '선택한 파일'}”를 읽을 수 없습니다. PNG 또는 JPG로 다시 넣어 주세요.`);
      }
    }
    if ((type.startsWith('audio/') || type === 'audio' || /\.(wav|mp3|m4a|aac|ogg|opus|flac)$/i.test(asset.name || '')) && !asset.audioBuffer && asset.blob) {
      const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
      if (!OfflineCtx) throw new Error('이 브라우저에서는 오디오를 처리할 수 없습니다. 최신 Chrome 또는 Edge를 사용해 주세요.');
      try {
        const decoder = new OfflineCtx(2, 1, 48000);
        asset.audioBuffer = await decoder.decodeAudioData(await asset.blob.arrayBuffer());
        asset.duration = asset.audioBuffer.duration;
      } catch {
        throw new Error(`음성 “${asset.name || '선택한 파일'}”를 읽을 수 없습니다. MP3 또는 WAV로 다시 넣어 주세요.`);
      }
    }
  }
  checkAbort(signal);
  return assets;
}

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawEmpty(ctx, width, height, index = 0) {
  const scale = Math.min(width, height) / 1080;
  ctx.fillStyle = '#111519';
  ctx.fillRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#1b2021');
  gradient.addColorStop(1, '#0b0e10');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#ffffff0b';
  ctx.lineWidth = Math.max(1, scale);
  const spacing = 94 * scale;
  for (let x = -height; x < width; x += spacing) {
    ctx.beginPath();ctx.moveTo(x, 0);ctx.lineTo(x + height, height);ctx.stroke();
  }
  const line = 40 * scale;
  ctx.strokeStyle = '#c9d2ae';ctx.lineWidth = 3 * scale;
  ctx.beginPath();
  ctx.moveTo(width / 2 - line / 2, height * 0.43);ctx.lineTo(width / 2 + line / 2, height * 0.43);
  ctx.moveTo(width / 2, height * 0.43 - line / 2);ctx.lineTo(width / 2, height * 0.43 + line / 2);ctx.stroke();
  ctx.textAlign = 'center';ctx.fillStyle = '#d8dcd4';
  ctx.font = `600 ${34 * scale}px ${FONT}`;
  ctx.fillText('이미지를 붙여넣어 주세요', width / 2, height * 0.53);
  ctx.fillStyle = '#7f8b8b';ctx.font = `500 ${20 * scale}px ${FONT}`;
  ctx.fillText(`SCENE ${String(index + 1).padStart(2, '0')}`, width / 2, height * 0.59);
}

function drawScene(ctx, scene, assets, progress, width, height, index) {
  const image = assets.get(scene.imageId)?.image;
  const iw = image?.naturalWidth || image?.width || 0;
  const ih = image?.naturalHeight || image?.height || 0;
  if (!image || !iw || !ih) {drawEmpty(ctx, width, height, index);return;}
  const p = ease(clamp(progress));
  const fit = scene.fit === 'contain' ? 'contain' : 'cover';
  const baseScale = fit === 'contain' ? Math.min(width / iw, height / ih) : Math.max(width / iw, height / ih);
  let zoom = 1, px = 0.5, py = 0.5;
  switch (scene.motion) {
    case 'zoom-in': zoom = lerp(fit === 'contain' ? 0.9 : 1, fit === 'contain' ? 1 : 1.12, p);break;
    case 'zoom-out': zoom = lerp(fit === 'contain' ? 1 : 1.12, fit === 'contain' ? 0.9 : 1, p);break;
    case 'pan-left': zoom = fit === 'contain' ? 0.92 : 1.12;px = fit === 'contain' ? lerp(0.8, 0.2, p) : lerp(0.2, 0.8, p);break;
    case 'pan-right': zoom = fit === 'contain' ? 0.92 : 1.12;px = fit === 'contain' ? lerp(0.2, 0.8, p) : lerp(0.8, 0.2, p);break;
    default: break;
  }
  const dw = iw * baseScale * zoom, dh = ih * baseScale * zoom;
  ctx.save();ctx.beginPath();ctx.rect(0, 0, width, height);ctx.clip();
  ctx.fillStyle = '#080b0d';ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, (width - dw) * px, (height - dh) * py, dw, dh);
  ctx.restore();
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || '').split('\n')) {
    if (!paragraph.trim()) continue;
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const joined = line ? `${line} ${word}` : word;
      if (ctx.measureText(joined).width <= maxWidth) {line = joined;continue;}
      if (line) {lines.push(line);line = '';}
      if (ctx.measureText(word).width <= maxWidth) {line = word;continue;}
      for (const character of Array.from(word)) {
        if (line && ctx.measureText(line + character).width > maxWidth) {lines.push(line);line = '';}
        line += character;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawCaption(ctx, text, settings, width, height) {
  if (!text?.trim()) return;
  const scale = Math.min(width, height) / 1080;
  const maxWidth = width * (width < height ? 0.82 : 0.84);
  let fontSize = clamp(Number(settings.fontSize) || 48, 20, 100) * scale;
  const minimum = 18 * scale;
  ctx.textAlign = 'center';ctx.textBaseline = 'middle';
  let lines;
  do {
    ctx.font = `600 ${fontSize}px ${FONT}`;
    lines = wrapText(ctx, text, maxWidth);
    if (lines.length <= 2 || fontSize <= minimum) break;
    fontSize = Math.max(minimum, fontSize - 2 * scale);
  } while (true);
  const lineHeight = fontSize * 1.45;
  const paddingX = 28 * scale, paddingY = 15 * scale;
  const panelWidth = Math.min(width * 0.94, Math.max(...lines.map(line => ctx.measureText(line).width), 0) + paddingX * 2);
  const panelHeight = lines.length * lineHeight + paddingY * 2;
  const bottom = height * (width < height ? 0.14 : 0.07);
  const top = Math.max(height * 0.12, height - bottom - panelHeight);
  ctx.fillStyle = 'rgba(7,10,13,0.83)';
  roundedRect(ctx, (width - panelWidth) / 2, top, panelWidth, panelHeight, 10 * scale);ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';ctx.lineWidth = scale;ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.65)';ctx.shadowBlur = 4 * scale;ctx.shadowOffsetY = scale;
  lines.forEach((line, i) => ctx.fillText(line, width / 2, top + paddingY + (i + 0.5) * lineHeight));
  ctx.shadowBlur = 0;ctx.shadowOffsetY = 0;
}

/** Synchronous renderer used by both preview and the export canvas. */
export function renderFrame(ctx, project, assets, time = 0, width = ctx.canvas.width, height = ctx.canvas.height) {
  if (!ctx || !width || !height) return;
  const settings = project.settings || {};
  const state = snapshot(project);
  const t = clamp(Number(time) || 0, 0, Math.max(0, state.duration - 0.000001));
  const current = getSceneAt(project, t);
  ctx.save();ctx.setTransform(1, 0, 0, 1, 0, 0);ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);
  if (!current) drawEmpty(ctx, width, height, 0);
  else {
    drawScene(ctx, current.scene, assets, current.progress, width, height, current.index);
    const next = state.scenes[current.index + 1];
    const transition = Math.min(clamp(Number(settings.transition) || 0, 0, 3), current.duration / 2, (next?.duration || 0) / 2);
    if (next && transition > 0 && t >= current.end - transition) {
      let surface = transitions.get(ctx);
      if (!surface || surface.width !== width || surface.height !== height) {
        const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
        canvas.width = width;canvas.height = height;
        surface = {canvas, ctx: canvas.getContext('2d', {alpha: false}), width, height};
        transitions.set(ctx, surface);
      }
      drawScene(surface.ctx, next, assets, 0, width, height, current.index + 1);
      ctx.save();ctx.globalAlpha = ease(clamp((t - current.end + transition) / transition));
      ctx.drawImage(surface.canvas, 0, 0);ctx.restore();
    }
  }
  // Very light edge shading helps white titles without obscuring the user's image.
  const shade = ctx.createLinearGradient(0, 0, 0, height * 0.22);
  shade.addColorStop(0, settings.branding ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0)');ctx.fillStyle = shade;ctx.fillRect(0, 0, width, height * 0.22);
  const scale = Math.min(width, height) / 1080;
  if (settings.branding) {
    const x = width * 0.045, y = height * 0.055;
    ctx.fillStyle = '#d2dbb3';ctx.fillRect(x, y, 4 * scale, 26 * scale);
    ctx.textAlign = 'left';ctx.textBaseline = 'middle';
    ctx.font = `700 ${20 * scale}px ${FONT}`;ctx.fillStyle = '#f2f4ef';
    ctx.fillText('BATTLE TABLE HOBBY', x + 16 * scale, y + 13 * scale);
    if (project.title) {
      ctx.font = `500 ${18 * scale}px ${FONT}`;ctx.fillStyle = '#d4d8d2';
      const titleLines = wrapText(ctx, project.title, width * 0.7);
      ctx.fillText(titleLines[0] || '', x + 16 * scale, y + 43 * scale);
    }
  }
  if (settings.subtitles !== false) {
    const cue = state.captions.find(caption => t >= caption.start && t < caption.end);
    if (cue) drawCaption(ctx, cue.text, settings, width, height);
  }
  ctx.restore();
}

export async function getExportCapabilities() {
  const recorder = typeof MediaRecorder !== 'undefined';
  const canvasStream = typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  const supported = types => recorder ? types.filter(type => {try {return MediaRecorder.isTypeSupported(type);} catch {return false;}}) : [];
  const mp4Types = canvasStream ? supported(MP4_TYPES) : [];
  const webmTypes = canvasStream ? supported(WEBM_TYPES) : [];
  return {
    mp4: mp4Types.length > 0, webm: webmTypes.length > 0,
    mp4Fast: false, mp4Realtime: mp4Types.length > 0, realtime: true,
    mp4Mime: mp4Types[0] || null, webmMime: webmTypes[0] || null,
    mp4Types, webmTypes,
    reason: !recorder || !canvasStream ? '이 브라우저는 영상 내보내기를 지원하지 않습니다. 최신 Chrome 또는 Edge로 열어 주세요.'
      : !mp4Types.length ? '이 브라우저에서는 WebM으로 저장할 수 있습니다. MP4는 지원하는 Chrome 또는 Edge에서 선택해 주세요.' : '',
  };
}

function connectAudio(context, destination, asset, volume, loop, startAt, duration) {
  if (!asset?.audioBuffer) return null;
  const source = context.createBufferSource();source.buffer = asset.audioBuffer;source.loop = loop;
  const gain = context.createGain();gain.gain.setValueAtTime(clamp(volume, 0, 2), startAt);
  source.connect(gain);gain.connect(destination);
  source.start(startAt);
  // Stop at the video boundary even if narration is longer. A short narration
  // naturally ends and the remaining pictures/music continue to the boundary.
  source.stop(startAt + duration);
  return {source, gain};
}

/**
 * Record a complete, playable browser-native MP4/WebM with mixed local audio.
 * onProgress: { phase: 'prepare'|'render'|'finalize', progress: 0..1, message }.
 * No microphone, camera or screen-capture permissions are requested.
 */
export async function exportVideo({project, assets, format = 'mp4', width = 1920, height = 1080,
  fps = 30, onProgress = () => {}, signal} = {}) {
  checkAbort(signal);
  if (!project?.scenes?.length) throw new Error('먼저 장면과 이미지를 추가해 주세요.');
  if (!['mp4', 'webm'].includes(format)) throw new Error('지원하지 않는 영상 형식입니다.');
  if (document.visibilityState === 'hidden') throw new Error('영상 만들기를 시작하려면 이 편집기 탭을 열어 주세요.');
  const duration = getDuration(project);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('영상 길이를 확인해 주세요.');
  width = Math.max(240, Math.min(3840, Math.round(width / 2) * 2));
  height = Math.max(240, Math.min(3840, Math.round(height / 2) * 2));
  fps = clamp(Number(fps) || 30, 12, 60);
  const caps = await getExportCapabilities();
  const mimeTypes = format === 'mp4' ? caps.mp4Types : caps.webmTypes;
  if (!mimeTypes.length) throw new Error(format === 'mp4' ? '이 브라우저는 MP4 출력을 지원하지 않습니다. WebM을 선택하거나 최신 Chrome/Edge에서 다시 열어 주세요.' : caps.reason || '이 브라우저는 WebM 출력을 지원하지 않습니다.');
  onProgress({phase: 'prepare', progress: 0, message: '이미지와 음성을 준비하고 있어요.'});
  await prepareAssets(assets, {signal});
  await document.fonts?.ready;
  checkAbort(signal);
  if (document.visibilityState === 'hidden') throw new Error('영상 만들기를 시작하려면 이 편집기 탭을 열어 주세요.');
  const missing = project.scenes.findIndex(scene => !assets.get(scene.imageId)?.image);
  if (missing >= 0) throw new Error(`${missing + 1}번 장면에 이미지를 넣어 주세요.`);
  const narration = project.audio?.narrationId ? assets.get(project.audio.narrationId) : null;
  const bgm = project.audio?.bgmId ? assets.get(project.audio.bgmId) : null;
  if (project.audio?.narrationId && !narration?.audioBuffer) throw new Error('내레이션 파일을 다시 넣어 주세요.');
  if (project.audio?.bgmId && !bgm?.audioBuffer) throw new Error('배경음악 파일을 다시 넣어 주세요.');
  const frozenProject = structuredClone(project);
  const canvas = document.createElement('canvas');canvas.width = width;canvas.height = height;
  const ctx = canvas.getContext('2d', {alpha: false});
  renderFrame(ctx, frozenProject, assets, 0, width, height);
  // Manual capture avoids the canvas/compositor's automatic capture cadence,
  // which can drop to 1 FPS for a detached export canvas in some browsers.
  let videoStream = canvas.captureStream(0);
  if (typeof videoStream.getVideoTracks()[0]?.requestFrame !== 'function') {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = canvas.captureStream(fps);
  }
  const videoTrack = videoStream.getVideoTracks()[0];
  let audioContext = null, destination = null, recorder = null, wakeLock = null;
  let frameTimer = 0, endTimer = 0, startTimer = 0;
  let stopped = false, hiddenError = null, stopListener = null, abortListener = null, visibilityListener = null;
  const audioNodes = [], chunks = [];
  const combinedStream = new MediaStream(videoStream.getVideoTracks());
  const cleanup = async () => {
    clearTimeout(frameTimer);clearTimeout(endTimer);clearTimeout(startTimer);
    if (visibilityListener) document.removeEventListener('visibilitychange', visibilityListener);
    if (abortListener) signal?.removeEventListener('abort', abortListener);
    for (const {source, gain} of audioNodes) {try {source.stop();} catch {}source.disconnect();gain.disconnect();}
    for (const track of combinedStream.getTracks()) track.stop();
    for (const track of videoStream.getTracks()) track.stop();
    if (destination) for (const track of destination.stream.getTracks()) track.stop();
    if (audioContext && audioContext.state !== 'closed') await audioContext.close().catch(() => {});
    if (wakeLock) await wakeLock.release().catch(() => {});
    canvas.width = 1;canvas.height = 1;
  };
  try {
    if (narration?.audioBuffer || bgm?.audioBuffer) {
      const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioCtx) throw new Error('이 브라우저에서는 음성을 영상에 넣을 수 없습니다. 최신 Chrome/Edge를 사용해 주세요.');
      audioContext = new AudioCtx();await audioContext.resume();
      if (audioContext.state !== 'running') throw new Error('음성 재생을 시작할 수 없습니다. 편집기의 재생 버튼을 한 번 누른 뒤 다시 저장해 주세요.');
      destination = audioContext.createMediaStreamDestination();
      destination.stream.getAudioTracks().forEach(track => combinedStream.addTrack(track));
    }
    // Keep the screen awake where the browser supports it. Visibility is also
    // checked separately: a hidden tab must never silently create frozen video.
    if (navigator.wakeLock?.request) {
      try {wakeLock = await navigator.wakeLock.request('screen');} catch {}
    }
    checkAbort(signal);
    if (document.visibilityState === 'hidden') throw new Error('영상 만들기를 시작하려면 이 편집기 탭을 열어 주세요.');
    const bitrate = Math.round(clamp(width * height * fps * 0.085, 2500000, 9000000));
    let lastError;
    for (const mimeType of mimeTypes) {
      try {recorder = new MediaRecorder(combinedStream, {mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000});break;}
      catch (error) {lastError = error;}
    }
    if (!recorder) throw new Error(`이 기기에서 ${format.toUpperCase()} 인코더를 시작할 수 없습니다. ${format === 'mp4' ? 'WebM 형식을 선택해 주세요.' : '해상도를 낮춰 다시 시도해 주세요.'}`, {cause: lastError});
    const outputMime = recorder.mimeType || mimeTypes[0];
    if (!outputMime.toLowerCase().startsWith(`video/${format}`)) throw new Error('브라우저가 요청한 영상 형식을 지원하지 않습니다. 다른 형식을 선택해 주세요.');
    const completed = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', event => {if (event.data?.size) chunks.push(event.data);});
      recorder.addEventListener('error', event => {
        stopped = true;clearTimeout(frameTimer);clearTimeout(endTimer);
        reject(event.error || new Error('영상 인코딩 중 오류가 발생했습니다. 해상도를 낮춰 다시 시도해 주세요.'));
      });
      stopListener = () => {
        if (signal?.aborted) reject(new DOMException('영상 만들기를 취소했습니다.', 'AbortError'));
        else if (hiddenError) reject(hiddenError);
        else if (!chunks.length) reject(new Error('영상 파일이 비어 있습니다. 다른 형식을 선택해 다시 시도해 주세요.'));
        else resolve(new Blob(chunks, {type: outputMime}));
      };
      recorder.addEventListener('stop', stopListener, {once: true});
    });
    // Attach a handler immediately so early encoder errors never become an
    // unhandled rejected promise while waiting for the recorder's start event.
    completed.catch(() => {});
    const stop = () => {
      if (stopped) return;stopped = true;
      clearTimeout(frameTimer);clearTimeout(endTimer);clearTimeout(startTimer);
      if (recorder.state !== 'inactive') recorder.stop();
    };
    abortListener = stop;
    signal?.addEventListener('abort', abortListener, {once: true});
    visibilityListener = () => {
      if (document.visibilityState === 'hidden') {
        hiddenError = new Error('다른 탭으로 이동해 영상 만들기를 중단했습니다. 이 탭을 열어 둔 상태에서 다시 저장해 주세요.');
        stop();
      }
    };
    document.addEventListener('visibilitychange', visibilityListener);
    let didStart = false;
    const started = new Promise((resolve, reject) => {
      recorder.addEventListener('start', () => {didStart = true;clearTimeout(startTimer);resolve();}, {once: true});
      recorder.addEventListener('error', event => reject(event.error || new Error('영상 인코더를 시작할 수 없습니다.')), {once: true});
      recorder.addEventListener('stop', () => {
        if (!didStart) reject(signal?.aborted ? new DOMException('영상 만들기를 취소했습니다.', 'AbortError') : hiddenError || new Error('영상 인코더를 시작할 수 없습니다. 다른 형식이나 해상도를 선택해 주세요.'));
      }, {once: true});
      startTimer = setTimeout(() => reject(new Error('영상 인코더가 응답하지 않습니다. 페이지를 새로 고친 뒤 다시 시도해 주세요.')), 10000);
    });
    started.catch(() => {});
    recorder.start(250);
    // Some encoders emit `start` only after receiving the first video/audio
    // sample. Start both producers before awaiting that event to avoid a
    // circular wait on an otherwise idle canvas and silent audio destination.
    checkAbort(signal);
    const lead = audioContext ? 0.03 : 0;
    const clockStart = audioContext ? audioContext.currentTime + lead : performance.now() / 1000;
    const settings = frozenProject.settings || {};
    if (narration?.audioBuffer) audioNodes.push(connectAudio(audioContext, destination, narration, settings.narrationVolume ?? 1, false, clockStart, duration));
    if (bgm?.audioBuffer) audioNodes.push(connectAudio(audioContext, destination, bgm, settings.bgmVolume ?? 0.12, true, clockStart, duration));
    const now = () => (audioContext ? audioContext.currentTime : performance.now() / 1000) - clockStart;
    let lastProgress = -Infinity, finishing = false;
    const finish = () => {
      if (stopped || finishing) return;
      finishing = true;clearTimeout(frameTimer);clearTimeout(endTimer);
      renderFrame(ctx, frozenProject, assets, Math.max(0, duration - 0.0001), width, height);
      videoTrack.requestFrame?.();
      // Give the final frame one encoder tick. Audio is already scheduled to
      // stop at exactly the intended duration; only the last picture is held.
      endTimer = setTimeout(stop, Math.min(40, 1000 / fps));
    };
    const draw = () => {
      if (stopped) return;
      const elapsed = clamp(now(), 0, duration);
      renderFrame(ctx, frozenProject, assets, elapsed, width, height);
      videoTrack.requestFrame?.();
      if (elapsed - lastProgress > 0.1 || elapsed === duration) {
        onProgress({phase: 'render', progress: elapsed / duration,
          message: `영상을 만들고 있어요 · ${Math.floor(elapsed)} / ${Math.ceil(duration)}초`});lastProgress = elapsed;
      }
      if (elapsed >= duration) {finish();return;}
      // Export uses an audio-clock-aligned timer rather than requestAnimationFrame.
      // RAF may be throttled for an off-screen canvas despite an active document.
      const nextFrame = (Math.floor(elapsed * fps) + 1) / fps;
      frameTimer = setTimeout(draw, Math.max(1, (nextFrame - now()) * 1000));
    };
    onProgress({phase: 'render', progress: 0, message: '영상을 만들고 있어요. 이 탭을 열어 두세요.'});
    draw();
    videoTrack.requestFrame?.();
    // A separate end timer preserves the audio boundary even when the device
    // drops a render frame. AudioBufferSource.stop is scheduled exactly above.
    endTimer = setTimeout(finish, (duration + lead) * 1000);
    await started;
    const blob = await completed;
    checkAbort(signal);
    onProgress({phase: 'finalize', progress: 1, message: '영상 파일을 저장하고 있어요.'});
    return {blob, extension: format, mime: outputMime};
  } catch (error) {
    if (recorder && recorder.state !== 'inactive') {
      try {recorder.stop();} catch {}
    }
    if (error?.name === 'AbortError') throw error;
    if (hiddenError) throw hiddenError;
    throw error instanceof Error ? error : new Error('영상 만들기에 실패했습니다. 다시 시도해 주세요.');
  } finally {await cleanup();}
}
