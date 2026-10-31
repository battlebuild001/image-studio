/** Pure changed-region comparison and measured PCM/timeline patching. */
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const bounded = (text, max = 100000) => typeof text === 'string' && Array.from(text).length <= max;
const clean = value => String(value || '').replace(/\u0000/g, '');
const reject = message => {throw new Error(message);};
const epsilon = 1e-5;

export function changeTextKey(value) {
  const text = clean(value).normalize('NFC');let first = 2166136261, second = 5381;
  for (const character of text) {const code = character.codePointAt(0);first = Math.imul(first ^ code, 16777619);second = Math.imul(second, 33) ^ code;}
  return `${text.length}:${first >>> 0}:${second >>> 0}`;
}

export function changeTimeline(project) {
  let cursor = 0;
  return (project?.scenes || []).map((scene, index) => {
    if (!Number.isFinite(scene.duration) || scene.duration < .25 || scene.duration > 600) reject('장면 길이는 0.25~600초여야 해요.');
    const start = cursor;cursor += scene.duration;return {...scene, index, start, end: cursor};
  });
}

const narration = project => project?.scriptDraft?.draftScript ?? project?.scriptDraft?.result?.script ?? (project?.scenes || []).map(scene => scene.caption || '').join('\n\n');
const display = project => project?.scriptDraft?.displayScript ?? project?.scriptDraft?.result?.displayScript ?? (project?.scenes || []).map(scene => scene.caption || '').join('\n\n');
function compactSource(value) {
  const raw = Array.from(clean(value).normalize('NFC')), positions = [], characters = [];
  raw.forEach((character, index) => {if (!/\s/u.test(character)) {characters.push(character);positions.push(index);}});
  return {raw, positions, characters, text: characters.join('')};
}
function sourceChange(before, after) {
  let from = 0, beforeEnd = before.length, afterEnd = after.length;
  while (from < beforeEnd && from < afterEnd && before[from] === after[from]) from++;
  while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) {beforeEnd--;afterEnd--;}
  return {from, beforeEnd, afterEnd};
}

/** Suggestions only: image/voice requests still require a user's explicit review. */
export function changedSceneDisplayText(project, baseline, sceneId) {
  const scene = project.scenes.find(value => value.id === sceneId), old = baseline?.scenes?.find(value => value.sceneId === sceneId);
  if (!scene || !old || !bounded(baseline.displayText) || !Number.isInteger(old.displayStart) || !Number.isInteger(old.displayEnd)) return scene?.caption || '';
  const before = compactSource(baseline.displayText), after = compactSource(display(project));
  if (before.text === after.text) return scene.caption || '';
  const edit = sourceChange(before.characters, after.characters), delta = after.characters.length - before.characters.length;
  const map = (point, ending) => {
    if (point <= edit.from) return point === before.characters.length && ending ? edit.afterEnd : point;
    if (point >= edit.beforeEnd) return point + delta;
    if (edit.beforeEnd === edit.from) return ending ? edit.afterEnd : edit.from;
    return Math.round(edit.from + (point - edit.from) / (edit.beforeEnd - edit.from) * (edit.afterEnd - edit.from));
  };
  const from = Math.max(0, Math.min(after.characters.length, map(old.displayStart, false))), to = Math.max(from, Math.min(after.characters.length, map(old.displayEnd, true)));
  const rawStart = after.positions[from] ?? after.raw.length, rawEnd = to >= after.positions.length ? after.raw.length : after.positions[to];
  return after.raw.slice(rawStart, rawEnd).join('').trim();
}
const baselineRow = scene => ({sceneId: scene.id, caption: Array.from(clean(scene.caption)).slice(0, 2000).join(''), voiceCaption: Array.from(clean(scene.caption)).slice(0, 2000).join(''), captionKey: changeTextKey(scene.caption), imageCaptionKey: changeTextKey(scene.caption), voiceCaptionKey: changeTextKey(scene.caption),
  imageId: scene.imageId || null, start: scene.start, end: scene.end});

