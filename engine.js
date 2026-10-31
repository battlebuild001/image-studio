/**
 * Browser-only image video renderer.
 * Uploaded images/audio stay in the browser. No remote codecs or paid APIs.
 * Native MediaRecorder writes genuine MP4 when supported, otherwise WebM is an
 * explicit user choice. Export runs in real time and stops if the tab is hidden.
 */
import {getTimeline, getCaptions} from './project.js';
import {drawSceneEffect} from './scene-effects.js';

const FONT = '"Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
export const AI_IMAGE_NOTICE_TEXT = '해당 이미지는 이해를 돕기위한 ai 생성 이미지입니다. 본 원작과는 관련이 없습니다.';
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const lerp = (a, b, p) => a + (b - a) * p;
const ease = p => p * p * (3 - 2 * p);
const memo = new WeakMap();
const transitions = new WeakMap();
const audioEnvelopes = new WeakMap();
const CAPTION_FONTS = {sans: FONT, serif: '"Noto Serif KR", "Batang", serif', mono: 'ui-monospace, "D2Coding", monospace'};
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
    ...(project.scenes || []).map(s => `${s.id}|${s.duration}|${s.caption || ''}|${s.imageId || ''}|${s.motion}|${s.fit}|${s.focusX}|${s.focusY}|${s.endX}|${s.endY}|${s.zoomStart}|${s.zoomEnd}|${s.effect}|${s.effectIntensity}`),
    ...(project.captionMode !== 'auto' ? project.captions || [] : []).map(c => `${c.start}|${c.end}|${c.text}`),
    ...(project.captionMode === 'speech' ? [project.audio?.narrationId, project.audio?.narrationStart,
      project.audio?.narrationEnd, project.audio?.narrationOffset, JSON.stringify(project.captionAnalysis)] : []),
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

function drawScene(ctx, scene, assets, progress, width, height, index, localTime = 0) {
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
    case 'subtle-zoom': zoom = lerp(fit === 'contain' ? .975 : 1, fit === 'contain' ? 1 : 1.025, p);break;
    case 'subtle-drift': zoom = fit === 'contain' ? .975 : 1.025;break;
    case 'custom':
      zoom = lerp(clamp(scene.zoomStart ?? 1, 1, 3), clamp(scene.zoomEnd ?? 1.12, 1, 3), p);
      px = lerp(clamp(scene.focusX ?? 0.5), clamp(scene.endX ?? 0.5), p);
      py = lerp(clamp(scene.focusY ?? 0.5), clamp(scene.endY ?? 0.5), p);
      break;
    default: break;
  }
  if (scene.motion !== 'custom') {
    px = clamp(px + (scene.focusX ?? 0.5) - 0.5);
    py = clamp(py + (scene.focusY ?? 0.5) - 0.5);
  }
  const dw = iw * baseScale * zoom, dh = ih * baseScale * zoom;
  let x = (width - dw) * px, y = (height - dh) * py;
  if (scene.motion === 'subtle-drift') {
    // Bound travel in viewport pixels: a very wide/tall source must not turn a
    // gentle preset into a large pan merely because it has more crop to spare.
    const travelX = Math.min(Math.abs(width - dw) * .25, width * .00625);
    const travelY = Math.min(Math.abs(height - dh) * .05, height * .00125);
    x = clamp(x + lerp(travelX, -travelX, p), Math.min(0, width - dw), Math.max(0, width - dw));
    y = clamp(y + lerp(travelY, -travelY, p), Math.min(0, height - dh), Math.max(0, height - dh));
  }
  ctx.save();ctx.beginPath();ctx.rect(0, 0, width, height);ctx.clip();
  ctx.fillStyle = '#080b0d';ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, x, y, dw, dh);
  drawSceneEffect(ctx, scene, localTime, width, height);
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

function aiImageNoticeLayout(ctx, width, height) {
  const scale = Math.min(width, height) / 1080, fontSize = (width < height ? 30 : 22) * scale;
  const paddingX = 14 * scale, paddingY = 6 * scale, lineHeight = fontSize * 1.45;
  ctx.save();ctx.font = `500 ${fontSize}px ${FONT}`;
  const lines = wrapText(ctx, AI_IMAGE_NOTICE_TEXT, width * 0.92 - paddingX * 2);
  const panelWidth = Math.min(width * 0.94, Math.max(...lines.map(line => ctx.measureText(line).width), 0) + paddingX * 2);
  ctx.restore();
  const panelHeight = lines.length * lineHeight + paddingY * 2;
  return {scale, fontSize, paddingY, lineHeight, lines, panelWidth, panelHeight,
    x: (width - panelWidth) / 2, top: height - Math.min(width, height) * 0.02 - panelHeight};
}

