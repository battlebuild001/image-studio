import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject, createScene} from '../dist/project.js';
import {AI_IMAGE_NOTICE_TEXT, renderFrame} from '../dist/engine.js';

function context(width, height) {
  const trace = [], stack = [];
  const properties = ['font', 'fillStyle', 'globalAlpha', 'globalCompositeOperation', 'textAlign', 'textBaseline', 'shadowBlur', 'shadowOffsetY'];
  const ctx = {canvas: {width, height}, trace, font: '10px sans-serif', fillStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over',
    save() {stack.push(Object.fromEntries(properties.map(key => [key, this[key]])));trace.push(['save']);},
    restore() {Object.assign(this, stack.pop());trace.push(['restore']);},
    setTransform(...args) {trace.push(['transform', ...args]);},clearRect(...args) {trace.push(['clear', ...args]);},
    fillRect(...args) {trace.push(['fillRect', ...args, typeof this.fillStyle === 'string' ? this.fillStyle : 'gradient']);},
    beginPath() {trace.push(['begin']);},rect(...args) {trace.push(['rect', ...args]);},clip() {trace.push(['clip']);},
    moveTo(...args) {trace.push(['moveTo', ...args]);},arcTo(...args) {trace.push(['arcTo', ...args]);},closePath() {trace.push(['close']);},
    fill() {trace.push(['fill', this.fillStyle]);},drawImage(...args) {trace.push(['image', ...args]);},
    createLinearGradient(...args) {const stops = [];trace.push(['gradient', ...args, stops]);return {addColorStop(...stop) {stops.push(stop);}};},
    measureText(value) {const size = Number(/([\d.]+)px/u.exec(this.font)?.[1] || 10);return {width: Array.from(value).length * size * .9};},
    fillText(text, x, y) {trace.push(['text', {text, x, y, font: this.font}]);},strokeText(...args) {trace.push(['strokeText', ...args]);},
  };
  return ctx;
}
function fixture() {
  return {project: createProject({title: '직접 정한 영상 제목',
    scenes: [createScene({imageId: 'image', caption: '청자가 들을 나레이션 자막입니다.', duration: 4, motion: 'none'})],
    settings: {branding: true, subtitles: false, transition: 0, aiImageNotice: false}}),
    assets: new Map([['image', {image: {width: 1280, height: 720}}]])};
}
function draw(project, assets, width = 1280, height = 720) {const ctx = context(width, height);renderFrame(ctx, project, assets, 1);return ctx.trace;}
const texts = trace => trace.filter(entry => entry[0] === 'text').map(entry => entry[1]);

test('legacy branding:true draws only the user project title without a hardcoded channel row', () => {
  const {project, assets} = fixture(), before = structuredClone(project);
  for (const [width, height] of [[1280, 720], [720, 1280]]) {
    const rendered = texts(draw(project, assets, width, height));
    assert.equal(rendered.length, 1);assert.equal(rendered[0].text, project.title);
    assert.equal(rendered.some(entry => /BATTLE TABLE HOBBY|배틀테이블하비|\bBTH\b/iu.test(entry.text)), false);
    assert.equal(rendered[0].y, height * .055 + 13 * Math.min(width, height) / 1080, 'no empty channel-name line precedes the user title');
  }
  assert.deepEqual(project, before, 'rendering never rewrites user content or the legacy settings flag');
});

test('hiding the title or using an empty title draws neither a fixed mark nor leftover title shading', () => {
  const {project, assets} = fixture();project.settings.branding = false;
  const hidden = draw(project, assets);assert.deepEqual(texts(hidden), []);
  project.settings.branding = true;
  for (const title of ['', '   ', '\n\t']) {project.title = title;assert.deepEqual(draw(project, assets), hidden);}
});

test('visible project titles remain user-supplied text rather than a replacement channel name', () => {
  const {project, assets} = fixture();project.title = '  다른 채널에 사용할 새 이야기  ';
  assert.deepEqual(texts(draw(project, assets)).map(entry => entry.text), [project.title.trim()]);
  assert.equal(project.title, '  다른 채널에 사용할 새 이야기  ');
  project.settings.branding = false;assert.deepEqual(texts(draw(project, assets)), []);
});

test('title removal preserves narration captions and every AI-image footer position independently', () => {
  const {project, assets} = fixture();project.settings.subtitles = true;project.settings.aiImageNotice = true;
  for (const branding of [false, true]) for (const aiImageNoticePosition of ['bottom-center', 'bottom-left', 'bottom-right']) {
    Object.assign(project.settings, {branding, aiImageNoticePosition});
    const rendered = texts(draw(project, assets));
    assert.equal(rendered.some(entry => entry.text === project.title), branding);
    assert.ok(rendered.some(entry => entry.text === project.scenes[0].caption));
    const footer = rendered.filter(entry => entry.text.length > 0 && AI_IMAGE_NOTICE_TEXT.includes(entry.text));
    assert.equal(footer.map(entry => entry.text).join(' '), AI_IMAGE_NOTICE_TEXT);
    assert.equal(rendered.some(entry => /BATTLE TABLE HOBBY|배틀테이블하비|\bBTH\b/iu.test(entry.text)), false);
  }
});
