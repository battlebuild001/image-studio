import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createProject, createScene} from '../dist/project.js';
import {visualReviewContext} from '../dist/production-visual-protocol.js';
import {createWorkflowReviewRunner} from '../dist/workflow-review-runner.js';

const png = (await readFile(new URL('./fixtures/image-test-1.png', import.meta.url))).toString('base64');
function fixture(count = 8) {
  const project = createProject({id: 'review-fixture', title: '행성 탐사', scenes: Array.from({length: count}, (_, index) => createScene({id: 'scene-' + index, imageId: 'image-' + index, caption: index ? '탐사대가 기지를 세웠습니다.' : '2030년 탐사대가 행성에 도착했습니다.', duration: 2})), scriptDraft: {sourceText: '2030년 탐사대가 행성에 도착했습니다. 탐사대가 기지를 세웠습니다.', displayScript: '2030년 탐사대가 행성에 도착했습니다. 탐사대가 기지를 세웠습니다.', draftScript: '이영삼영년 탐사대가 행성에 도착했습니다. 탐사대가 기지를 세웠습니다.'}});
  const assets = new Map(project.scenes.map(scene => [scene.imageId, {name: scene.imageId, blob: new Blob(['synthetic-pixel-file'], {type: 'image/png'})}]));
  assets.set('reference', {name: '사용자 기준 이미지', blob: new Blob(['synthetic-reference'], {type: 'image/png'})});
  project.imageStudio.references = [{assetId: 'reference', role: 'concept', label: '기준 외형', enabled: true}];
  let workspace = 'workspace-a', settings = 'settings-a';
  const api = {getProject: () => project, getAssets: () => assets, getWorkspaceId: () => workspace, getReviewSettingsKey: () => settings, reviewSettingsTarget: new EventTarget()};
  return {project, assets, api, changeWorkspace: () => workspace = 'workspace-b', changeSettings: () => settings = 'settings-b'};
}
function services({request, scanQuality} = {}) {
  return {scanQuality: scanQuality || (async () => ({duration: 16, sceneCount: 8, cueCount: 2, findings: [{severity: 'warning', title: '읽기 속도 확인', detail: '실제 자막 배치 검토 후보', time: 1, sceneId: 'scene-0'}], counts: {error: 0, warning: 1, info: 0}})),
    prepareImages: async (project, assets, sceneIds) => ({sceneIds, context: visualReviewContext(project, sceneIds), images: [...sceneIds.map(sceneId => ({sceneId, role: 'scene', label: sceneId, mimeType: 'image/png', data: png})), {role: 'reference', label: '실제 기준 외형', mimeType: 'image/png', data: png}], media: []}),
    request: request || (async (_path, options) => {
      const body = JSON.parse(options.body);
      if (body.task === 'source-fidelity') return Response.json({summary: '제공 원문과 자막용 대본 비교', findings: [{kind: 'review', severity: 'info', sourceQuote: '2030년', scriptQuote: '2030년', reason: '연도가 일치합니다.', suggestion: '실제 문구를 확인하세요.', sceneId: ''}], notes: [], model: 'fixture-text', createdAt: '2026-11-06T00:00:00.000Z'});
      return Response.json({summary: '실제 장면 픽셀 비교', findings: [{sceneId: body.options.sceneIds[0], severity: 'warning', reason: '기지 외형 확인', suggestion: '기준 이미지와 비교하세요.'}], notes: [], model: 'fixture-vision', createdAt: '2026-11-06T00:00:00.000Z'});
    })};
}

test('preparation is readonly and counts real current images in six-scene requests plus enabled references', () => {
  const {api, project, assets} = fixture(), before = structuredClone(project);let requests = 0;
  const runner = createWorkflowReviewRunner(services({request: async () => {requests++;throw Error('must not run');}}));
  const prepared = runner.prepareReviewWork(api, {localReview: true, sourceReview: true, imageReview: true});
  assert.deepEqual(prepared.counts, {localChecks: 1, fidelityRequests: 1, visualRequests: 2, projectedVisualRequests: 2, sceneImages: 8, referenceImagesPerRequest: 1, paidRequests: 3});
  assert.deepEqual(prepared.blockers, []);assert.deepEqual(project, before);assert.equal(requests, 0);assert.equal(assets.size, 9);
  const portable = JSON.stringify(prepared);assert.doesNotMatch(portable, /2030년|synthetic-pixel-file|synthetic-reference|apiKey|accessToken/u);
});

test('projected scene count is an upfront ceiling and never pretends missing pixels were reviewed', async () => {
  const {api, project} = fixture();project.scenes[3].imageId = null;project.scenes[4].imageId = null;
  const runner = createWorkflowReviewRunner(services()), prepared = runner.prepareReviewWork(api, {localReview: false, imageReview: true, projectedVisualSceneIds: project.scenes.map(scene => scene.id)});
  assert.equal(prepared.counts.visualRequests, 1);assert.equal(prepared.counts.projectedVisualRequests, 2);assert.equal(prepared.counts.sceneImages, 6);assert.match(prepared.warnings[0], /6\/8/u);
  const result = await runner.runReviewWork(api, prepared, {maxPaidRequests: 2});assert.equal(result.paidRequests, 1);assert.equal(result.visualReview.sceneIds.length, 6);
});

