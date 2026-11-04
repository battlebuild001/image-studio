import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter,once} from 'node:events';
import {test} from 'node:test';
import {createTypecastApi,createTypecastProviderRequest,TypecastApiError} from '../scripts/typecast-api.mjs';
import {createVoiceApi} from '../scripts/voice-api.mjs';
import {TYPECAST_MAX_AUDIO_BYTES,TYPECAST_MAX_CHUNK_AUDIO_BYTES} from '../dist/typecast-protocol.js';

const KEY='fixture-server-typecast-key-never-public',VOICE='tc_6045d56d5f9ae03ac175cf73';
const voices=[{voice_id:VOICE,voice_name:{kor:'검증용 목소리',eng:'Fixture Voice'},models:[{version:'ssfm-v31',emotions:['normal','happy','sad','angry','whisper','toneup','tonedown']}],age:'young_adult',gender:'female',use_cases:[],voice_type:'original',preview_url:null}];
function wav(frames=240){const value=Buffer.alloc(44+frames*2);value.write('RIFF');value.writeUInt32LE(value.length-8,4);value.write('WAVEfmt ',8);value.writeUInt32LE(16,16);value.writeUInt16LE(1,20);value.writeUInt16LE(1,22);value.writeUInt32LE(24000,24);value.writeUInt32LE(48000,28);value.writeUInt16LE(2,32);value.writeUInt16LE(16,34);value.write('data',36);value.writeUInt32LE(frames*2,40);for(let n=0;n<frames;n++)value.writeInt16LE(Math.round(Math.sin(n/8)*2000),44+n*2);return value;}
const audio=wav();
const input=()=>({provider:'typecast',model:'ssfm-v31',text:'한국어로 완성한 내레이션입니다.',speaker:VOICE,tempo:1,pitch:0,volume:100,emotionType:'smart',emotion:'normal',emotionIntensity:1});
const provider=calls=>async request=>{calls.push(request);return request.action==='voices'?{bytes:Buffer.from(JSON.stringify(voices)),contentType:'application/json'}:{bytes:audio,contentType:'audio/wav'};};
async function server(t,options={},factory=createTypecastApi){const handle=factory({env:{TYPECAST_API_KEY:KEY},...options}),httpServer=http.createServer((req,res)=>handle(req,res,new URL(req.url,'http://localhost').pathname).then(done=>{if(!done)res.writeHead(404).end();}).catch(()=>res.writeHead(500).end()));httpServer.listen(0,'127.0.0.1');await once(httpServer,'listening');t.after(async()=>{httpServer.closeAllConnections();await new Promise(resolve=>httpServer.close(resolve));});const base=`http://127.0.0.1:${httpServer.address().port}`;return{base,post:(body,extra={})=>fetch(base+'/api/voice/generate',{method:'POST',headers:{'Content-Type':'application/json',...extra.headers},body:JSON.stringify(body),signal:extra.signal})};}

