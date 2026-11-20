const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {promisify} = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

function narrationWave(seconds = 6) {
  const rate = 24000, frames = rate * seconds, bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length - 8, 4);bytes.write('WAVEfmt ', 8);bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);bytes.writeUInt16LE(1, 22);bytes.writeUInt32LE(rate, 24);bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);bytes.writeUInt16LE(16, 34);bytes.write('data', 36);bytes.writeUInt32LE(frames * 2, 40);
  for (let at = 0; at < frames; at++) {
    const time = at / rate, hz = time < seconds / 2 ? 440 : 880;
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * time) * .25 * 32767), 44 + at * 2);
  }
  return bytes;
}

async function storedProject(page) {
  return page.evaluate(async () => (await (await import('/project.js')).loadProject())?.project);
}

async function waitProject(page, predicate, label = 'durable project update') {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await storedProject(page);
    if (value && predicate(value)) return value;
    await page.waitForTimeout(25);
  }
  assert.fail('Expected ' + label);
}

async function mediaHashes(page) {
  return page.evaluate(async () => {
    const loaded = await (await import('/project.js')).loadProject();
    return Promise.all([...loaded.assets].sort(([a], [b]) => a.localeCompare(b)).map(async ([id, asset]) => ({
      id, type: asset.blob.type, size: asset.blob.size,
      hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', await asset.blob.arrayBuffer()))].join(','),
    })));
  });
}

function removeTone(samples, hz, rate = 24000) {
  const result = new Float32Array(samples), angle = 2 * Math.PI * hz / rate;
  let sine = 0, cosine = 0;
  for (let at = 0; at < result.length; at++) {sine += result[at] * Math.sin(at * angle);cosine += result[at] * Math.cos(at * angle);}
  sine *= 2 / result.length;cosine *= 2 / result.length;
  for (let at = 0; at < result.length; at++) result[at] -= sine * Math.sin(at * angle) + cosine * Math.cos(at * angle);
  return result;
}

function musicCorrelation(decoded, expectedMusic, start, hz) {
  const rate = 24000, length = Math.round(.8 * rate), first = Math.round(start * rate);
  const expected = removeTone(expectedMusic.slice(first, first + length), hz);
  let expectedPower = 0;for (const value of expected) expectedPower += value * value;
  assert.ok(Math.sqrt(expectedPower / length) > .0005, 'The actual generated BGM must be audible in this window');
  let best = -1, lag = 0;
  for (let offset = -6000; offset <= 6000; offset += 12) {
    const at = first + offset;if (at < 0 || at + length > decoded.length) continue;
    const actual = removeTone(decoded.slice(at, at + length), hz);
    let product = 0, power = 0;
    for (let index = 0; index < length; index += 4) {product += actual[index] * expected[index];power += actual[index] * actual[index];}
    let referencePower = 0;for (let index = 0; index < length; index += 4) referencePower += expected[index] ** 2;
    const correlation = product / Math.sqrt(power * referencePower);
    if (correlation > best) {best = correlation;lag = offset / rate;}
  }
  return {start, correlation: best, lagSeconds: lag};
}

