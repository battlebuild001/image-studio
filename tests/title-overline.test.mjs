import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {renderTitleDesign, selectTitleBackdrop, normalizeTitleOverline} from '../dist/title-design.js';
import {renderOutroDesign} from '../dist/outro-design.js';
import {normalizeChannelSettings, normalizeChannelPreset, captureChannelPreset, applyChannelPreset, renderChannelTitleCard} from '../dist/production-channels.js';
import {createProject, createScene, validateProject, exportProjectBackup, importProjectBackup} from '../dist/project.js';

// Record actual Canvas operations and font state. This tests visible drawing
// instructions; the companion browser suite checks raster pixels and real UI.
function canvas(width = 1280, height = 720) {
  const calls = [], stack = [], properties = ['font', 'fillStyle', 'strokeStyle', 'textAlign', 'textBaseline', 'globalAlpha', 'filter', 'lineWidth'];
  const ctx = {font: '10px sans-serif', fillStyle: '#000', globalAlpha: 1, filter: 'none',
    save() {stack.push(Object.fromEntries(properties.map(key => [key, this[key]])));},
    restore() {Object.assign(this, stack.pop());},
    setTransform() {}, clearRect() {}, scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect(x, y, w, h) {calls.push({kind: 'rect', x, y, w, h, color: this.fillStyle});},
    drawImage(image, ...args) {calls.push({kind: 'image', image, args});},
    fillText(text, x, y) {calls.push({kind: 'text', text, x, y, font: this.font});},
    measureText(text) {return {width: Array.from(String(text)).length * Number(/([\d.]+)px/u.exec(this.font)?.[1] || 10) * .55};},
    createLinearGradient() {return {addColorStop() {}};}, createRadialGradient() {return {addColorStop() {}};},
  };
  const result = {width, height, calls, getContext: () => ctx};ctx.canvas = result;return result;
}
const words = value => value.calls.filter(call => call.kind === 'text').map(call => call.text);
const shortAccent = value => value.calls.filter(call => call.kind === 'rect' && call.h === 2 && call.w === (value.height > value.width ? 32 : 28));
const bottomAccent = value => value.calls.filter(call => call.kind === 'rect' && call.h === 2 && call.w === (value.height > value.width ? 45 : 48));
const heading = '함께한 이야기';

test('legacy missing overlines keep the intro/chapter/outro defaults and their short accent line', () => {
  for (const [width, height] of [[1280, 720], [720, 1280]]) for (const [kind, label] of [['intro', 'PROLOGUE'], ['chapter', 'CHAPTER'], ['outro', 'EPILOGUE']]) {
    const value = canvas(width, height);renderTitleDesign(value, {kind, title: heading});
    assert.ok(words(value).includes(label));assert.equal(shortAccent(value).length, 1);assert.equal(bottomAccent(value).length, 1);
    assert.equal(normalizeTitleOverline(undefined, kind), label);
  }
  const legacy = normalizeChannelSettings({intro: {enabled: true}, outro: {enabled: true}});
  assert.equal(legacy.intro.overline, 'PROLOGUE');assert.equal(legacy.outro.overline, 'EPILOGUE');
  const raw = createProject({production: {version: 1, channel: {intro: {enabled: true}, outro: {enabled: true}}}});
  assert.equal(Object.hasOwn(validateProject(raw).production.channel.outro, 'overline'), false, 'raw legacy state remains optional');
});

test('explicit empty overlines hide both the label and its short line through every renderer without hiding the footer accent', () => {
  const paths = [
    value => renderTitleDesign(value, {kind: 'intro', title: heading, overline: ''}),
    value => renderTitleDesign(value, {kind: 'chapter', title: heading, overline: ''}),
    value => renderTitleDesign(value, {kind: 'outro', title: heading, overline: ''}),
    value => renderChannelTitleCard(value, {title: heading, overline: ''}),
    value => renderChannelTitleCard(value, {title: heading, outro: true, overline: ''}),
    value => renderOutroDesign(value, {title: heading, overline: ''}),
  ];
  for (const [width, height] of [[1280, 720], [720, 1280]]) for (const draw of paths) {
    const value = canvas(width, height);draw(value);
    assert.ok(words(value).includes(heading));assert.equal(words(value).some(word => ['PROLOGUE', 'CHAPTER', 'EPILOGUE'].includes(word)), false);
    assert.equal(shortAccent(value).length, 0);assert.equal(bottomAccent(value).length, 1);
  }
  assert.equal(normalizeTitleOverline('     ', 'outro'), '');
});

