import {createScene, distributeDurations, splitScript} from './project.js';

/** Preserve every paragraph while fitting the editor's 200-scene limit. */
export function planScriptScenes(text, previousScenes = [], {keepImages = true, targetSeconds = null, narrationSeconds = 0} = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('장면으로 나눌 대본을 입력해 주세요.');
  if (Array.from(text).length > 100000) throw new Error('대본은 10만 자 이하로 넣어주세요.');
  if (targetSeconds !== null && (!Number.isInteger(targetSeconds / 60) || targetSeconds < 60 || targetSeconds > 3600)) {
    throw new Error('목표 분량은 1~60분 사이의 정수로 지정해 주세요.');
  }
  let paragraphs = splitScript(text.trim());
  if (paragraphs.length > 200) {
    const groupSize = Math.ceil(paragraphs.length / 200);
    const grouped = [];
    for (let index = 0; index < paragraphs.length; index += groupSize) grouped.push(paragraphs.slice(index, index + groupSize).join(' '));
    paragraphs = grouped;
  }
  const images = keepImages ? previousScenes.filter(scene => scene.imageId) : [];
  const scenes = paragraphs.map((caption, index) => {
    const {id, ...appearance} = images[index] || {};
    return createScene({motion: ['zoom-in', 'pan-left', 'zoom-out', 'pan-right'][index % 4], ...appearance, caption});
  });
  for (const previous of images.slice(scenes.length)) {
    const {id, ...appearance} = previous;
    scenes.push(createScene({...appearance, caption: ''}));
  }
  const estimated = Math.max(scenes.length * 4, Array.from(text.replace(/\s/g, '')).length / 5.5);
  const duration = targetSeconds ?? (narrationSeconds > 0 ? narrationSeconds : Math.min(3600, estimated));
  return distributeDurations(scenes, duration);
}

export function scriptLength(text, charsPerMinute = 330) {
  const characters = Array.from(String(text).replace(/\s/g, '')).length;
  return {characters, estimatedMinutes: characters / charsPerMinute};
}