/** Must only run while the caller owns the team's exclusive native export lease. */
async function verifyNativeExport(page, output = '/tmp/three-step-native.mp4') {
  const before = await storedProject(page);
  assert.ok(before.audio.narrationId && before.audio.bgmId && before.settings.subtitles);
  assert.ok(before.scenes.every(scene => scene.imageId && scene.caption));
  const expectedMusic = await page.evaluate(async () => {
    const {loadProject} = await import('/project.js'), engine = await import('/engine.js'), loaded = await loadProject();
    await engine.prepareAssets(loaded.assets);
    const asset = loaded.assets.get(loaded.project.audio.bgmId), window = engine.getAudioWindow(loaded.project, loaded.assets, 'bgm');
    const source = asset.audioBuffer.getChannelData(0), rate = 24000, seconds = engine.getDuration(loaded.project), music = new Float32Array(Math.round(rate * seconds));
    for (let at = 0; at < music.length; at++) {
      const time = at / rate, position = (window.start + time % window.duration) * asset.audioBuffer.sampleRate;
      const low = Math.floor(position), fraction = position - low;
      const sample = (source[low] || 0) * (1 - fraction) + (source[Math.min(low + 1, source.length - 1)] || 0) * fraction;
      music[at] = sample * engine.getAudioGain(loaded.project, loaded.assets, 'bgm', time);
    }
    let binary = '';const bytes = new Uint8Array(music.buffer);
    for (let from = 0; from < bytes.length; from += 16384) binary += String.fromCharCode(...bytes.subarray(from, from + 16384));
    return btoa(binary);
  });
  await page.locator('#exportFormat').selectOption('mp4');await page.locator('#exportResolution').selectOption('720');
  await page.waitForFunction(() => !document.querySelector('#startExportBtn').disabled);
  await page.locator('#startExportBtn').click();await page.locator('#exportComplete').waitFor({state: 'visible', timeout: 90000});
  const pending = page.waitForEvent('download');await page.locator('#downloadVideoLink').click();
  const download = await pending;await download.saveAs(output);assert.equal(await download.failure(), null);
  const probe = JSON.parse((await execFile('ffprobe', ['-v', 'error', '-show_streams', '-show_packets', '-of', 'json', output], {maxBuffer: 12 * 1024 * 1024})).stdout);
  const video = probe.streams.find(item => item.codec_type === 'video'), audio = probe.streams.find(item => item.codec_type === 'audio');
  assert.ok(video && audio);assert.equal(video.width, 1280);assert.equal(video.height, 720);
  const ends = probe.streams.map(stream => Math.max(...probe.packets.filter(packet => packet.stream_index === stream.index).map(packet => Number(packet.pts_time || 0) + Number(packet.duration_time || 0))));
  assert.ok(ends.every(end => end > 5.7 && end < 6.5), 'Both exported streams retain the six-second timeline: ' + JSON.stringify(ends));
  const frames = await page.evaluate(async () => {
    const {loadProject} = await import('/project.js'), engine = await import('/engine.js'), loaded = await loadProject();await engine.prepareAssets(loaded.assets);
    const media = document.createElement('video');media.muted = true;media.src = document.querySelector('#downloadVideoLink').href;document.body.append(media);
    await new Promise((resolve, reject) => {media.onloadedmetadata = resolve;media.onerror = reject;});
    const actual = document.createElement('canvas'), expected = document.createElement('canvas');actual.width = expected.width = 1280;actual.height = expected.height = 720;
    const a = actual.getContext('2d', {willReadFrequently: true}), b = expected.getContext('2d', {willReadFrequently: true}), targets = [1.2, 4.2], results = [];
    const difference = (x, y) => {let sum = 0, count = 0;for (let row = 440; row < 715; row += 2) for (let column = 40; column < 1240; column += 2) {const index = (row * 1280 + column) * 4;for (let c = 0; c < 3; c++) sum += Math.abs(x[index + c] - y[index + c]);count += 3;}return sum / count;};
    await media.play();await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Decoded three-step video playback timed out')), 18000);
      media.onended = () => {clearTimeout(timer);resolve();};media.onerror = () => {clearTimeout(timer);reject(new Error('Decoded video playback failed'));};
      const next = (_now, metadata) => {
        if (results.length < targets.length && metadata.mediaTime >= targets[results.length]) {
          a.drawImage(media, 0, 0, 1280, 720);const pixels = a.getImageData(0, 0, 1280, 720).data;
          engine.renderFrame(b, loaded.project, loaded.assets, metadata.mediaTime);const withCaptions = b.getImageData(0, 0, 1280, 720).data;
          engine.renderFrame(b, {...loaded.project, settings: {...loaded.project.settings, subtitles: false}}, loaded.assets, metadata.mediaTime);const withoutCaptions = b.getImageData(0, 0, 1280, 720).data;
          results.push({at: metadata.mediaTime, captionError: difference(pixels, withCaptions), missingCaptionError: difference(pixels, withoutCaptions)});
        }
        if (!media.ended) media.requestVideoFrameCallback(next);
      };media.requestVideoFrameCallback(next);
    });media.remove();return results;
  });
  assert.equal(frames.length, 2);
  for (const frame of frames) {assert.ok(frame.captionError < 12, JSON.stringify(frame));assert.ok(frame.captionError + .5 < frame.missingCaptionError, 'Decoded frames must contain actual burned-in captions: ' + JSON.stringify(frame));}
  const bytes = (await execFile('ffmpeg', ['-v', 'error', '-i', output, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '24000', 'pipe:1'], {encoding: null, maxBuffer: 8 * 1024 * 1024})).stdout;
  const decoded = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), musicBytes = Buffer.from(expectedMusic, 'base64');
  const music = new Float32Array(musicBytes.buffer.slice(musicBytes.byteOffset, musicBytes.byteOffset + musicBytes.byteLength));
  const musicChecks = [musicCorrelation(decoded, music, 1.2, 440), musicCorrelation(decoded, music, 4.1, 880)];
  assert.ok(musicChecks.every(item => item.correlation > .7), 'Decoded music must match the generated BGM after removing the narration tone: ' + JSON.stringify(musicChecks));
  const tone = (start, hz) => {const slice = decoded.slice(Math.round(start * 24000), Math.round((start + .8) * 24000));let re = 0, im = 0;for (let at = 0; at < slice.length; at++) {re += slice[at] * Math.cos(2 * Math.PI * hz * at / 24000);im += slice[at] * Math.sin(2 * Math.PI * hz * at / 24000);}return (re * re + im * im) / slice.length ** 2;};
  assert.ok(tone(1.2, 440) > .005 && tone(1.2, 440) > tone(1.2, 880) * 30);
  assert.ok(tone(4.1, 880) > .005 && tone(4.1, 880) > tone(4.1, 440) * 30);
  assert.deepEqual(await storedProject(page), before, 'Encoding must not alter the source project or generated media');
  const result = {file: output, ends, width: video.width, height: video.height, frames, musicChecks};
  await fs.writeFile('/tmp/three-step-native-result.json', JSON.stringify(result, null, 2) + '\n');return result;
}

module.exports = {narrationWave, storedProject, waitProject, mediaHashes, verifyNativeExport};