test('Typecast optional server configuration uses actual voice metadata without exposing any key or synthesizing text',async t=>{
 const calls=[],{base}=await server(t,{requestProvider:provider(calls)});const response=await fetch(base+'/api/voice/config'),raw=await response.text(),value=JSON.parse(raw);
 assert.equal(value.configured,true);assert.equal(value.provider,'typecast');assert.equal(value.model,'ssfm-v31');assert.equal(value.speakers[0].id,VOICE);assert.equal(value.speakers[0].name,'검증용 목소리');assert.equal(value.capabilities.language,'kor');assert.equal(value.limits.chunkCharacters,2000);assert.equal(value.limits.maxAudioBytes,TYPECAST_MAX_AUDIO_BYTES);assert.equal(raw.includes(KEY),false);assert.deepEqual(calls.map(call=>call.action),['voices']);
 assert.equal((await fetch(base+'/api/voice/config',{method:'HEAD'})).status,200);assert.equal(calls.some(call=>call.action==='tts'),false);
});
test('missing or invalid server Typecast configuration cannot reuse the OpenAI key or fabricate voices',async t=>{
 const calls=[],{base,post}=await server(t,{env:{SCRIPT_AI_API_KEY:'fixture-openai-is-not-typecast'},requestProvider:provider(calls)});const config=await(await fetch(base+'/api/voice/config')).json();assert.equal(config.configured,false);assert.deepEqual(config.speakers,[]);assert.equal((await post(input())).status,503);assert.deepEqual(calls,[]);
 const invalid=await server(t,{env:{TYPECAST_API_KEY:KEY,TYPECAST_MODEL:'unrecognized-model'},requestProvider:provider(calls)});assert.equal((await fetch(invalid.base+'/api/voice/config')).status,503);assert.deepEqual(calls,[]);
});
test('long Unicode scripts synthesize each exact chunk once with real binary output and matching smart context',async t=>{
 const calls=[],{post}=await server(t,{requestProvider:provider(calls)}),text='한국어🙂 문장을 이어서 읽습니다.\n'.repeat(240),response=await post({...input(),text});assert.equal(response.status,200);const raw=await response.text(),result=JSON.parse(raw),tts=calls.filter(call=>call.action==='tts');assert.ok(tts.length>1);assert.equal(tts.map(call=>call.payload.text).join(''),text);assert.equal(result.characters,Array.from(text).length);assert.equal(result.chunks.length,tts.length);assert.equal(result.provider,'typecast');assert.equal(raw.includes(KEY),false);
 for(let n=0;n<tts.length;n++){const call=tts[n];assert.equal(call.apiKey,KEY);assert.equal(call.payload.voice_id,VOICE);assert.equal(call.payload.language,'kor');assert.equal(call.payload.output.audio_format,'mp3');assert.equal(call.payload.output.audio_tempo,1);assert.ok(Array.from(call.payload.text).length<=2000);assert.equal(call.payload.prompt.emotion_type,'smart');if(n)assert.equal(call.payload.prompt.previous_text,tts[n-1].payload.text);if(n+1<tts.length)assert.equal(call.payload.prompt.next_text,tts[n+1].payload.text);assert.ok(Buffer.from(result.chunks[n].audio,'base64').equals(audio));}
});
test('request guards reject cross-origin, malformed JSON, caller credentials and legacy knobs before any provider request',async t=>{
 const calls=[],{base,post}=await server(t,{requestProvider:provider(calls)});
 for(const headers of [{Origin:'https://unrelated.example'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await post(input(),{headers})).status,403);
 assert.equal((await fetch(base+'/api/voice/config',{headers:{Origin:'https://unrelated.example'}})).status,403);
 for(const patch of[{apiKey:'private'},{speed:0},{provider:'clova'},{text:'가'.repeat(30001)},{model:'ssfm-v30'}])assert.equal((await post({...input(),...patch})).status,400);
 assert.equal((await fetch(base+'/api/voice/generate',{method:'POST',body:'plain'})).status,415);assert.equal((await fetch(base+'/api/voice/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);assert.equal((await post({...input(),text:'x'.repeat(300000)})).status,413);assert.equal((await fetch(base+'/api/voice/generate')).status,405);assert.equal((await fetch(base+'/api/voice/missing')).status,404);assert.deepEqual(calls,[]);
});
test('unsupported real voice/model/emotion and invalid audio never become a successful result or paid fallback',async t=>{
 let syntheses=0;const valid=provider([]),{post}=await server(t,{requestProvider:async request=>{if(request.action==='tts'){syntheses++;return{bytes:Buffer.from('{"error":"private"}'),contentType:'application/json'};}return valid(request);}});
 assert.equal((await post({...input(),speaker:'tc_000000000000000000000000'})).status,400);assert.equal(syntheses,0);const result=await post(input());assert.equal(result.status,502);assert.equal((await result.json()).code,'INVALID_TYPECAST_RESPONSE');assert.equal(syntheses,1);
});
test('native transport fixes hosts, headers and UTF-8 JSON while never following redirects or echoing provider bodies',async()=>{
 for(const action of['voices','tts'])for(const status of[200,301,401,402,403,404,422,429,500]){
  let called;const send=createTypecastProviderRequest({},(url,options,onResponse)=>{const request=new EventEmitter();request.end=bytes=>{called={url,options,bytes};const response=new EventEmitter();response.statusCode=status;response.headers={'content-type':action==='voices'?'application/json':'audio/wav'};response.resume=()=>{};onResponse(response);if(status===200){response.emit('data',action==='voices'?Buffer.from(JSON.stringify(voices)):audio);response.emit('end');}};return request;});
  const pending=send({action,apiKey:KEY,model:'ssfm-v31',payload:{text:'한글🙂'},signal:new AbortController().signal});
  if(status===200)assert.ok((await pending).bytes.length);else await assert.rejects(pending,cause=>cause instanceof TypecastApiError&&!cause.message.includes(KEY));
  assert.equal(called.options.headers['X-API-KEY'],KEY);assert.equal(called.url,action==='voices'?'https://api.typecast.ai/v3/voices?model=ssfm-v31':'https://api.typecast.ai/v1/text-to-speech');assert.equal(called.options.method,action==='voices'?'GET':'POST');if(action==='tts'){assert.equal(called.options.headers['Content-Length'],called.bytes.length);assert.deepEqual(JSON.parse(called.bytes),{text:'한글🙂'});}
 }
});
test('stalled native response bodies remain bounded by timeout and abort after headers',async()=>{
 let destroyed=0;const transport=()=>{const req=new EventEmitter();req.destroy=()=>{destroyed++;};req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'audio/wav'};res.destroy=()=>{};transport.response?.(res);});return req;};
 const factory=(url,options,onResponse)=>{transport.response=onResponse;return transport();};const send=createTypecastProviderRequest({},factory,{timeoutMs:15});await assert.rejects(send({action:'tts',apiKey:KEY,payload:{text:'대본'}}),cause=>cause.code==='TYPECAST_TIMEOUT');assert.ok(destroyed>0);
 const controller=new AbortController(),slow=createTypecastProviderRequest({},factory,{timeoutMs:1000}),pending=slow({action:'tts',apiKey:KEY,payload:{text:'대본'},signal:controller.signal});controller.abort();await assert.rejects(pending,cause=>cause.name==='AbortError');
});
test('a timed-out or canceled uncooperative provider releases only its own generation slot without retrying',async t=>{
 let calls=0;const {post}=await server(t,{timeoutMs:20,requestProvider:async request=>request.action==='voices'?{bytes:Buffer.from(JSON.stringify(voices)),contentType:'application/json'}:(calls++,new Promise(()=>{}))});
 const first=await post(input());assert.equal(first.status,504);assert.equal(calls,1);const second=await post(input());assert.equal(second.status,504);assert.equal(calls,2);
});
test('adapter dispatch preserves the legacy provider unless Typecast is selected and rejects unknown selections',async t=>{
 const calls=[],typed=await server(t,{env:{TYPECAST_API_KEY:KEY},requestProvider:provider(calls)},createVoiceApi);assert.equal((await(await fetch(typed.base+'/api/voice/config')).json()).provider,'typecast');
 const explicit=await server(t,{env:{VOICE_PROVIDER:'typecast'},requestProvider:provider(calls)},createVoiceApi);assert.equal((await(await fetch(explicit.base+'/api/voice/config')).json()).provider,'typecast');
 const legacy=await server(t,{env:{VOICE_PROVIDER:'clova',TYPECAST_API_KEY:KEY},requestProvider:async()=>assert.fail('legacy configuration never triggers Typecast')},createVoiceApi);assert.equal((await(await fetch(legacy.base+'/api/voice/config')).json()).provider,'clova');
 assert.throws(()=>createVoiceApi({env:{VOICE_PROVIDER:'unrecognized'}}),cause=>cause.code==='VOICE_PROVIDER_CONFIGURATION_ERROR');
});

test('an oversized declared binary response is rejected before allocating or consuming its body',async()=>{
 let resumed=false;const send=createTypecastProviderRequest({},(_url,_options,callback)=>{const request=new EventEmitter();request.end=()=>{const response=new EventEmitter();response.statusCode=200;response.headers={'content-type':'audio/mpeg','content-length':String(TYPECAST_MAX_CHUNK_AUDIO_BYTES+1)};response.resume=()=>{resumed=true;};callback(response);};return request;});
 await assert.rejects(send({action:'tts',apiKey:KEY,payload:{text:'짧은 대본'}}),cause=>cause.code==='TYPECAST_RESPONSE_TOO_LARGE');assert.equal(resumed,true);
});
test('a later Typecast chunk failure returns no partial successful audio and never retries remaining paid work',async t=>{
 let charged=0;const {post}=await server(t,{requestProvider:async request=>{if(request.action==='voices')return{bytes:Buffer.from(JSON.stringify(voices)),contentType:'application/json'};charged++;if(charged===2)throw new TypecastApiError(429,'TYPECAST_RATE_LIMITED','타입캐스트 API 요청 한도에 도달했어요.');return{bytes:audio,contentType:'audio/wav'};}});
 const response=await post({...input(),text:'가'.repeat(4001)}),raw=await response.text(),value=JSON.parse(raw);assert.equal(response.status,429);assert.equal(charged,2);assert.equal(value.chunks,undefined);assert.match(value.error,/이용 요금/u);assert.equal(raw.includes(KEY),false);
});
