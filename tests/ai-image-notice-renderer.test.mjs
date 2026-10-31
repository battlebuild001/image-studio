import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject, createScene} from '../dist/project.js';
import {AI_IMAGE_NOTICE_TEXT, renderFrame} from '../dist/engine.js';

function context(width, height) {
  const trace = [], stack = [];
  const ctx = {canvas: {width, height}, trace, font: '10px sans-serif', fillStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() {stack.push(Object.fromEntries(['font', 'fillStyle', 'globalAlpha', 'globalCompositeOperation', 'textAlign', 'textBaseline', 'shadowBlur', 'shadowOffsetY'].map(key => [key, this[key]])));trace.push(['save']);},
    restore() {Object.assign(this, stack.pop());trace.push(['restore']);},
    setTransform(...value) {trace.push(['transform', ...value]);}, clearRect(...value) {trace.push(['clear', ...value]);},
    fillRect(...value) {trace.push(['fillRect', ...value]);},
    beginPath() {trace.push(['begin']);}, rect(...value) {trace.push(['rect', ...value]);}, clip() {trace.push(['clip']);},
    moveTo(...value) {trace.push(['moveTo', ...value]);}, arcTo(...value) {trace.push(['arcTo', ...value]);}, closePath() {trace.push(['close']);},
    fill() {trace.push(['fill', this.fillStyle]);}, drawImage(...value) {trace.push(['image', ...value]);},
    createLinearGradient() {return {addColorStop() {}};},
    measureText(text) {const size = Number(/([\d.]+)px/u.exec(this.font)?.[1] || 10);return {width: Array.from(text).reduce((sum, value) => sum + (/\s/u.test(value) ? .32 : /[A-Za-z.]/u.test(value) ? .55 : 1), 0) * size};},
    fillText(text, x, y) {trace.push(['text', {text, x, y, width: this.measureText(text).width, fontSize: Number(/([\d.]+)px/u.exec(this.font)[1]), font: this.font, fillStyle: this.fillStyle, alpha: this.globalAlpha, textAlign: this.textAlign}]);},
    strokeText(text, x, y) {trace.push(['strokeText', text, x, y]);},
  };
  return ctx;
}

function fixture() {
  const project = createProject({scenes: [createScene({imageId: 'image', duration: 4, motion: 'none', caption: '보통 크기의 나레이션 자막입니다.'})], settings: {branding: false, subtitles: false, transition: 0}});
  const assets = new Map([['image', {image: {width: 1280, height: 720}}]]);
  return {project, assets};
}
const draw = (project, assets, width = 1280, height = 720) => {const ctx = context(width, height);renderFrame(ctx, project, assets, 1);return ctx;};
const text = ctx => ctx.trace.filter(row => row[0] === 'text').map(row => row[1]);

test('notice absence and explicit false leave the legacy frame drawing exactly unchanged', () => {
  const {project, assets} = fixture();delete project.settings.aiImageNotice;
  const legacy = draw(project, assets).trace;project.settings.aiImageNotice = false;
  assert.deepEqual(draw(project, assets).trace, legacy);
  project.settings.aiImageNotice = true;assert.notDeepEqual(draw(project, assets).trace, legacy);
  project.settings.aiImageNotice = false;assert.deepEqual(draw(project, assets).trace, legacy, 'in-place toggling cannot cache a stale notice');
  project.settings.aiImageNoticePosition = 'bottom-left';assert.deepEqual(draw(project, assets).trace, legacy, 'a stored position cannot enable a disabled notice');
});

test('missing and explicit center positions keep the existing notice drawing unchanged', () => {
  const {project, assets} = fixture();project.settings.aiImageNotice = true;
  delete project.settings.aiImageNoticePosition;
  const legacy = draw(project, assets).trace;
  project.settings.aiImageNoticePosition = 'bottom-center';assert.deepEqual(draw(project, assets).trace, legacy);
  project.settings.aiImageNoticePosition = 'bottom-left';assert.notDeepEqual(draw(project, assets).trace, legacy);
  project.settings.aiImageNoticePosition = 'bottom-center';assert.deepEqual(draw(project, assets).trace, legacy);
});