export function captureChangeBaseline(project, now = new Date()) {
  if (!project?.id || !Array.isArray(project.scenes) || project.scenes.length > 200) reject('비교할 프로젝트와 장면을 확인해 주세요.');
  const stamp = new Date(now);if (!Number.isFinite(stamp.getTime())) reject('기준 저장 시각을 확인해 주세요.');
  const displayText = display(project);if (!bounded(displayText)) reject('비교 기준 대본은 100,000자 이하로 줄여 주세요.');
  const compact = compactSource(displayText);let cursor = 0;
  const scenes = changeTimeline(project).map(scene => {
    const row = baselineRow(scene), text = compactSource(scene.caption).text, found = text ? compact.text.indexOf(text, cursor) : -1;
    if (found >= 0) {row.displayStart = Array.from(compact.text.slice(0, found)).length;row.displayEnd = row.displayStart + Array.from(text).length;cursor = found + text.length;}
    return row;
  });
  return {version: 1, capturedAt: stamp.toISOString(), projectId: project.id, narrationId: project.audio?.narrationId || null,
    narrationKey: changeTextKey(narration(project)), displayKey: changeTextKey(displayText), displayText, scenes};
}

export function diffProductionChanges(project, baseline = project?.production?.changes?.baseline) {
  const scenes = changeTimeline(project);
  if (!plain(baseline) || baseline.version !== 1 || baseline.projectId !== project.id || !Array.isArray(baseline.scenes)) {
    return {hasBaseline: false, changes: [], removed: [], narrationChanged: false, displayChanged: false};
  }
  const previous = new Map(baseline.scenes.map(scene => [scene.sceneId, scene])), current = new Set(scenes.map(scene => scene.id));
  return {hasBaseline: true,
    changes: scenes.flatMap(scene => {
      const old = previous.get(scene.id), fields = [], sourceCaption = changedSceneDisplayText(project, baseline, scene.id), targetKey = changeTextKey(sourceCaption || scene.caption);
      const needsImage = !old || targetKey !== (old.imageCaptionKey || old.captionKey), needsVoice = !old || targetKey !== (old.voiceCaptionKey || old.captionKey);
      if (!old) fields.push('added');
      else {
        if (old.captionKey !== changeTextKey(scene.caption)) fields.push('caption');
        if (sourceCaption && changeTextKey(sourceCaption) !== changeTextKey(scene.caption)) fields.push('source');
        if (needsImage) fields.push('image-stale');if (needsVoice) fields.push('voice-stale');
        if (Math.abs(old.start - scene.start) > epsilon || Math.abs(old.end - scene.end) > epsilon) fields.push('timing');
        if (old.imageId !== (scene.imageId || null)) fields.push(old.imageId ? 'image' : 'image-added');
      }
      return fields.length ? [{sceneId: scene.id, index: scene.index, start: scene.start, end: scene.end, fields,
        previousCaption: old?.caption || '', currentCaption: scene.caption || '', sourceCaption, needsImage, needsVoice}] : [];
    }), removed: baseline.scenes.filter(scene => !current.has(scene.sceneId)).map(scene => ({sceneId: scene.sceneId, previousCaption: scene.caption})),
    narrationChanged: baseline.narrationKey !== changeTextKey(narration(project)), displayChanged: baseline.displayKey !== changeTextKey(display(project))};
}

/** An applied image clears that row only; unrelated edited rows stay dirty. */
export function markChangeBaselineApplied(project, sceneIds, {voice = false, now = new Date()} = {}) {
  const baseline = project?.production?.changes?.baseline;
  if (!baseline || baseline.projectId !== project.id) return null;
  const selected = new Set(sceneIds), next = clone(baseline), rows = changeTimeline(project), byId = new Map(rows.map(scene => [scene.id, scene]));
  next.scenes = next.scenes.flatMap(scene => {
    if (!byId.has(scene.sceneId)) return [];
    if (!selected.has(scene.sceneId)) return [scene];
    const current = baselineRow(byId.get(scene.sceneId)), targetKey = changeTextKey(changedSceneDisplayText(project, baseline, scene.sceneId));
    return [{...scene, ...current, imageCaptionKey: voice ? scene.imageCaptionKey || scene.captionKey : targetKey, voiceCaption: voice ? current.voiceCaption : scene.voiceCaption ?? scene.caption, voiceCaptionKey: voice ? targetKey : scene.voiceCaptionKey || scene.captionKey}];
  });
  const known = new Set(next.scenes.map(scene => scene.sceneId));
  for (const scene of rows) if (selected.has(scene.id) && !known.has(scene.id)) next.scenes.push(baselineRow(scene));
  next.scenes.sort((a, b) => a.start - b.start);
  if (voice) {
    next.narrationId = project.audio?.narrationId || null;
    // All slot times move after a measured voice replacement; content keys of
    // unselected rows are deliberately retained for their independent edits.
    next.scenes = next.scenes.map(scene => ({...scene, start: byId.get(scene.sceneId).start, end: byId.get(scene.sceneId).end}));
  }
  return {baseline: next, updatedAt: new Date(now).toISOString()};
}