test('one run executes local inspection, exact quoted source review and actual image payloads sequentially without editing', async () => {
  const {api, project, assets} = fixture(), before = structuredClone(project), blobs = [...assets].map(([id, value]) => [id, value.blob]), calls = [], progress = [], partial = [];
  const base = services(), runner = createWorkflowReviewRunner({...base, request: async (path, options) => {calls.push(JSON.parse(options.body));return base.request(path, options);}});
  const result = await runner.runReviewWork(api, runner.prepareReviewWork(api, {localReview: true, sourceReview: true, imageReview: true}), {maxPaidRequests: 3, onProgress: value => progress.push(value), onPartial: value => partial.push(value.stage)});
  assert.deepEqual(partial, ['local', 'source', 'images']);assert.deepEqual(result.completedStages, partial);assert.equal(result.paidRequests, 3);assert.deepEqual(calls.map(value => value.task), ['source-fidelity', 'visual-review', 'visual-review']);
  assert.equal(calls[0].context.sourceText, project.scriptDraft.sourceText);assert.equal(calls[0].context.fullScript, project.scriptDraft.displayScript);assert.equal(calls[0].images, undefined);
  assert.deepEqual(calls.slice(1).map(value => value.options.sceneIds.length), [6, 2]);for (const call of calls.slice(1)) {assert.equal(call.images.length, call.options.sceneIds.length + 1);assert.ok(call.images.every(image => image.data === png));}
  assert.equal(result.findings.length, 4);assert.deepEqual(result.counts, {error: 0, warning: 3, info: 1});assert.ok(progress.some(value => value.stage === 'images' && value.total === 2));assert.deepEqual(project, before);assert.deepEqual([...assets].map(([id, value]) => [id, value.blob]), blobs);
});

test('local-only inspection sends zero requests and allows its own decoded cache handles without changing source files', async () => {
  const {api, assets, project} = fixture(1), before = structuredClone(project);let calls = 0;
  const runner = createWorkflowReviewRunner(services({request: async () => {calls++;throw Error('must not run');}, scanQuality: async (_project, map, options) => {map.get('image-0').image = {width: 10, height: 10};options.assertCurrent();return {findings: [], limits: [], counts: {error: 0, warning: 0, info: 0}};}}));
  const result = await runner.runReviewWork(api, runner.prepareReviewWork(api));assert.equal(calls, 0);assert.equal(result.paidRequests, 0);assert.deepEqual(result.completedStages, ['local']);assert.deepEqual(project, before);assert.ok(assets.get('image-0').image);
});

test('source, owner, media and API settings changes reject a previously reviewed scope before any paid call', async () => {
  for (const change of ['source', 'owner', 'media', 'settings']) {
    const data = fixture(1);let calls = 0;const runner = createWorkflowReviewRunner(services({request: async () => {calls++;throw Error('must not run');}}));
    const prepared = runner.prepareReviewWork(data.api, {localReview: false, sourceReview: true});
    if (change === 'source') data.project.scriptDraft.sourceText += ' 변경';if (change === 'owner') data.changeWorkspace();if (change === 'media') data.assets.get('image-0').blob = new Blob(['replacement']);if (change === 'settings') data.changeSettings();
    await assert.rejects(runner.runReviewWork(data.api, prepared), {name: 'AbortError'});assert.equal(calls, 0, change);
  }
});

test('API key-change events abort in-flight work even when safe metadata is unchanged, with zero retries', async () => {
  const {api} = fixture(1);let calls = 0, entered;
  const started = new Promise(resolve => entered = resolve), runner = createWorkflowReviewRunner(services({request: async (_path, options) => {calls++;entered();await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), {once: true}));}}));
  const active = runner.runReviewWork(api, runner.prepareReviewWork(api, {localReview: false, sourceReview: true}));await started;api.reviewSettingsTarget.dispatchEvent(new Event('studio-api-settings-change'));await assert.rejects(active, {name: 'AbortError'});assert.equal(calls, 1);
});

test('a provider failure stops following review batches, does not retry and preserves already completed partial results', async () => {
  const {api} = fixture();let calls = 0;const partial = [], runner = createWorkflowReviewRunner(services({request: async () => {calls++;return Response.json({error: '합성 AI 점검 오류'}, {status: 503});}}));
  await assert.rejects(runner.runReviewWork(api, runner.prepareReviewWork(api, {localReview: true, sourceReview: true, imageReview: true}), {onPartial: value => partial.push(value.stage)}), /합성 AI 점검 오류/u);
  assert.equal(calls, 1);assert.deepEqual(partial, ['local']);
});

