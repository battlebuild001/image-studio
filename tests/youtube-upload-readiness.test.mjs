import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getYouTubeUploadReadiness} from '../dist/youtube-upload-readiness.js';

const ready = {connected: true, videoReady: true, exportState: 'ready'};

test('a connected channel and ready thumbnail cannot substitute for an actual video file', () => {
  const result = getYouTubeUploadReadiness({connected: true, videoReady: false});
  assert.equal(result.code, 'export-required');assert.equal(result.ready, false);assert.equal(result.action, 'video');
  assert.match(result.message, /실제 MP4·WebM 영상 파일/u);assert.match(result.message, /이미 저장한 파일/u);
  assert.doesNotMatch(result.message, /인증.*실패|액세스.*차단/u);
});

test('file selection, edited exports and another project have distinct recovery explanations', () => {
  for (const [input, code, text] of [
    [{videoSource: 'file', exportState: 'changed'}, 'file-required', /영상 파일을 선택/u],
    [{exportState: 'changed'}, 'export-changed', /다시 영상으로 만들/u],
    [{exportState: 'other-project'}, 'export-other-project', /다른 프로젝트/u],
  ]) {
    const result = getYouTubeUploadReadiness({connected: true, videoReady: false, ...input});
    assert.equal(result.code, code);assert.equal(result.ready, false);assert.equal(result.action, 'video');assert.match(result.message, text);
  }
  assert.equal(getYouTubeUploadReadiness({...ready, videoSource: 'file', exportState: 'other-project'}).ready, true);
});

test('in-progress work, uploaded-video thumbnails, reconnect and paused transfers take priority over creating another video', () => {
  assert.equal(getYouTubeUploadReadiness({...ready, busy: 'upload', canMutate: false, pendingThumbnail: true}).code, 'busy');
  assert.equal(getYouTubeUploadReadiness({...ready, canMutate: false, pendingThumbnail: true}).code, 'editor-busy');
  const thumbnail = getYouTubeUploadReadiness({...ready, pendingThumbnail: true, pausedUpload: true});
  assert.equal(thumbnail.code, 'thumbnail-pending');assert.equal(thumbnail.action, 'thumbnail');assert.match(thumbnail.message, /썸네일만 다시/u);
  assert.equal(getYouTubeUploadReadiness({...ready, connected: false, pendingThumbnail: true}).action, 'settings');
  const paused = getYouTubeUploadReadiness({connected: true, pausedUpload: true, exportState: 'other-project'});
  assert.equal(paused.code, 'upload-paused');assert.equal(paused.action, 'resume');assert.match(paused.message, /원래 프로젝트/u);
});

test('missing media is addressed before scheduling, then the exact local scheduling error is visible', () => {
  assert.equal(getYouTubeUploadReadiness({connected: true, scheduleValid: false}).code, 'export-required');
  const message = '선택한 예약 시각이 이미 지났어요.';
  const result = getYouTubeUploadReadiness({...ready, scheduleValid: false, scheduleError: message});
  assert.equal(result.code, 'schedule-invalid');assert.equal(result.action, 'schedule');assert.equal(result.message, message);
  assert.match(getYouTubeUploadReadiness({...ready, scheduleValid: false}).message, /날짜·시간과 시간대/u);
});

test('only complete unblocked preparations are marked ready across channel, file and transfer states', () => {
  for (const connected of [false, true]) for (const videoReady of [false, true])
    for (const pausedUpload of [false, true]) for (const pendingThumbnail of [false, true])
      for (const scheduleValid of [false, true]) {
        const input = Object.freeze({connected, videoReady, pausedUpload, pendingThumbnail, scheduleValid});
        const expected = connected && videoReady && !pausedUpload && !pendingThumbnail && scheduleValid;
        const result = getYouTubeUploadReadiness(input);
        assert.equal(result.ready, expected, JSON.stringify(input));
        assert.equal(result.code === 'ready', expected);if (expected) assert.equal(result.action, null);
      }
});

test('guidance is deterministic and readonly, with no project changes or transport calls', () => {
  const project = Object.freeze({id: 'retained-project', title: '보존할 제목'});
  let called = 0;
  const input = Object.freeze({...ready, project, getProject() {called++;return project;}, upload() {called++;}});
  const first = getYouTubeUploadReadiness(input), second = getYouTubeUploadReadiness(input);
  assert.deepEqual(first, second);assert.equal(called, 0);assert.equal(project.title, '보존할 제목');
});
