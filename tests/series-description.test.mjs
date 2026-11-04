import assert from 'node:assert/strict';
import {test} from 'node:test';
import {partDescription} from '../dist/upload-series.js';
import {createProject, createScene, getCaptions, validateProject} from '../dist/project.js';
import {normalizeUploadSeriesState} from '../dist/short-series-protocol.js';

const utf8 = value => new TextEncoder().encode(value).byteLength;
const part = (start, end) => ({start, end});
function story(extra = {}) {
  return createProject({title: '세 구간으로 나눈 개척의 역사', scenes: [
    createScene({id: 'departure', duration: 10, caption: '탐사대는 지구를 떠났습니다.'}),
    createScene({id: 'voyage', duration: 10, caption: '항해 중 탐사대는 새로운 신호를 발견했습니다.'}),
    createScene({id: 'arrival', duration: 10, caption: '마침내 탐사대는 행성에 도착했습니다.'}),
  ], ...extra});
}

test('new series descriptions use the actual automatically timed scene facts without title, episode or production headers', () => {
  const project = story({scriptDraft: {draftScript: '다른 구간의 경제와 도시 건설도 이어집니다.'}}), before = structuredClone(project);
  const selected = partDescription(project, part(10, 20));
  assert.equal(selected, '항해 중 탐사대는 새로운 신호를 발견했습니다.');
  assert.equal(selected.includes(project.title), false);assert.equal(/제\d+화|총 \d+화|원본 구간|00:|제작:|https?:\/\//u.test(selected), false);
  assert.equal(selected.includes('지구를 떠났습니다'), false);assert.equal(selected.includes('행성에 도착'), false);assert.equal(selected.includes('경제와 도시'), false);
  assert.deepEqual(project, before, 'preparing a new description does not rewrite existing project content');
});

test('SRT episode descriptions obey exact overlap boundaries and retain full overlapping facts instead of guessing word times', () => {
  const project = story({captionMode: 'srt', captions: [
    {start: 0, end: 10, text: '첫 번째 기록은 지구 출발입니다.'},
    {start: 10, end: 20, text: '두 번째 기록은 신호 발견입니다.'},
    {start: 20, end: 30, text: '마지막 기록은 행성 도착입니다.'},
  ]});
  assert.equal(partDescription(project, part(10, 20)), '두 번째 기록은 신호 발견입니다.');
  assert.equal(partDescription(project, part(20, 30)), '마지막 기록은 행성 도착입니다.');
  const crossing = partDescription(project, part(9.5, 10.5));
  assert.match(crossing, /첫 번째 기록은 지구 출발입니다\./u);assert.match(crossing, /두 번째 기록은 신호 발견입니다\./u);assert.equal(crossing.includes('마지막 기록'), false);
});

test('speech descriptions follow real source trims and narration offset rather than unshifted recognition timestamps', () => {
  const project = validateProject(story({captionMode: 'speech', captions: [
    {start: 11, end: 12.5, text: '처음 확인한 발화입니다.'},
    {start: 14.25, end: 16.75, text: '신호를 발견한 발화입니다.'},
    {start: 18.5, end: 20, text: '마지막으로 도착한 발화입니다.'},
  ], captionAnalysis: {narrationId: 'actual-voice', sourceStart: 10, sourceEnd: 22, language: 'ko', model: 'whisper-1', granularity: 'word', createdAt: '2026-11-04T10:00:00.000Z'},
  audio: {narrationId: 'actual-voice', narrationStart: 10, narrationEnd: 18, narrationOffset: 3}}));
  assert.deepEqual(getCaptions(project), [
    {start: 4, end: 5.5, text: '처음 확인한 발화입니다.'},
    {start: 7.25, end: 9.75, text: '신호를 발견한 발화입니다.'},
  ]);
  assert.equal(partDescription(project, part(7.25, 9.75)), '신호를 발견한 발화입니다.');
  assert.equal(partDescription(project, part(4, 5.5)), '처음 확인한 발화입니다.');
  assert.equal(partDescription(project, part(0, 30)).includes('마지막으로 도착한 발화'), false, 'trimmed-out narration cannot become a description fact');
});

test('missing timed cues fall back only to actual overlapping scene captions', () => {
  const project = story({captionMode: 'srt', captions: [], scriptDraft: {draftScript: '전체 대본의 경제 이야기와 도시 이야기입니다.'}});
  assert.deepEqual(getCaptions(project), []);
  assert.equal(partDescription(project, part(10, 20)), '항해 중 탐사대는 새로운 신호를 발견했습니다.');
  assert.equal(partDescription(project, part(20, 30)), '마침내 탐사대는 행성에 도착했습니다.');
  assert.equal(partDescription(project, part(10, 20)).includes('도시 이야기'), false);
});

test('an untimed whole-project draft is used only for an episode that covers the full timeline', () => {
  const draft = '지구를 떠난 탐사대는 오랜 항해 끝에 행성에 도착했습니다.';
  const project = createProject({title: '전체 항해', scenes: [createScene({duration: 15, caption: ''}), createScene({duration: 15, caption: ''})], captionMode: 'srt', captions: [], scriptDraft: {draftScript: draft, displayScript: draft}});
  assert.equal(partDescription(project, part(0, 30)), draft);
  assert.equal(partDescription(project, part(0, 15)), '', 'without timed facts no half-script alignment is invented');
  assert.equal(partDescription(project, part(15, 30)), '');
});

test('long episode narration becomes a bounded extractive summary of complete source sentences in their original order', () => {
  const sentences = [
    '탐사대는 지구에서 항해를 시작했습니다.',
    '승무원들은 새로운 별의 위치를 확인했습니다.',
    '첫 보급선이 출발 지점에 도착했습니다.',
    '탐사대는 항로에서 비정상적인 신호를 발견했습니다.',
    '과학자들은 신호의 방향을 다시 계산했습니다.',
    '선장은 안전한 항로를 선택했습니다.',
    '함대는 관측 기지와 통신을 재개했습니다.',
    '착륙선은 새로운 행성의 표면을 촬영했습니다.',
    '승무원들은 거주지를 지을 위치를 정했습니다.',
    '마침내 탐사대는 행성에 도착했습니다.',
  ];
  const project = story({captionMode: 'srt', captions: [{start: 0, end: 30, text: sentences.join(' ')}]});
  const description = partDescription(project, part(0, 30)), selected = sentences.filter(sentence => description.includes(sentence));
  assert.ok(selected.length >= 3 && selected.length <= 4, 'a long transcript is summarized rather than copied in full');
  assert.equal(selected[0], sentences[0]);assert.equal(selected.at(-1), sentences.at(-1));
  let previous = -1;
  for (const sentence of selected) {const position = description.indexOf(sentence);assert.ok(position > previous);previous = position;}
  let remainder = description;for (const sentence of selected) remainder = remainder.replace(sentence, '');
  assert.equal(remainder.trim(), '', 'summary uses complete actual source sentences without invented transitions or cut words');
});

test('new descriptions preserve every source character at 5000 UTF-8 bytes and reject oversized text without ellipsis truncation', () => {
  for (const text of ['A'.repeat(5000), '별'.repeat(1666) + 'AA', '🌌'.repeat(1250)]) {
    assert.equal(utf8(text), 5000);
    const project = createProject({title: '긴 원본 기록', scenes: [createScene({duration: 10, caption: ''})], captionMode: 'srt', captions: [{start: 0, end: 10, text}]});
    const description = partDescription(project, part(0, 10));assert.equal(description, text);assert.equal(utf8(description), 5000);
    project.captions[0].text = text + 'A';assert.throws(() => partDescription(project, part(0, 10)), /5,?000|5000|바이트|길이/u);
  }
});

test('generating defaults never cleans or rewrites an existing manually edited queue description', () => {
  const manual = '사용자가 직접 정한 제목\n\n원본 구간 00:00–00:10\n참고 링크: https://example.com/my-note\n이 문장은 수동으로 남겨 둡니다.';
  const queue = normalizeUploadSeriesState({version: 1, sourceKey: 'existing-manual-source', baseTitle: '기존 시리즈', targetSeconds: 60, createdAt: '2026-11-04T10:00:00.000Z', updatedAt: '2026-11-04T10:00:00.000Z', privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: true,
    episodes: [{id: 'existing-first', start: 0, end: 30, title: '사용자가 정한 회차 제목', description: manual, status: 'ready'}]});
  const project = story({production: {version: 1, uploadSeries: queue}}), before = structuredClone(project);
  assert.equal(partDescription(project, part(10, 20)), '항해 중 탐사대는 새로운 신호를 발견했습니다.');
  assert.deepEqual(project, before);assert.equal(normalizeUploadSeriesState(project.production.uploadSeries).episodes[0].description, manual);
});