function drawAiImageNotice(ctx, layout, width) {
  const {scale, fontSize, paddingY, lineHeight, lines, panelWidth, panelHeight, x, top} = layout;
  ctx.save();ctx.globalAlpha = 1;ctx.globalCompositeOperation = 'source-over';
  ctx.shadowColor = 'rgba(0,0,0,0)';ctx.shadowBlur = 0;ctx.shadowOffsetY = 0;
  ctx.fillStyle = 'rgba(0,0,0,0.68)';roundedRect(ctx, x, top, panelWidth, panelHeight, 5 * scale);ctx.fill();
  ctx.font = `500 ${fontSize}px ${FONT}`;ctx.fillStyle = '#ffffff';ctx.textAlign = 'center';ctx.textBaseline = 'middle';
  lines.forEach((line, index) => ctx.fillText(line, width / 2, top + paddingY + (index + 0.5) * lineHeight));
  ctx.restore();
}

function drawCaption(ctx, text, settings, width, height, maximumBottom) {
  if (!text?.trim()) return;
  const scale = Math.min(width, height) / 1080;
  const maxWidth = width * (width < height ? 0.82 : 0.84);
  let fontSize = clamp(Number(settings.fontSize) || 48, 20, 100) * scale;
  const minimum = 18 * scale;
  const font = CAPTION_FONTS[settings.captionFont] || FONT;
  ctx.textAlign = 'center';ctx.textBaseline = 'middle';
  let lines;
  do {
    ctx.font = `600 ${fontSize}px ${font}`;
    lines = wrapText(ctx, text, maxWidth);
    if (lines.length <= 2 || fontSize <= minimum) break;
    fontSize = Math.max(minimum, fontSize - 2 * scale);
  } while (true);
  const lineHeight = fontSize * 1.45;
  const paddingX = 28 * scale, paddingY = 15 * scale;
  const panelWidth = Math.min(width * 0.94, Math.max(...lines.map(line => ctx.measureText(line).width), 0) + paddingX * 2);
  const panelHeight = lines.length * lineHeight + paddingY * 2;
  const bottom = height * (width < height ? 0.14 : 0.07);
  let top = Math.max(height * 0.12, height - bottom - panelHeight);
  if (settings.captionPosition === 'top') top = height * 0.12;
  if (settings.captionPosition === 'center') top = (height - panelHeight) / 2;
  top = clamp(top, height * 0.04, Math.max(height * 0.04, (maximumBottom ?? height * 0.96) - panelHeight));
  // Very long imported cues may exceed the available frame even at the minimum
  // font size. Keep that text/panel above the notice instead of painting over it.
  if (maximumBottom !== undefined) {ctx.save();ctx.beginPath();ctx.rect(0, 0, width, maximumBottom);ctx.clip();}
  ctx.save();
  ctx.fillStyle = settings.captionBackground || '#070a0d';
  ctx.globalAlpha = clamp(settings.captionOpacity ?? 0.83);
  roundedRect(ctx, (width - panelWidth) / 2, top, panelWidth, panelHeight, 10 * scale);ctx.fill();
  ctx.restore();
  ctx.fillStyle = settings.captionColor || '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.65)';ctx.shadowBlur = 4 * scale;ctx.shadowOffsetY = scale;
  ctx.strokeStyle = settings.captionStroke || '#000000';
  ctx.lineWidth = clamp(settings.captionStrokeWidth ?? 0, 0, 8) * scale;
  ctx.lineJoin = 'round';
  lines.forEach((line, i) => {
    const y = top + paddingY + (i + 0.5) * lineHeight;
    if (ctx.lineWidth > 0 && settings.captionStrokeWidth > 0) ctx.strokeText(line, width / 2, y);
    ctx.fillText(line, width / 2, y);
  });
  ctx.shadowBlur = 0;ctx.shadowOffsetY = 0;
  if (maximumBottom !== undefined) ctx.restore();
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
    drawScene(ctx, current.scene, assets, current.progress, width, height, current.index, current.localTime);
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
      drawScene(surface.ctx, next, assets, 0, width, height, current.index + 1, 0);
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
  const notice = settings.aiImageNotice === true ? aiImageNoticeLayout(ctx, width, height) : null;
  if (settings.subtitles !== false) {
    const cue = state.captions.find(caption => t >= caption.start && t < caption.end);
    if (cue) drawCaption(ctx, cue.text, settings, width, height, notice ? notice.top - 10 * scale : undefined);
  }
  if (notice) drawAiImageNotice(ctx, notice, width);
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

/** Source bounds in seconds; trims are nondestructive and BGM loops only this window. */
export function getAudioWindow(project, assets, kind) {
  const asset = assets.get(project.audio?.[`${kind}Id`]);
  if (!asset) return {start: 0, end: 0, duration: 0};
  const length = Number(asset.audioBuffer?.duration ?? asset.duration) || 0;
  const start = project.audio?.[`${kind}Start`] ?? 0;
  const requestedEnd = project.audio?.[`${kind}End`];
  const end = requestedEnd == null ? length : requestedEnd;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > length + 0.01 || start >= end) {
    throw new Error(`${kind === 'narration' ? '내레이션' : '배경음악'} 자르기 범위를 파일 길이 안에서 지정해 주세요.`);
  }
  return {start, end: Math.min(length, end), duration: Math.min(length, end) - start};
}

