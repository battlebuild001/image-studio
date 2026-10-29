import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {test} from 'node:test';
import {createScriptApi} from '../scripts/script-api.mjs';
import {createVoiceApi} from '../scripts/voice-api.mjs';

const scriptInput = {sourceText: '제공된 자료의 핵심을 확인해 한국어 영상 대본으로 정리합니다.',
  targetMinutes: 8, charsPerMinute: 330, instructions: '출처와 대본을 분리합니다.', projectTitle: '독립된 제작 단계'};
const narration = '대본을 먼저 작성하고 확인합니다. 완성한 대본으로 음성을 생성한 뒤 영상 편집을 시작합니다.';
// Synthetic provider evidence exercises the real script API validator, not a live search.
const researched = () => ({status: 'completed', output: [
  {type: 'web_search_call', status: 'completed', action: {type: 'search', sources: [
    {type: 'url', title: '테스트 참고 문서', url: 'https://example.com/workflow-reference'},
  ]}},
  {type: 'message', content: [{type: 'output_text', text: JSON.stringify({title: '독립된 제작 단계',
    summary: '대본과 음성의 인증을 분리한 테스트 결과입니다.', script: narration, notes: []}), annotations: [
      {type: 'url_citation', title: '테스트 참고 문서', url: 'https://example.com/workflow-reference'},
    ]}]},
]});

function audioBytes() {
  const bytes = Buffer.alloc(364);bytes.write('RIFF', 0);bytes.writeUInt32LE(bytes.length - 8, 4);bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);bytes.writeUInt16LE(1, 20);bytes.writeUInt16LE(1, 22);bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);bytes.writeUInt16LE(2, 32);bytes.writeUInt16LE(16, 34);bytes.write('data', 36);bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let index = 44; index < bytes.length; index += 2) bytes.writeInt16LE(Math.round(Math.sin(index / 2) * 3000), index);
  return bytes;
}

async function workflowServer(t, {env, researchProvider, voiceProvider}) {
  const script = createScriptApi({env, requestProvider: researchProvider});
  const voice = createVoiceApi({env, requestProvider: voiceProvider});
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    try {
      if (await script(req, res, path)) return;
      if (await voice(req, res, path)) return;
      res.writeHead(404).end();
    } catch {if (!res.headersSent) res.writeHead(500);res.end();}
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  t.after(async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));});
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async path => {const response = await fetch(base + path);assert.equal(response.status, 200);return response.json();},
    post: (path, body) => fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
  };
}

test('script research succeeds before any voice API is configured and survives an unavailable voice step', async t => {
  let researchCalls = 0, voiceCalls = 0;
  const api = await workflowServer(t, {env: {SCRIPT_AI_API_KEY: 'synthetic-research-key'},
    researchProvider: async ({key, payload}) => {
      researchCalls++;assert.equal(key, 'synthetic-research-key');assert.equal(payload.tools[0].type, 'web_search');return researched();
    },
    voiceProvider: async () => {voiceCalls++;throw new Error('Voice must not be requested without credentials');},
  });
  assert.equal((await api.get('/api/script/config')).configured, true);
  assert.equal((await api.get('/api/voice/config')).configured, false);
  const first = await api.post('/api/script/generate', scriptInput);assert.equal(first.status, 200);
  const draft = await first.json();assert.equal(draft.script, narration);assert.equal(draft.webSearchUsed, true);
  assert.deepEqual(draft.sources.map(source => source.url), ['https://example.com/workflow-reference']);
  assert.equal(researchCalls, 1);assert.equal(voiceCalls, 0);
  const unavailable = await api.post('/api/voice/generate', {text: draft.script});assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, 'VOICE_NOT_CONFIGURED');assert.equal(voiceCalls, 0);
  const second = await api.post('/api/script/generate', scriptInput);assert.equal(second.status, 200);
  assert.equal((await second.json()).script, draft.script);assert.equal(researchCalls, 2);assert.equal(voiceCalls, 0);
});

test('a prepared manual script can become voice with only CLOVA credentials and no research key', async t => {
  let researchCalls = 0, voiceCalls = 0;const wav = audioBytes();
  const api = await workflowServer(t, {env: {CLOVA_VOICE_CLIENT_ID: 'synthetic-clova-id', CLOVA_VOICE_CLIENT_SECRET: 'synthetic-clova-secret'},
    researchProvider: async () => {researchCalls++;throw new Error('Research must not be called without its key');},
    voiceProvider: async ({clientId, clientSecret, payload}) => {
      voiceCalls++;assert.equal(clientId, 'synthetic-clova-id');assert.equal(clientSecret, 'synthetic-clova-secret');
      assert.equal(new URLSearchParams(payload.body.toString()).get('text'), narration);return {bytes: wav, contentType: 'audio/wav'};
    },
  });
  assert.equal((await api.get('/api/script/config')).configured, false);
  assert.equal((await api.get('/api/voice/config')).configured, true);
  const missingResearch = await api.post('/api/script/generate', scriptInput);assert.equal(missingResearch.status, 503);
  assert.equal((await missingResearch.json()).code, 'NOT_CONFIGURED');assert.equal(researchCalls, 0);
  const response = await api.post('/api/voice/generate', {text: narration});assert.equal(response.status, 200);
  const text = await response.text(), result = JSON.parse(text);
  assert.equal(result.provider, 'clova');assert.equal(result.chunks.length, 1);
  assert.ok(Buffer.from(result.chunks[0].audio, 'base64').equals(wav));assert.equal(result.chunks[0].mimeType, 'audio/wav');
  assert.ok(!text.includes('synthetic-clova-id'));assert.ok(!text.includes('synthetic-clova-secret'));
  assert.equal(researchCalls, 0);assert.equal(voiceCalls, 1);
  assert.equal((await api.get('/api/script/config')).configured, false);
});
