import {createOperationStatus, nextPaint} from './operation-status.js';
import {visualReviewContext, visualReviewKey, normalizeVisualReview} from './production-visual-protocol.js';
import {visualNode as node, visualButton as button, visualField as field, saveProductionDomain, productionAssist, localAssetPixels} from './production-visual-utils.js';

const severityNames = {info: '참고', warning: '확인 필요', error: '수정 권장'};
export async function prepareVisualReviewImages(project, assets, sceneIds, {signal} = {}) {
  const wanted = new Set(sceneIds), scenes = project.scenes.filter(scene => wanted.has(scene.id) && scene.imageId);
  if (!scenes.length || scenes.length > 6) throw new Error('한 번에 실제 이미지가 있는 장면 1~6개를 점검해요.');
  const images = [], media = [];
  for (const scene of scenes) {
    const asset = assets.get(scene.imageId);images.push({...await localAssetPixels(asset, {signal}), sceneId: scene.id, label: `장면 ${project.scenes.findIndex(item => item.id === scene.id) + 1}`, role: 'scene'});media.push({id: scene.imageId, blob: asset?.blob, image: asset?.image});
  }
  for (const ref of (project.imageStudio?.references || []).filter(value => value.enabled !== false).sort((a, b) => Number(a.role !== 'concept') - Number(b.role !== 'concept')).slice(0, 2)) {
    const asset = assets.get(ref.assetId);if (!asset) throw new Error('고정 레퍼런스 파일을 찾을 수 없어요.');
    images.push({...await localAssetPixels(asset, {signal}), label: ref.label || ref.role || '고정 레퍼런스', role: 'reference'});media.push({id: ref.assetId, blob: asset.blob, image: asset.image});
  }
  return {images, media, sceneIds: scenes.map(scene => scene.id), context: visualReviewContext(project, scenes.map(scene => scene.id))};
}
export function setupProductionVisual(api) {
  const root = api.container;root.append(node('h3', '', '대본과 이미지 함께 점검하기'), node('p', 'production-help', '실제 장면 이미지를 AI가 보고 대본·공통 콘셉트와 비교해요. 관련 없는 장면, 반복 구도, 외형 차이를 수정 후보로 정리합니다. 결과는 검토 제안이며 사실·공식 설정의 정확성을 보장하지 않아요.'));
  const target = field('visualReviewTarget', '점검 범위', {options: [['all', '이미지가 있는 모든 장면'], ['selected', '선택한 장면만']]});
  const actions = node('div', 'production-actions'), start = button('runVisualReviewBtn', '이미지 점검', 'primary'), cancel = button('cancelVisualReviewBtn', '작업 취소'), configure = button('visualReviewApiSettingsBtn', 'API 설정', 'ghost');cancel.hidden = true;actions.append(start, cancel, configure);root.append(target.wrapper, actions);
  const quantity = node('p', 'production-help'), stale = node('p', 'production-status'), error = node('p', 'production-error');error.id = 'visualReviewError';error.setAttribute('role', 'alert');root.append(quantity, stale, error);
  const progress = createOperationStatus({container: root, region: root, id: 'visualReviewOperation'}), results = node('div');results.id = 'visualReviewResults';root.append(results);
  let active = null, serial = 0, rendered = '', owner = api.getProject().id;
  function selected(project = api.getProject()) {const wanted = new Set(api.getSelectedIds?.() || [api.getSelectedId?.()]);return project.scenes.filter(scene => scene.imageId && (target.input.value === 'all' || wanted.has(scene.id))).map(scene => scene.id);}
  function busy() {const value = Boolean(active);start.disabled = value || !selected().length;target.input.disabled = value;cancel.hidden = !value;cancel.disabled = Boolean(active?.cancelled);}
  function stop(message = '이미지 점검을 취소했어요. 이전 결과는 유지돼요.') {serial++;active?.controller.abort();active = null;progress.cancel(message);busy();}
  function match(run) {const project = api.getProject();return serial === run.serial && project.id === run.projectId && (api.getWorkspaceId?.() || '') === run.workspaceId && visualReviewKey(project, run.sceneIds) === run.inputKey && run.media.every(saved => {const now = api.getAssets().get(saved.id);return now?.blob === saved.blob && now?.image === saved.image;});}
  function drawResult(value, previous = false) {
    results.replaceChildren();if (!value) return;
    const card = node('article', 'production-card');card.append(node('h4', '', previous ? '이전 이미지 점검 결과' : '이미지 점검 결과'), node('p', '', value.summary || 'AI 점검을 완료했어요.'));
    card.append(node('p', 'production-help', `${value.sceneIds?.length || 0}개 장면 · ${value.reviewedAt ? new Date(value.reviewedAt).toLocaleString('ko-KR') : ''}${value.model ? ' · ' + value.model : ''}`));
    if (!value.findings?.length) card.append(node('p', '', '수정 후보가 보고되지 않았어요. 문제가 없다는 보증은 아니므로 중요한 외형·설정은 직접 확인해 주세요.'));
    for (const finding of value.findings || []) {
      const scene = api.getProject().scenes.find(item => item.id === finding.sceneId), index = api.getProject().scenes.indexOf(scene), item = node('section', 'production-card');
      item.dataset.sceneId = finding.sceneId;item.append(node('strong', '', `${index >= 0 ? '장면 ' + (index + 1) : '이전 장면'} · ${severityNames[finding.severity] || '참고'}`), node('p', '', finding.reason), node('p', 'production-help', finding.suggestion));
      const row = node('div', 'production-actions'), inspect = button('', '장면 보기'), regenerate = button('', '이 장면 수정하기');inspect.disabled = regenerate.disabled = !scene;
      inspect.addEventListener('click', () => {if (api.selectScene) api.selectScene(finding.sceneId);else {let time = 0;for (const value of api.getProject().scenes) {if (value.id === finding.sceneId) break;time += value.duration;}api.seek?.(time);}});
      regenerate.addEventListener('click', () => (api.openSection || api.openProductionSection)?.('changes', {sceneIds: [finding.sceneId], reason: finding.suggestion || finding.reason}));row.append(inspect, regenerate);item.append(row);card.append(item);
    }
    if (value.notes?.length) {const list = node('ul');for (const note of value.notes) list.append(node('li', '', note));card.append(list);}results.append(card);
  }
  async function runReview() {
    if (active) return;error.textContent = '';const project = api.getProject(), sceneIds = selected(project);if (!sceneIds.length) {error.textContent = '점검할 이미지가 있는 장면을 먼저 선택해 주세요.';return;}
    const controller = new AbortController(), run = {controller, serial: ++serial, projectId: project.id, workspaceId: api.getWorkspaceId?.() || '', sceneIds, inputKey: visualReviewKey(project, sceneIds), media: [], cancelled: false};active = run;
    const task = progress.start('점검용 이미지와 대본을 준비하고 있어요.');busy();let timeout;
    try {
      await nextPaint();let findings = [], notes = [], summaries = [], model = '', createdAt = '';
      for (let from = 0; from < sceneIds.length; from += 6) {
        if (!match(run)) throw new DOMException('이미지나 대본이 바뀌었어요.', 'AbortError');
        task.update(`${Math.floor(from / 6) + 1}/${Math.ceil(sceneIds.length / 6)}회 · 장면 이미지 ${Math.min(6, sceneIds.length - from)}장을 점검하고 있어요.`);
        const input = await prepareVisualReviewImages(api.getProject(), api.getAssets(), sceneIds.slice(from, from + 6), {signal: controller.signal});run.media.push(...input.media);
        if (!match(run)) throw new DOMException('점검 자료가 바뀌었어요.', 'AbortError');
        timeout = setTimeout(() => controller.abort(), 190000);
        const result = normalizeVisualReview(await productionAssist('visual-review', input.context, {sceneIds: input.sceneIds}, input.images, controller.signal), input.sceneIds);clearTimeout(timeout);
        if (!match(run)) throw new DOMException('점검 자료가 바뀌었어요.', 'AbortError');
        findings.push(...result.findings);notes.push(...result.notes);summaries.push(result.summary);model = result.model;createdAt = result.createdAt;
      }
      if (findings.length > 200) {notes.push('표시할 수정 후보가 많아 처음 200개를 보관했습니다. 범위를 나누어 추가 점검하세요.');findings = findings.slice(0, 200);}
      const value = {inputKey: run.inputKey, sceneIds, reviewedAt: createdAt || new Date().toISOString(), model, summary: summaries.join('\n\n').slice(0, 4000), findings, notes: [...new Set(notes)].slice(0, 12)};
      if (!match(run)) return;saveProductionDomain(api, 'visual', value);await api.persist?.();if (serial !== run.serial || api.getProject().id !== run.projectId) return;
      task.finish(`${sceneIds.length}개 장면의 이미지 점검 결과를 저장했어요.`);drawResult(value);rendered = '';
    } catch (cause) {if (serial !== run.serial) return;const message = cause?.name === 'AbortError' ? '점검을 중단했어요. 완료 전 결과를 덮어쓰지 않았어요. 이전 점검은 유지돼요.' : cause?.message || '이미지 점검을 완료하지 못했어요.';error.textContent = message;cause?.name === 'AbortError' ? task.cancel(message) : task.fail(message);}
    finally {clearTimeout(timeout);if (serial === run.serial) {active = null;busy();render();}}
  }
  function render() {
    const project = api.getProject();if (owner !== project.id) {stop('작업공간이 바뀌어 점검을 중단했어요.');owner = project.id;rendered = '';}
    if (active && !match(active)) stop('이미지나 대본이 바뀌어 점검을 중단했어요. 이전 결과는 유지돼요.');
    const ids = selected(project), references = (project.imageStudio?.references || []).filter(value => value.enabled !== false).slice(0, 2).length;
    quantity.textContent = ids.length ? `장면 이미지 ${ids.length}장 · ${Math.ceil(ids.length / 6)}회 AI 요청 · 각 요청에 기준 이미지 최대 ${references}장. 버튼을 누르면 해당 이미지 픽셀과 대본이 AI로 전송되며 사용료가 발생할 수 있어요.` : '점검할 장면 이미지를 추가하거나 선택해 주세요.';
    start.textContent = active ? '이미지 점검 중…' : `이미지 ${ids.length}장 점검`;
    let value = project.production?.visual;
    if (value) {try {if (!Array.isArray(value.sceneIds) || !value.sceneIds.length) throw new Error('저장된 점검 범위를 읽지 못했어요. 장면을 다시 점검해 주세요.');value = {...value, ...normalizeVisualReview({...value, createdAt: value.reviewedAt}, value.sceneIds)};} catch (cause) {error.textContent = cause.message;results.replaceChildren();busy();return;}}
    const previous = Boolean(value && value.inputKey !== visualReviewKey(project, value.sceneIds));stale.textContent = previous ? '이미지·대본·콘셉트가 바뀐 이전 점검 결과예요. 현재 장면을 다시 점검할 수 있어요.' : '';
    const key = JSON.stringify({value, previous, sceneIds: project.scenes.map(scene => scene.id)});if (key !== rendered) {rendered = key;drawResult(value, previous);}busy();
  }
  target.input.addEventListener('change', render);start.addEventListener('click', runReview);cancel.addEventListener('click', () => stop());configure.addEventListener('click', () => api.openApiSettings?.());window.addEventListener('studio-api-settings-change', () => {if (active) stop('API 연결이 바뀌어 점검을 중단했어요. 이전 결과는 유지돼요.');});render();
  return {render, flush() {}, onClose() {if (active) stop('제작 관리를 닫아 이미지 점검을 중단했어요. 이전 결과는 유지돼요.');}, reset() {stop('');rendered = '';owner = api.getProject().id;progress.clear();error.textContent = '';render();}};
}