// RMS is computed once per decoded file, in 50 ms windows. A short look-behind
// keeps the BGM down through syllable gaps without treating silence as speech.
function voiceEnvelope(buffer) {
  let cached = audioEnvelopes.get(buffer);
  if (cached) return cached;
  const step = Math.max(1, Math.round(buffer.sampleRate * 0.05));
  const channels = Array.from({length: Math.min(2, buffer.numberOfChannels)}, (_, i) => buffer.getChannelData(i));
  const values = new Float32Array(Math.ceil(buffer.length / step));
  for (let bin = 0; bin < values.length; bin++) {
    const from = bin * step, to = Math.min(buffer.length, from + step);
    let squares = 0;
    for (const channel of channels) for (let index = from; index < to; index++) squares += channel[index] * channel[index];
    values[bin] = Math.sqrt(squares / Math.max(1, (to - from) * channels.length));
  }
  cached = {values, stepSeconds: step / buffer.sampleRate};
  audioEnvelopes.set(buffer, cached);
  return cached;
}

/** The same gain envelope drives preview and exported audio (not a UI estimate). */
export function getAudioGain(project, assets, kind, time) {
  const settings = project.settings || {};
  const total = getDuration(project);
  if (time < 0 || time >= total) return 0;
  const window = getAudioWindow(project, assets, kind);
  if (!window.duration) return 0;
  const narrationOffset = project.audio?.narrationOffset ?? 0;
  if (kind === 'narration') return time >= narrationOffset && time < narrationOffset + window.duration ? clamp(settings.narrationVolume ?? 1, 0, 2) : 0;
  let gain = clamp(settings.bgmVolume ?? 0.12, 0, 1);
  const fadeIn = clamp(settings.bgmFadeIn ?? 0, 0, 10);
  const fadeOut = clamp(settings.bgmFadeOut ?? 0, 0, 10);
  if (fadeIn) gain *= clamp(time / fadeIn);
  if (fadeOut) gain *= clamp((total - time) / fadeOut);
  if (settings.ducking) {
    const voice = assets.get(project.audio?.narrationId)?.audioBuffer;
    const voiceWindow = getAudioWindow(project, assets, 'narration');
    if (voice && time >= narrationOffset && time < narrationOffset + voiceWindow.duration && (settings.narrationVolume ?? 1) > 0) {
      const envelope = voiceEnvelope(voice);
      const sourceTime = voiceWindow.start + time - narrationOffset;
      let rms = 0;
      const first = Math.max(0, Math.floor(Math.max(voiceWindow.start, sourceTime - 0.2) / envelope.stepSeconds));
      const last = Math.min(envelope.values.length - 1, Math.floor(Math.min(voiceWindow.end, sourceTime + 0.05) / envelope.stepSeconds));
      for (let i = first; i <= last; i++) rms = Math.max(rms, envelope.values[i]);
      gain *= 1 - 0.75 * clamp((rms - 0.006) / 0.012);
    }
  }
  return gain;
}

// Build potentially expensive RMS/gain curves before selecting a live clock
// start. Long files must not consume the beginning of preview/export while a
// source scheduled in the past is still being prepared.
function prepareAudioPlan(project, assets, kind, offset = 0) {
  const asset = assets.get(project.audio?.[`${kind}Id`]);
  if (!asset?.audioBuffer) return null;
  const window = getAudioWindow(project, assets, kind);
  const remaining = Math.max(0, getDuration(project) - offset);
  const loop = kind === 'bgm';
  const narrationOffset = project.audio?.narrationOffset ?? 0;
  const elapsed = Math.max(0, offset - narrationOffset);
  const delay = loop ? 0 : Math.max(0, narrationOffset - offset);
  if (remaining <= delay || !window.duration || (!loop && elapsed >= window.duration)) return null;
  const duration = loop ? remaining : Math.min(remaining - delay, window.duration - elapsed);
  const sourceOffset = window.start + (loop ? offset % window.duration : elapsed);
  let values = null;
  if (loop && duration > 0.001) {
    values = new Float32Array(Math.max(2, Math.ceil(duration / 0.05) + 1));
    for (let i = 0; i < values.length; i++) {
      values[i] = getAudioGain(project, assets, kind, offset + Math.min(duration - 0.000001, duration * i / (values.length - 1)));
    }
  }
  return {asset, window, loop, delay, duration, sourceOffset, values, initialGain: getAudioGain(project, assets, kind, offset + delay)};
}