test('bounded timeout aborts a single review request and never retries', async () => {
  const {api} = fixture(1);let calls = 0;
  const runner = createWorkflowReviewRunner({...services({request: async (_path, options) => {calls++;await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), {once: true}));}}), timeoutMs: 10});
  await assert.rejects(runner.runReviewWork(api, runner.prepareReviewWork(api, {localReview: false, sourceReview: true})), {name: 'AbortError'});assert.equal(calls, 1);
});

test('malformed quotes, unknown image scene IDs and insufficient authorization cannot produce an accepted report', async () => {
  const {api} = fixture(1);let calls = 0;
  const base = services(), runner = createWorkflowReviewRunner({...base, request: async () => {calls++;return Response.json({summary: '조작된 결과', findings: [{kind: 'missing', severity: 'error', sourceQuote: '없는 사실', scriptQuote: '', reason: '누락', suggestion: '수정', sceneId: ''}], notes: []});}});
  const prepared = runner.prepareReviewWork(api, {localReview: false, sourceReview: true});await assert.rejects(runner.runReviewWork(api, prepared, {maxPaidRequests: 0}), /호출량/u);assert.equal(calls, 0);
  await assert.rejects(runner.runReviewWork(api, prepared), /인용/u);assert.equal(calls, 1);
  const wrong = createWorkflowReviewRunner({...base, request: async () => Response.json({summary: '잘못된 장면', findings: [{sceneId: 'not-in-project', severity: 'error', reason: '불일치', suggestion: '수정'}], notes: []})});
  await assert.rejects(wrong.runReviewWork(api, wrong.prepareReviewWork(api, {localReview: false, imageReview: true})), /장면/u);
  await assert.rejects(runner.runReviewWork(api, structuredClone(prepared)), /먼저 확인/u);
});

test('missing source, missing pixels and invalid scene selections are explained without provider calls', async () => {
  const {api, project} = fixture(1), runner = createWorkflowReviewRunner(services());project.scriptDraft.sourceText = '';project.scenes[0].imageId = null;
  const prepared = runner.prepareReviewWork(api, {localReview: false, sourceReview: true, imageReview: true});assert.equal(prepared.blockers.length, 2);await assert.rejects(runner.runReviewWork(api, prepared));
  const invalid = runner.prepareReviewWork(api, {imageReview: true, sceneIds: ['unknown']});assert.ok(invalid.blockers.some(value => /장면/u.test(value)));
});

test('review outputs are bounded and never mutate the source to fix model suggestions', async () => {
  const {api, project} = fixture(1), before = structuredClone(project), findings = Array.from({length: 500}, () => ({severity: 'warning', title: '문제 후보', detail: '읽기만 하는 검토', sceneId: 'scene-0', time: 0}));
  const runner = createWorkflowReviewRunner(services({scanQuality: async () => ({findings})}));const result = await runner.runReviewWork(api, runner.prepareReviewWork(api));
  assert.equal(result.totalFindings, 500);assert.equal(result.findings.length, 200);assert.equal(result.omittedFindings, 300);assert.deepEqual(project, before);assert.match(result.limits[0], /자동 수정하지/u);
});

test('metadata accounting cannot invalidate a readonly review, while aggregate results prioritize errors and retain source evidence', async () => {
  const {api, project} = fixture(1), localFindings = Array.from({length: 250}, (_, index) => ({severity: 'warning', title: '로컬 확인 ' + index, detail: '실제 화면 검토', sceneId: 'scene-0', time: index}));
  const runner = createWorkflowReviewRunner(services({scanQuality: async () => ({findings: localFindings, counts: {error: 0, warning: 400, info: 0}, totalFindings: 400, omittedFindings: 150}), request: async () => {project.production = {version: 1, budget: {spentUsd: 1, ledger: []}};return Response.json({summary: '인용 검토', findings: [{kind: 'changed', severity: 'error', sourceQuote: '2030년', scriptQuote: '2030년', reason: '문맥 확인', suggestion: '해당 연도 전후를 검토하세요.', sceneId: ''}], notes: []});}}));
  const result = await runner.runReviewWork(api, runner.prepareReviewWork(api, {localReview: true, sourceReview: true}));
  assert.deepEqual(result.counts, {error: 1, warning: 400, info: 0});assert.equal(result.totalFindings, 401);assert.equal(result.omittedFindings, 201);assert.equal(result.findings.length, 200);assert.equal(result.findings[0].severity, 'error');assert.match(result.findings[0].detail, /원문 인용: 2030년/u);assert.match(result.findings[0].detail, /대본 인용: 2030년/u);assert.equal(result.paidRequests, 1);
});

test('caller edits to visible blockers cannot authorize a prepared request with missing source data', async () => {
  const {api, project} = fixture(1);project.scriptDraft.sourceText = '';let calls = 0;const runner = createWorkflowReviewRunner(services({request: async () => {calls++;throw Error('must not run');}}));
  const prepared = runner.prepareReviewWork(api, {localReview: false, sourceReview: true});prepared.blockers.length = 0;
  await assert.rejects(runner.runReviewWork(api, prepared));assert.equal(calls, 0);
});