export function narrationSourceWindow(project, sourceDuration) {
  const start = Number(project.audio?.narrationStart || 0), end = project.audio?.narrationEnd == null ? sourceDuration : Number(project.audio.narrationEnd), offset = Number(project.audio?.narrationOffset || 0);
  if (![sourceDuration, start, end, offset].every(Number.isFinite) || sourceDuration <= 0 || start < 0 || end <= start || end > sourceDuration + .01 || offset < 0) reject('현재 내레이션의 길이·자르기·시작 시간을 확인해 주세요.');
  return {sourceStart: start, sourceEnd: Math.min(sourceDuration, end), timelineStart: offset, timelineEnd: offset + Math.min(sourceDuration, end) - start};
}

export function patchSourceRange(project, start, end, sourceDuration) {
  const window = narrationSourceWindow(project, sourceDuration);
  if (![start, end].every(Number.isFinite) || start < window.timelineStart - epsilon || end > window.timelineEnd + epsilon || end <= start) reject('교체 시작·끝 시간을 실제 내레이션의 재생 범위 안으로 정해 주세요.');
  return {start: window.sourceStart + Math.max(0, start - window.timelineStart), end: window.sourceStart + Math.min(window.timelineEnd - window.timelineStart, end - window.timelineStart), window};
}

/** Outside source samples are copied unchanged; no synthetic silence/duration. */
export function splicePcmSamples(source, replacement, {start, end, sampleRate = 24000} = {}) {
  if (!(source instanceof Float32Array) || !(replacement instanceof Float32Array) || !source.length || !replacement.length || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) reject('실제 PCM 음성 데이터를 확인해 주세요.');
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > source.length / sampleRate + 1 / sampleRate) reject('교체할 PCM 구간을 음성 길이 안으로 정해 주세요.');
  const from = Math.round(start * sampleRate), to = Math.min(source.length, Math.round(end * sampleRate));
  if (to <= from || from >= source.length) reject('음성 교체 구간이 너무 짧아요.');
  const frames = source.length - (to - from) + replacement.length;
  if (frames / sampleRate > 3600 || 44 + frames * 2 > 180 * 1024 * 1024) reject('교체 후 음성은 60분·180MiB 이하로 줄여 주세요.');
  const samples = new Float32Array(frames);samples.set(source.subarray(0, from));samples.set(replacement, from);samples.set(source.subarray(to), from + replacement.length);
  for (const value of samples) if (!Number.isFinite(value)) reject('음성에 손상된 PCM 샘플이 있어요.');
  return {samples, startFrame: from, endFrame: to, removedSeconds: (to - from) / sampleRate, replacementSeconds: replacement.length / sampleRate,
    delta: (replacement.length - (to - from)) / sampleRate};
}

export function encodePatchedPcmWav(samples, sampleRate = 24000) {
  if (!(samples instanceof Float32Array) || !samples.length || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || samples.length > sampleRate * 3600 || 44 + samples.length * 2 > 180 * 1024 * 1024) reject('저장할 PCM 음성의 길이·형식을 확인해 주세요.');
  const data = new ArrayBuffer(44 + samples.length * 2), view = new DataView(data), ascii = (at, text) => {for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));};
  ascii(0, 'RIFF');view.setUint32(4, data.byteLength - 8, true);ascii(8, 'WAVE');ascii(12, 'fmt ');view.setUint32(16, 16, true);view.setUint16(20, 1, true);view.setUint16(22, 1, true);view.setUint32(24, sampleRate, true);view.setUint32(28, sampleRate * 2, true);view.setUint16(32, 2, true);view.setUint16(34, 16, true);ascii(36, 'data');view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {const value = samples[i];if (!Number.isFinite(value)) reject('음성에 손상된 PCM 샘플이 있어요.');const sample = Math.max(-1, Math.min(1, value));view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);}
  return new Blob([data], {type: 'audio/wav'});
}