function connectAudio(context, destination, plan, startAt) {
  if (!plan) return null;
  const {asset, window, loop, delay, duration, sourceOffset, values, initialGain} = plan;
  const sourceStart = startAt + delay;
  const source = context.createBufferSource();source.buffer = asset.audioBuffer;source.loop = loop;
  if (loop) {source.loopStart = window.start;source.loopEnd = window.end;}
  const gain = context.createGain();
  source.connect(gain);gain.connect(destination);
  gain.gain.setValueAtTime(initialGain, sourceStart);
  if (values) gain.gain.setValueCurveAtTime(values, sourceStart, duration);
  source.start(sourceStart, sourceOffset);
  source.stop(sourceStart + duration);
  return {source, gain};
}

/** Start a fresh audio session at an arbitrary video timestamp, including trims. */
export async function createPreviewAudio(project, assets, offset = 0) {
  const audioAssets = new Map([...assets].filter(([id]) => id === project.audio?.narrationId || id === project.audio?.bgmId));
  if (!audioAssets.size) return {stop() {}};
  await prepareAssets(audioAssets);
  const plans = ['narration', 'bgm'].map(kind => prepareAudioPlan(project, assets, kind, offset));
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioCtx) throw new Error('이 브라우저에서는 음성을 재생할 수 없습니다. 최신 Chrome 또는 Edge를 사용해 주세요.');
  const context = new AudioCtx();
  const nodes = [];
  let timer = 0, stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;clearTimeout(timer);
    for (const {source, gain} of nodes) {try {source.stop();} catch {}source.disconnect();gain.disconnect();}
    if (context.state !== 'closed') context.close().catch(() => {});
  };
  try {
    await context.resume();
    if (context.state !== 'running') throw new Error('음성을 재생하지 못했어요. 재생 버튼을 다시 눌러주세요.');
    const startAt = context.currentTime + 0.01;
    for (const plan of plans) {
      const node = connectAudio(context, context.destination, plan, startAt);
      if (node) nodes.push(node);
    }
    timer = setTimeout(stop, Math.max(0, getDuration(project) - offset) * 1000 + 100);
    return {stop, getTime: () => Math.max(offset, offset + context.currentTime - startAt)};
  } catch (error) {stop();throw error;}
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
  const audioPlans = ['narration', 'bgm'].map(kind => prepareAudioPlan(frozenProject, assets, kind));
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
    for (const plan of audioPlans) {
      const node = audioContext && connectAudio(audioContext, destination, plan, clockStart);
      if (node) audioNodes.push(node);
    }
    const now = () => (audioContext ? audioContext.currentTime : performance.now() / 1000) - clockStart;
    let lastProgress = -Infinity, lastFrameIndex = -1, finishing = false;
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
      if (stopped || finishing) return;
      const elapsed = clamp(now(), 0, duration);
      if (elapsed >= duration) {finish();return;}
      const frameIndex = Math.floor(elapsed * fps);
      // Timers can fire just before their requested audio-clock boundary. Only
      // capture once per logical frame, rather than again on each early wake.
      if (frameIndex > lastFrameIndex) {
        renderFrame(ctx, frozenProject, assets, elapsed, width, height);
        videoTrack.requestFrame?.();
        lastFrameIndex = frameIndex;
        if (elapsed - lastProgress > 0.1) {
          onProgress({phase: 'render', progress: elapsed / duration,
            message: `영상을 만들고 있어요 · ${Math.floor(elapsed)} / ${Math.ceil(duration)}초`});lastProgress = elapsed;
        }
      }
      // Export uses an audio-clock-aligned timer rather than requestAnimationFrame.
      // RAF may be throttled for an off-screen canvas despite an active document.
      const nextFrame = (lastFrameIndex + 1) / fps;
      frameTimer = setTimeout(draw, Math.max(1, (nextFrame - now()) * 1000));
    };
    onProgress({phase: 'render', progress: 0, message: '영상을 만들고 있어요. 이 탭을 열어 두세요.'});
    draw();
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