test('custom Korean overlines reach shared, channel and dedicated outro artwork as literal user text', () => {
  const overline = '마지막 장 · 우리들의 이야기', paths = [
    value => renderTitleDesign(value, {kind: 'intro', title: heading, overline}),
    value => renderTitleDesign(value, {kind: 'chapter', title: heading, overline}),
    value => renderTitleDesign(value, {kind: 'outro', title: heading, overline}),
    value => renderChannelTitleCard(value, {title: heading, overline}),
    value => renderChannelTitleCard(value, {title: heading, outro: true, overline}),
    value => renderOutroDesign(value, {title: heading, overline}),
  ];
  for (const draw of paths) {const value = canvas();draw(value);assert.ok(words(value).includes(overline));assert.equal(shortAccent(value).length, 1);assert.equal(words(value).some(word => ['PROLOGUE', 'CHAPTER', 'EPILOGUE'].includes(word)), false);}
  assert.equal(normalizeTitleOverline(`  ${overline}  `, 'outro'), overline);
});

test('overline metadata is bounded by Unicode code points while invalid types and control characters are rejected', () => {
  const eighty = '별'.repeat(80);assert.equal(normalizeTitleOverline(eighty, 'outro'), eighty);
  assert.equal(normalizeTitleOverline('🌟'.repeat(80), 'intro'), '🌟'.repeat(80));
  for (const invalid of ['가'.repeat(81), '🌟'.repeat(81), null, 42, {}, [], '끝\u0000문구', '끝\u0007문구']) {
    assert.throws(() => normalizeTitleOverline(invalid, 'outro'));
    assert.throws(() => renderTitleDesign(canvas(), {kind: 'outro', title: heading, overline: invalid}));
  }
  for (const overline of ['가'.repeat(81), 42, null, {}]) {
    assert.throws(() => normalizeChannelSettings({outro: {enabled: true, overline}}));
    assert.throws(() => validateProject(createProject({production: {version: 1, channel: {outro: {enabled: true, overline}}}})));
  }
  for (const [width, height] of [[1280, 720], [720, 1280]]) {
    const value = canvas(width, height);renderTitleDesign(value, {kind: 'outro', title: heading, overline: eighty});
    const labels = value.calls.filter(call => call.kind === 'text' && /^별/u.test(call.text));assert.ok(labels.length);
    for (const label of labels) {const fontSize = Number(/([\d.]+)px/u.exec(label.font)[1]);assert.ok(label.x + Array.from(label.text).length * fontSize * .55 <= (height > width ? 720 : 1280) + 1);}
  }
});

test('overline edits preserve first/last real image selection while skipping inserted title images', () => {
  const first = {width: 1600, height: 900}, last = {width: 1600, height: 900}, inserted = {width: 1280, height: 720};
  const assets = new Map([['intro', {image: inserted, name: '내 제목-intro.png'}], ['first', {image: first, name: '첫 장면.png'}], ['last', {image: last, name: '마지막 장면.png'}], ['outro', {image: inserted, name: '아웃트로-10초.png'}]]);
  const api = {getProject: () => ({scenes: ['intro', 'first', 'last', 'outro'].map(imageId => ({imageId}))}), getAssets: () => assets};
  assert.equal(selectTitleBackdrop(api, 'intro'), first);assert.equal(selectTitleBackdrop(api, 'outro'), last);
  for (const [kind, image] of [['intro', first], ['outro', last]]) {const value = canvas();renderTitleDesign(value, {kind, title: heading, overline: '함께한 여정', backgroundImage: selectTitleBackdrop(api, kind)});assert.equal(value.calls.find(call => call.kind === 'image').image, image);}
});

test('custom and deliberately hidden overlines survive normalized channel presets and real portable media backups', async () => {
  const bytes = await readFile(new URL('./fixtures/image-test-1.png', import.meta.url)), project = createProject({title: '원본 프로젝트', scenes: [createScene({id: 'original-scene', imageId: 'actual-image'})]});
  const channel = {name: '직접 정한 채널', intro: {enabled: true, title: '이야기의 시작', overline: '', duration: 4}, outro: {enabled: true, title: heading, overline: '다음 장에서 만나요', duration: 10}};
  const preset = captureChannelPreset(project, '한국어 문구 프리셋', channel), reloaded = normalizeChannelPreset(JSON.parse(JSON.stringify(preset)));
  assert.equal(reloaded.channel.intro.overline, '');assert.equal(reloaded.channel.outro.overline, channel.outro.overline);
  applyChannelPreset(project, reloaded);const before = validateProject(project), assets = new Map([['actual-image', {name: '기존 이미지.png', blob: new Blob([bytes], {type: 'image/png'})}]]);
  const restored = await importProjectBackup(await exportProjectBackup(project, assets));
  assert.deepEqual(restored.project, before);assert.equal(restored.project.production.channel.intro.overline, '');assert.equal(restored.project.production.channel.outro.overline, channel.outro.overline);assert.equal(restored.project.production.channel.outro.duration, 10);
  assert.deepEqual(new Uint8Array(await restored.assets.get('actual-image').blob.arrayBuffer()), new Uint8Array(bytes));
  const invalid = structuredClone(preset);invalid.channel.outro.overline = '가'.repeat(81);assert.throws(() => normalizeChannelPreset(invalid));
});
