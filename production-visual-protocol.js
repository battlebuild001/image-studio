/** Pure contracts shared by in-app visual review and factual graphic tools. */
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ids = /^[A-Za-z0-9_-]{1,180}$/u;
const fail = message => {throw new Error(message);};
export const DIAGRAM_TYPES = ['timeline', 'relations', 'chart', 'map'];
export function visualText(value, limit, label, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || Array.from(value).length > limit) fail(`${label}의 형식이나 길이를 확인해 주세요.`);
  return value.replace(/\u0000/g, '').trim();
}
function textList(value, maximum, limit, label) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} 항목 수를 확인해 주세요.`);
  return value.map(item => visualText(item, limit, label));
}
function id(value, label) {if (typeof value !== 'string' || !ids.test(value)) fail(`${label} 식별자를 확인해 주세요.`);return value;}
export function productionFingerprint(value) {
  const source = JSON.stringify(value);let a = 2166136261, b = 2246822507;
  for (const character of source) {const code = character.codePointAt(0);a = Math.imul(a ^ code, 16777619);b = Math.imul(b ^ code, 3266489909);}
  return `v1-${(a >>> 0).toString(16).padStart(8, '0')}-${(b >>> 0).toString(16).padStart(8, '0')}`;
}
export function displaySource(project) {
  return String(project.scriptDraft?.displayScript ?? project.scriptDraft?.result?.displayScript ?? project.scenePlan?.sourceScript ?? project.scriptDraft?.draftScript ?? project.scriptDraft?.result?.script ?? project.scenes?.map(scene => scene.caption).filter(Boolean).join('\n\n') ?? '');
}
export function visualReviewContext(project, sceneIds) {
  const selected = new Set(sceneIds), refs = (project.imageStudio?.references || []).filter(value => value.enabled !== false).sort((a, b) => Number(a.role !== 'concept') - Number(b.role !== 'concept')).slice(0, 2);
  let start = 0;
  const scenes = (project.scenes || []).flatMap(scene => {const before = start;start += scene.duration;return selected.has(scene.id) ? [{sceneId: scene.id, start: before, end: start, caption: scene.caption || '', imageId: scene.imageId || ''}] : [];});
  return {title: String(project.title || '').slice(0, 200), fullScript: displaySource(project).slice(0, 100000),
    visualBrief: String(project.scenePlan?.visualPlan?.globalConcept || project.scenePlan?.visualBrief || project.scriptDraft?.topicResearch?.result?.visualBrief || '').slice(0, 6000),
    background: String(project.imageStudio?.background || '').slice(0, 20000), style: String(project.imageStudio?.style || '').slice(0, 4000), negativePrompt: String(project.imageStudio?.negativePrompt || '').slice(0, 2000),
    scenes, referenceRoles: refs.map(ref => ({assetId: ref.assetId, label: ref.label || '', role: ref.role || 'other'}))};
}
export function visualReviewKey(project, sceneIds) {return productionFingerprint(visualReviewContext(project, sceneIds));}
export function normalizeVisualReview(value, sceneIds) {
  if (!plain(value)) fail('이미지 점검 결과를 읽지 못했어요. 이전 결과는 유지돼요.');
  const known = new Set(sceneIds);
  if (!Array.isArray(value.findings) || value.findings.length > 200) fail('이미지 점검 항목 수를 확인해 주세요.');
  const findings = value.findings.map(finding => {
    if (!plain(finding) || !known.has(finding.sceneId) || !['info', 'warning', 'error'].includes(finding.severity)) fail('점검한 이미지와 결과의 장면이 일치하지 않아요.');
    const reason = visualText(finding.reason, 2000, '점검 이유'), suggestion = visualText(finding.suggestion, 3000, '수정 제안');
    if (!reason) fail('점검 이유가 없는 응답은 적용하지 않았어요.');
    return {sceneId: finding.sceneId, severity: finding.severity, reason, suggestion};
  });
  return {summary: visualText(value.summary, 4000, '점검 요약'), findings, notes: textList(value.notes, 12, 1000, '점검 참고 사항'),
    model: visualText(value.model, 100, '모델'), createdAt: visualText(value.createdAt, 40, '점검 시각', new Date().toISOString())};
}
export function diagramSource(project) {
  const research = project.scriptDraft?.topicResearch?.result;
  return [displaySource(project), research ? ['[프로젝트에 보관된 조사 자료]', research.summary, ...(research.sections || []).map(item => `${item.heading}\n${item.text}`)].join('\n\n') : ''].filter(Boolean).join('\n\n');
}
export function normalizeDiagramCard(value, index = 0) {
  if (!plain(value) || !DIAGRAM_TYPES.includes(value.type)) fail('자료 화면 종류를 확인해 주세요.');
  const title = visualText(value.title, 200, '자료 화면 제목'), subtitle = visualText(value.subtitle, 1000, '보조 설명');
  if (!title) fail('자료 화면 제목을 입력해 주세요.');
  for (const [key, maximum] of [['events', 12], ['nodes', 12], ['edges', 24], ['series', 12]]) if (!Array.isArray(value[key]) || value[key].length > maximum) fail('자료 화면의 항목 수를 줄여 주세요.');
  const events = value.events.map(event => {
    if (!plain(event)) fail('연표 항목을 확인해 주세요.');
    const label = visualText(event.label, 200, '사건 이름');if (!label) fail('사건 이름을 입력해 주세요.');
    return {date: visualText(event.date, 100, '연도·날짜'), label, detail: visualText(event.detail, 1000, '사건 설명')};
  });
  const seen = new Set();
  const nodes = value.nodes.map(node => {
    if (!plain(node)) fail('관계·지도 항목을 확인해 주세요.');
    const key = id(node.id, '대상');if (seen.has(key)) fail('대상 식별자가 중복돼요.');seen.add(key);
    const label = visualText(node.label, 200, '대상 이름');if (!label) fail('대상 이름을 입력해 주세요.');
    const x = node.x ?? .5, y = node.y ?? .5;
    if (![x, y].every(number => Number.isFinite(number) && number >= 0 && number <= 1)) fail('지도 위치는 0~100% 범위로 정해 주세요.');
    return {id: key, label, x, y};
  });
  const edges = value.edges.map(edge => {
    if (!plain(edge) || !seen.has(edge.from) || !seen.has(edge.to)) fail('관계선이 연결할 대상을 확인해 주세요.');
    return {from: edge.from, to: edge.to, label: visualText(edge.label, 200, '관계 설명')};
  });
  const series = value.series.map(entry => {
    if (!plain(entry) || !Number.isFinite(entry.value) || Math.abs(entry.value) > 1e15) fail('차트 값은 유한한 숫자로 입력해 주세요.');
    const label = visualText(entry.label, 200, '차트 항목');if (!label) fail('차트 항목 이름을 입력해 주세요.');
    return {label, value: entry.value, unit: visualText(entry.unit, 100, '차트 단위')};
  });
  if (value.type === 'timeline' && !events.length) fail('연표에는 사건이 한 개 이상 필요해요.');
  if (['relations', 'map'].includes(value.type) && !nodes.length) fail('관계도·지도에는 대상이 한 개 이상 필요해요.');
  if (value.type === 'chart' && !series.length) fail('차트에는 값이 한 개 이상 필요해요.');
  if (new Set(series.map(entry => entry.unit).filter(Boolean)).size > 1) fail('한 차트에서 비교할 값의 단위를 통일해 주세요.');
  return {id: value.id ? id(value.id, '자료 화면') : `diagram-${index + 1}`, type: value.type, title, subtitle, events, nodes, edges, series,
    notes: textList(value.notes || [], 12, 1000, '자료 화면 참고 사항')};
}
export function normalizeDiagramResult(value) {
  if (!plain(value) || !Array.isArray(value.cards) || !value.cards.length || value.cards.length > 4) fail('자료 화면은 한 번에 1~4개로 만들어 주세요.');
  const cards = value.cards.map(normalizeDiagramCard), seen = new Set(cards.map(card => card.id));
  if (seen.size !== cards.length) fail('자료 화면 식별자가 중복돼요.');
  return {title: visualText(value.title, 200, '자료 묶음 제목'), cards, notes: textList(value.notes || [], 12, 1000, '자료 묶음 참고 사항'),
    model: visualText(value.model, 100, '모델'), createdAt: visualText(value.createdAt, 40, '생성 시각', new Date().toISOString())};
}
export function diagramToEditable(card) {
  if (card.type === 'timeline') return card.events.map(event => `${event.date} | ${event.label} | ${event.detail}`).join('\n');
  if (card.type === 'chart') return card.series.map(entry => `${entry.label} | ${entry.value} | ${entry.unit}`).join('\n');
  return card.nodes.map(node => card.type === 'map' ? `${node.id} | ${node.label} | ${Math.round(node.x * 100)} | ${Math.round(node.y * 100)}` : `${node.id} | ${node.label}`).join('\n');
}
export function applyDiagramEdits(card, {title, subtitle, data, edges = ''}) {
  const next = {...card, title, subtitle, events: [], nodes: [], edges: [], series: []};
  const rows = String(data || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (rows.length > 12) fail('한 화면의 항목은 12개 이하로 줄여 주세요.');
  rows.forEach((line, index) => {
    const parts = line.split('|').map(part => part.trim());
    if (card.type === 'timeline') {if (parts.length !== 3) fail('연표는 날짜 | 사건 | 설명 형식으로 입력해 주세요.');next.events.push({date: parts[0], label: parts[1], detail: parts[2]});}
    else if (card.type === 'chart') {if (parts.length !== 3 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(parts[1])) fail('차트는 항목 | 숫자 | 단위 형식으로 입력해 주세요.');next.series.push({label: parts[0], value: Number(parts[1]), unit: parts[2]});}
    else {if (parts.length !== (card.type === 'map' ? 4 : 2)) fail(card.type === 'map' ? '지도는 id | 이름 | x% | y% 형식으로 입력해 주세요.' : '관계도는 id | 이름 형식으로 입력해 주세요.');const old = card.nodes.find(node => node.id === parts[0]);next.nodes.push({id: parts[0], label: parts[1], x: card.type === 'map' ? Number(parts[2]) / 100 : old?.x ?? .5, y: card.type === 'map' ? Number(parts[3]) / 100 : old?.y ?? .5});}
  });
  if (['relations', 'map'].includes(card.type)) {
    const lines = String(edges).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);if (lines.length > 24) fail('관계선은 24개 이하로 줄여 주세요.');
    next.edges = lines.map(line => {const parts = line.split('|').map(part => part.trim()), ends = parts[0]?.split('>').map(part => part.trim());if (parts.length !== 2 || ends?.length !== 2) fail('관계는 from > to | 설명 형식으로 입력해 주세요.');return {from: ends[0], to: ends[1], label: parts[1]};});
  }
  return normalizeDiagramCard(next);
}
