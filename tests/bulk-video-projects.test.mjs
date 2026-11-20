import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildBulkScriptProject} from '../dist/bulk-video-projects.js';
import {validateProject, referencedAssetIds, exportProjectBackup, importProjectBackup} from '../dist/project.js';
import {getScenePlanStatus} from '../dist/script-planning.js';
import {defaultProductionBudget} from '../dist/production-budget.js';

const script = '  첫 번째 사건은 관측소에서 시작합니다. 🌟\n\n시간이 흐른 뒤 새 도시에 도착합니다.  ';
test('multiple-script input preserves the same Korean gloss cleanup as the single-video editor',()=>{
 const project=buildBulkScriptProject({script:'헤드리스(Headless)가 도착했습니다. 이동(6인치) 후 공격합니다.',durationSeconds:10});
 assert.equal(project.scriptDraft.displayScript,'헤드리스가 도착했습니다. 이동(6인치) 후 공격합니다.');
 assert.equal(project.scriptDraft.draftScript,project.scriptDraft.displayScript);
 assert.equal(project.scenes.map(scene=>scene.caption).join(''),project.scriptDraft.displayScript);
 assert.equal(getScenePlanStatus(project).valid,true);
});
function baseProject() {
  const original = buildBulkScriptProject({script: '이전 대본입니다.', title: '이전 영상', durationSeconds: 10});
  original.scenes[0].imageId = 'original-image';original.audio = {...original.audio, narrationId: 'original-narration', narrationOffset: 3, bgmId: 'music', bgmStart: 1, bgmEnd: 5};
  original.captionMode = 'srt';original.captions = [{start: 0, end: 3, text: '재사용하면 안 되는 이전 자막'}];
  original.settings.aiImageNotice = true;original.aspect = '9:16';
  original.imageStudio = {...original.imageStudio, background: '공유 세계관', style: '차분한 청록색', negativePrompt: '자막과 로고', references: [{assetId: 'fixed-reference', label: '기준', role: 'style', enabled: true}]};
  original.scenePlan.visualBrief = '공통 콘셉트';original.scenePlan.imageInstructions = '넓은 구도로 제작하세요.';
  original.production = {version: 1, budget: {...defaultProductionBudget(), enabled: true, limit: 20, spentUsd: 5}, youtube: {draft: {title: '이전 업로드 제목'}}};
  return validateProject(original);
}

test('bulk scripts use independent fixed-interval plans and preserve complete source without inheriting narration/images/captions', () => {
  const base = baseProject(), before = structuredClone(base);
  const first = buildBulkScriptProject({baseProject: base, script, title: '첫 영상', durationSeconds: 25.5, intervalSeconds: 10});
  const second = buildBulkScriptProject({baseProject: base, script, title: '다음 영상', durationSeconds: 25.5, intervalSeconds: 10});
  assert.deepEqual(base, before);assert.notEqual(first.id, second.id);assert.notEqual(first.id, base.id);
  assert.deepEqual(first.scenes.map(scene => scene.duration), [10, 10, 5.5]);
  assert.deepEqual(first.scenePlan.items.map(item => [item.start, item.end]), [[0, 10], [10, 20], [20, 25.5]]);
  assert.ok(first.scenes.every(scene => scene.imageId === null));assert.ok(first.scenes.every(scene => !second.scenes.some(other => other.id === scene.id)));
  assert.equal(first.audio.narrationId, null);assert.equal(first.audio.narrationOffset, 0);
  assert.equal(first.captionMode, 'auto');assert.deepEqual(first.captions, []);assert.equal(first.captionAnalysis, null);
  assert.equal(first.scenePlan.sourceScript, script);assert.equal(first.scriptDraft.draftScript, script);assert.equal(first.scriptDraft.displayScript, script);assert.equal(first.scriptDraft.result, null);
  assert.equal(first.scenes.map(scene => scene.caption).join(''), script.trim());
  assert.equal(getScenePlanStatus(first).valid, true);assert.equal(getScenePlanStatus(second).valid, true);
});