export function patchTime(value, start, end, replacementDuration) {
  if (value <= start) return value;
  if (value >= end) return value + replacementDuration - (end - start);
  return start + (value - start) * replacementDuration / (end - start);
}

function replaceUniqueSnippet(text, before, after) {
  const full = compactSource(text), old = compactSource(before), updated = compactSource(after);
  if (!old.characters.length || !updated.characters.length) return {status: 'manual-required', text};
  const first = full.text.indexOf(old.text);
  if (first < 0) {
    const current = full.text.indexOf(updated.text);
    return {status: current >= 0 && full.text.indexOf(updated.text, current + 1) < 0 ? 'already-current' : 'manual-required', text};
  }
  if (full.text.indexOf(old.text, first + 1) >= 0) return {status: 'manual-required', text};
  const from = Array.from(full.text.slice(0, first)).length, to = from + old.characters.length;
  const start = full.positions[from], end = full.positions[to - 1] + 1;
  const value = full.raw.slice(0, start).join('') + after.trim() + full.raw.slice(end).join('');
  if (!bounded(value)) return {status: 'manual-required', text};
  return {status: full.text === compactSource(value).text ? 'already-current' : 'updated', text: value};
}

/** Never infers a transcript from audio timestamps. Only unique known text spans
 * may update the full drafts; an ambiguous span keeps originals and a dirty flag.
 */
export function synchronizePatchDraftText(project, {patchedProject, sceneId, start, end, displayText, narrationText, spokenCandidates = []} = {}) {
  const next = clone(patchedProject || project), scene = changeTimeline(project).find(value => value.id === sceneId), reasons = [];
  let displayStatus = 'manual-required', narrationStatus = 'manual-required';
  const wholeScene = scene && Math.abs(scene.start - start) < .001 && Math.abs(scene.end - end) < .001;
  if (wholeScene) {
    const target = next.scenes.find(value => value.id === sceneId);if (target && bounded(displayText, 20000) && displayText.trim()) target.caption = displayText.trim();
    const beforeDisplay = changedSceneDisplayText(project, project.production?.changes?.baseline, sceneId);
    if (project.scriptDraft) {
      const oldRow = project.production?.changes?.baseline?.scenes?.find(value => value.sceneId === sceneId), originalCaption = oldRow && String(oldRow.caption.length) === oldRow.captionKey?.split(':')[0] ? oldRow.caption : '';
      for (const candidate of [...new Set([beforeDisplay, scene.caption, originalCaption].filter(Boolean))]) {
        const screen = replaceUniqueSnippet(display(project), candidate, displayText);
        if (screen.status !== 'manual-required') {displayStatus = screen.status;next.scriptDraft.displayScript = screen.text;break;}
      }
      if (bounded(project.scriptDraft.draftScript) && project.scriptDraft.draftScript.trim()) {
        const candidates = [...new Set(spokenCandidates.filter(value => bounded(value, 20000) && value.trim()))];
        for (const candidate of candidates) {
          const spoken = replaceUniqueSnippet(project.scriptDraft.draftScript, candidate, narrationText);
          if (spoken.status !== 'manual-required') {narrationStatus = spoken.status;next.scriptDraft.draftScript = spoken.text;break;}
        }
      }
    } else {displayStatus = 'updated';}
  } else {reasons.push('교체 구간이 장면 전체와 달라 전체 대본의 문자 범위를 자동 확정하지 않았어요.');}
  if (displayStatus === 'manual-required') reasons.push('전체 화면용 대본에서 교체 문장의 유일한 위치를 확인하지 못했어요.');
  if (narrationStatus === 'manual-required') reasons.push('전체 음성용 대본에서 원래 읽던 문장을 확인하지 못했어요. 전체 대본을 직접 확인해 주세요.');
  if (next.scenePlan) {
    const sceneMap = new Map(next.scenes.map(scene => [scene.id, scene]));
    next.scenePlan.items = next.scenePlan.items.map(item => {
      const scene = sceneMap.get(item.sceneId);if (!scene || scene.caption === item.caption) return item;
      return {...item, caption: scene.caption || '', prompt: `새로 수정된 장면: ${Array.from(scene.caption || '').slice(0, 5500).join('')}`};
    });
    if (compactSource(next.scenes.map(scene => scene.caption || '').join('\n\n')).text === compactSource(display(next)).text) next.scenePlan.sourceScript = display(next);
  }
  return {project: next, sync: {needsManualSync: reasons.length > 0, displayStatus, narrationStatus, reasons}};
}

