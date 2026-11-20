import {createProject, validateProject} from './project.js';
import {planTimedScenes, narrationPlanKey} from './script-planning.js';
import {normalizeBudgetSettings} from './production-budget.js';
import {stripEnglishParentheticalGlosses} from './script-protocol.js';

/** Create a separate script project before the queue synthesizes narration using the reviewed time/cadence.
 * This is local planning only. No existing scene/narration/result is reused and
 * no API request is dispatched until the queue's separate acknowledged run.
 */
export function buildBulkScriptProject({baseProject, script, title = '대량 제작 영상', durationSeconds, intervalSeconds = 10} = {}) {
  if (typeof script !== 'string' || !script.replace(/\u0000/gu, '').trim() || Array.from(script).length > 100000) {
    throw new Error('영상 대본을 1~100,000자로 입력해 주세요.');
  }
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('영상 제목을 1~200자로 입력해 주세요.');
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600) throw new Error('영상 길이는 1초~60분 사이로 지정해 주세요.');
  const base = validateProject(baseProject ?? createProject()), text = stripEnglishParentheticalGlosses(script.replace(/\u0000/gu, ''));
  const timing = planTimedScenes(text, [], {totalSeconds: durationSeconds, intervalSeconds, targetBasis: 'target', keepImages: false});
  const project = createProject({title, aspect: base.aspect, settings: structuredClone(base.settings),
    imageStudio: structuredClone(base.imageStudio), scenes: timing.scenes,
    audio: {bgmId: base.audio.bgmId, bgmStart: base.audio.bgmStart, bgmEnd: base.audio.bgmEnd},
    scriptDraft: {sourceText: '', instructions: '', targetMinutes: Math.max(1, Math.ceil(durationSeconds / 60)),
      charsPerMinute: 330, narrationStyle: 'standard', sourceFidelity: 'balanced', detailLevel: 'standard',
      draftScript: text, displayScript: text, result: null},
  });
  project.scenePlan = {version: 1, intervalSeconds: timing.intervalSeconds, durationSeconds: timing.durationSeconds,
    basis: timing.basis, confirmedAt: new Date().toISOString(), sourceScript: text,
    narrationKey: narrationPlanKey(project), items: timing.items,
    ...(base.scenePlan?.visualBrief === undefined ? {} : {visualBrief: base.scenePlan.visualBrief}),
    ...(base.scenePlan?.imageInstructions === undefined ? {} : {imageInstructions: base.scenePlan.imageInstructions})};
  const production = {version: 1};
  if (base.production?.budget) production.budget = {...normalizeBudgetSettings(base.production.budget), spentUsd: 0, ledger: []};
  if (base.production?.description) production.description = structuredClone(base.production.description);
  if (base.production?.speech) {
    const speech = {};
    for (const key of ['pronunciations', 'voicePreferences']) if (base.production.speech[key] !== undefined) speech[key] = structuredClone(base.production.speech[key]);
    if (Object.keys(speech).length) production.speech = speech;
  }
  if (project.audio.bgmId && base.production?.music?.appliedCandidate) production.music = {appliedCandidate: structuredClone(base.production.music.appliedCandidate)};
  if (project.imageStudio.references.length && base.production?.referenceMedia?.imports?.length) production.referenceMedia = {imports: structuredClone(base.production.referenceMedia.imports)};
  if (Object.keys(production).length > 1) project.production = production;
  return validateProject(project);
}