test('bulk scripts inherit visual settings, enabled references, common instructions and actual BGM while starting a fresh budget', () => {
  const base = baseProject(), project = buildBulkScriptProject({baseProject: base, script, title: '새 영상', durationSeconds: 30});
  assert.equal(project.aspect, base.aspect);assert.deepEqual(project.settings, base.settings);assert.deepEqual(project.imageStudio, base.imageStudio);
  assert.equal(project.scenePlan.visualBrief, base.scenePlan.visualBrief);assert.equal(project.scenePlan.imageInstructions, base.scenePlan.imageInstructions);
  assert.deepEqual([project.audio.bgmId, project.audio.bgmStart, project.audio.bgmEnd], ['music', 1, 5]);
  assert.deepEqual(new Set(referencedAssetIds(project)), new Set(['music', 'fixed-reference']));
  assert.equal(project.production.budget.enabled, true);assert.equal(project.production.budget.limit, 20);assert.equal(project.production.budget.spentUsd, 0);assert.deepEqual(project.production.budget.ledger, []);
  assert.equal(project.production.youtube, undefined);assert.equal(project.production.run, undefined);assert.equal(project.scenePlan.visualPlan, undefined);
});

test('bulk script output survives canonical portable backup with only its selected reference/music blobs', async () => {
  const project = buildBulkScriptProject({baseProject: baseProject(), script, title: '백업 영상', durationSeconds: 30});
  const assets = new Map([['fixed-reference', {blob: new Blob(['synthetic reference'], {type: 'image/png'}), name: 'reference.png'}], ['music', {blob: new Blob(['synthetic music'], {type: 'audio/wav'}), name: 'music.wav'}]]);
  const result = await importProjectBackup(await exportProjectBackup(project, assets));
  assert.deepEqual(result.project, project);assert.equal(await result.assets.get('music').blob.text(), 'synthetic music');assert.equal(getScenePlanStatus(result.project).valid, true);
});

test('bulk script planning rejects unsupported sizes/timing and follows cadence rather than sentence count', () => {
  for (const input of [{script: ''}, {script: ' '}, {script: null}, {script: '가'.repeat(100001)}, {title: ''}, {title: '가'.repeat(201)}, {durationSeconds: 0}, {durationSeconds: 3600.1}, {durationSeconds: NaN}, {durationSeconds: '30'}, {intervalSeconds: 0}, {intervalSeconds: 601}, {durationSeconds: 3600, intervalSeconds: 1}]) {
    assert.throws(() => buildBulkScriptProject({script: '내용', title: '검사', durationSeconds: 30, ...input}));
  }
  const manySentences = Array.from({length: 157}, (_, index) => `${index}번 문장입니다.`).join('\n');
  const project = buildBulkScriptProject({script: manySentences, title: '간격 검사', durationSeconds: 480, intervalSeconds: 10});
  assert.equal(project.scenes.length, 48);assert.equal(project.scriptDraft.targetMinutes, 8);assert.equal(getScenePlanStatus(project).valid, true);
  assert.equal(buildBulkScriptProject({script: '짧은 영상', durationSeconds: 1}).scenes[0].duration, 1);
});

test('new scripts retain source credits and shared speech/description preferences without old upload materials', async () => {
  const base = baseProject();
  const candidate = kind => ({id: kind === 'image' ? 'commons-100' : 'commons-200', kind, title: '합성 출처 자료', mimeType: kind === 'image' ? 'image/png' : 'audio/wav',
    mediaUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic.' + (kind === 'image' ? 'png' : 'wav'), originalUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic.' + (kind === 'image' ? 'png' : 'wav'),
    sourceUrl: 'https://commons.wikimedia.org/?curid=' + (kind === 'image' ? '100' : '200'), artist: '합성 저작자', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/'});
  base.production.music = {appliedCandidate: candidate('audio')};
  base.production.referenceMedia = {imports: [candidate('image')]};
  base.production.speech = {pronunciations: [{term: 'NASA', reading: '나사'}]};
  base.production.description = {length: 'short', support: false, hashtags: false, channelIntro: false};
  const canonical = validateProject(base);
  const next = buildBulkScriptProject({baseProject: canonical, script, title: '출처 유지', durationSeconds: 30});
  assert.deepEqual(next.production.music.appliedCandidate, canonical.production.music.appliedCandidate);
  assert.deepEqual(next.production.referenceMedia.imports, canonical.production.referenceMedia.imports);
  assert.deepEqual(next.production.speech.pronunciations, canonical.production.speech.pronunciations);
  assert.deepEqual(next.production.description, canonical.production.description);
  assert.equal(next.production.youtube, undefined);
  const media = new Map([['music', {blob: new Blob(['audio'], {type: 'audio/wav'}), name: '음악.wav'}], ['fixed-reference', {blob: new Blob(['image'], {type: 'image/png'}), name: '기준.png'}]]);
  const restored = await importProjectBackup(await exportProjectBackup(next, media));
  assert.deepEqual(restored.project.production.referenceMedia, next.production.referenceMedia);
  assert.deepEqual(restored.project.production.music, next.production.music);
});