/** Actual replacement duration warps affected slots, shifts later slots/cues. */
export function retimeProjectForNarrationPatch(project, {start, end, replacementDuration, displayText = '', timelineCaptions = null, now = new Date()} = {}) {
  if (![start, end, replacementDuration].every(Number.isFinite) || start < 0 || end <= start || replacementDuration <= 0) reject('측정한 교체 음성 길이와 구간을 확인해 주세요.');
  const next = clone(project), rows = changeTimeline(project), total = rows.at(-1)?.end || 0, delta = replacementDuration - (end - start);
  if (!rows.length || end > total + epsilon || total + delta > 3600 || total + delta < .25) reject('교체 구간과 전체 영상 길이를 60분 안으로 정해 주세요.');
  next.scenes = rows.map(({index, start: sceneStart, end: sceneEnd, ...scene}) => {
    const duration = patchTime(sceneEnd, start, end, replacementDuration) - patchTime(sceneStart, start, end, replacementDuration);
    if (duration < .25 - epsilon || duration > 600 + epsilon) reject('교체 후 장면 길이가 0.25~600초를 벗어나요. 교체 구간을 넓히거나 짧은 음성을 만들어 주세요.');
    return {...scene, duration: Math.round(duration * 1e9) / 1e9};
  });
  if (Array.isArray(timelineCaptions) && project.captionMode !== 'auto') {
    const crosses = timelineCaptions.some(cue => (cue.start < start - epsilon && cue.end > start + epsilon) || (cue.start < end - epsilon && cue.end > end + epsilon));
    if (crosses) reject('교체 구간이 기존 수동·음성 자막을 중간에서 나눠요. 자막의 시작·끝 경계에 맞춰 주세요.');
    if (!bounded(displayText, 20000) || !displayText.trim()) reject('교체 구간에 표시할 자막을 입력해 주세요.');
    next.captions = timelineCaptions.filter(cue => cue.end <= start + epsilon || cue.start >= end - epsilon).map(cue => cue.start >= end - epsilon ? {...cue, start: cue.start + delta, end: cue.end + delta} : {...cue});
    next.captions.push({start, end: start + replacementDuration, text: displayText.trim()});next.captions.sort((a, b) => a.start - b.start);next.captionMode = 'srt';next.captionAnalysis = null;
  } else if (project.captionMode === 'speech') {reject('기존 음성 자막의 실제 시간 정보를 불러오지 못했어요. 자막을 확인한 뒤 다시 실행해 주세요.');}
  if (next.audio?.narrationEnd != null) next.audio.narrationEnd += delta;
  if (next.scenePlan) {
    const items = new Map(next.scenePlan.items.map(item => [item.sceneId, item]));
    next.scenePlan.items = changeTimeline(next).map(scene => ({...items.get(scene.id), sceneId: scene.id, start: scene.start, end: scene.end, caption: scene.caption || '', prompt: items.get(scene.id)?.prompt || scene.caption || ''}));
    next.scenePlan.durationSeconds = total + delta;next.scenePlan.confirmedAt = new Date(now).toISOString();delete next.scenePlan.visualPlan;
  }
  return {project: next, delta, totalSeconds: total + delta, affectedSceneIds: rows.filter(scene => scene.end > start + epsilon && scene.start < end - epsilon).map(scene => scene.id)};
}