test('left-bottom notice aligns text to the safe left inset without changing wrap or vertical caption space', () => {
  const {project, assets} = fixture();project.settings.aiImageNotice = true;
  for (const [width, height] of [[1280, 720], [1920, 1080], [720, 1280], [1080, 1920]]) {
    project.settings.aiImageNoticePosition = 'bottom-center';const centered = text(draw(project, assets, width, height));
    project.settings.aiImageNoticePosition = 'bottom-left';const left = text(draw(project, assets, width, height));
    const min = Math.min(width, height), expectedX = min * .02 + 14 * min / 1080;
    assert.equal(left.map(line => line.text).join(' '), AI_IMAGE_NOTICE_TEXT);
    assert.deepEqual(left.map(({text, y, fontSize, width}) => ({text, y, fontSize, width})), centered.map(({text, y, fontSize, width}) => ({text, y, fontSize, width})));
    assert.ok(left.every(line => line.textAlign === 'left' && Math.abs(line.x - expectedX) < .001));
    assert.ok(left.every(line => line.x >= min * .02 && line.x + line.width <= width * .96));
    assert.ok(left.every(line => line.y - line.fontSize / 2 > height * .85 && line.y + line.fontSize / 2 < height - min * .01));
    assert.ok(left[0].x < centered[0].x, 'left mode moves the real text anchor instead of only moving a panel');
  }
});

test('the exact notice is drawn after the image with subtitles and branding disabled', () => {
  const {project, assets} = fixture();project.settings.aiImageNotice = true;
  const ctx = draw(project, assets), lines = text(ctx);
  assert.equal(lines.map(line => line.text).join(' '), AI_IMAGE_NOTICE_TEXT);
  assert.equal(AI_IMAGE_NOTICE_TEXT, '해당 이미지는 이해를 돕기위한 ai 생성 이미지입니다. 본 원작과는 관련이 없습니다.');
  assert.ok(ctx.trace.findIndex(row => row[0] === 'image') < ctx.trace.findIndex(row => row[0] === 'text'));
  assert.ok(ctx.trace.some(row => row[0] === 'fill' && row[1] === 'rgba(0,0,0,0.68)'));
  assert.ok(lines.every(line => line.fillStyle === '#ffffff' && line.alpha === 1));
  assert.equal(ctx.globalAlpha, 1);assert.equal(ctx.globalCompositeOperation, 'source-over');
});

test('footer wraps responsively instead of clipping or shrinking portrait text below landscape size', () => {
  const {project, assets} = fixture();project.settings.aiImageNotice = true;
  for (const [width, height] of [[1280, 720], [1920, 1080], [720, 1280], [1080, 1920]]) {
    const lines = text(draw(project, assets, width, height)), min = Math.min(width, height);
    assert.equal(lines.map(line => line.text).join(' '), AI_IMAGE_NOTICE_TEXT);
    assert.ok(lines.every(line => Math.abs(line.x - width / 2) < .001));
    assert.ok(lines.every(line => line.x - line.width / 2 >= width * .04 && line.x + line.width / 2 <= width * .96));
    assert.ok(lines.every(line => line.y - line.fontSize / 2 > height * .85 && line.y + line.fontSize / 2 < height - min * .01));
    assert.ok(lines.every(line => Math.abs(line.fontSize - (width < height ? 30 : 22) * min / 1080) < .001));
    assert.equal(lines.length >= 2, width < height);
  }
});

test('all supported caption positions remain above both notice positions without changing the exact text', () => {
  const {project, assets} = fixture();project.settings.aiImageNotice = true;project.settings.subtitles = true;
  for (const [width, height] of [[1280, 720], [720, 1280]]) for (const captionPosition of ['top', 'center', 'bottom']) for (const fontSize of [20, 48, 100]) for (const aiImageNoticePosition of ['bottom-center', 'bottom-left']) {
    Object.assign(project.settings, {captionPosition, fontSize, captionStrokeWidth: 2, aiImageNoticePosition});
    const ctx = draw(project, assets, width, height), lines = text(ctx);
    const footerIndex = lines.findIndex(line => line.font.startsWith('500 '));
    assert.ok(footerIndex > 0);
    const captions = lines.slice(0, footerIndex), footer = lines.slice(footerIndex);
    const captionBottom = Math.max(...captions.map(line => line.y + line.fontSize / 2));
    assert.ok(captionBottom < footer[0].y - footer[0].fontSize / 2, `${width}×${height} ${captionPosition} ${fontSize}`);
    assert.equal(footer.map(line => line.text).join(' '), AI_IMAGE_NOTICE_TEXT);
    assert.ok(ctx.trace.some(row => row[0] === 'rect' && row[3] === width && row[4] < footer[0].y), 'caption clip reserves footer space even for oversized imported cues');
  }
});
