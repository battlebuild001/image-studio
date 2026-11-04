import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {test} from 'node:test';
import {createBackendAccess} from '../scripts/backend-access.mjs';
import {createVoiceApi} from '../scripts/voice-api.mjs';

const APP='fixture-typecast-backend-app-token-24-characters',KEY='fixture-typecast-private-server-key',ORIGIN='https://battlebuild001.github.io',VOICE='tc_6045d56d5f9ae03ac175cf73';
const voices=[{voice_id:VOICE,voice_name:{kor:'서버 검사 목소리',eng:'Server Fixture'},models:[{version:'ssfm-v31',emotions:['normal','happy']}],voice_type:'original',age:null,gender:null,use_cases:[],preview_url:null}];
function wav(){const value=Buffer.alloc(524);value.write('RIFF');value.writeUInt32LE(value.length-8,4);value.write('WAVEfmt ',8);value.writeUInt32LE(16,16);value.writeUInt16LE(1,20);value.writeUInt16LE(1,22);value.writeUInt32LE(24000,24);value.writeUInt32LE(48000,28);value.writeUInt16LE(2,32);value.writeUInt16LE(16,34);value.write('data',36);value.writeUInt32LE(value.length-44,40);return value;}
const audio=wav(),body={provider:'typecast',text:'공식 연결 형식으로 한국어 음성을 만듭니다.',speaker:VOICE,model:'ssfm-v31',tempo:1,pitch:0,volume:100,emotionType:'smart',emotion:'normal',emotionIntensity:1};
async function setup(t,requestProvider){const calls=[],env={STUDIO_ACCESS_TOKEN:APP,VOICE_PROVIDER:'typecast',TYPECAST_API_KEY:KEY,TYPECAST_MODEL:'ssfm-v31'},gate=createBackendAccess({env,publicMode:true}),voice=createVoiceApi({env,requestProvider:async request=>{calls.push(request);return requestProvider?requestProvider(request):request.action==='voices'?{bytes:Buffer.from(JSON.stringify(voices)),contentType:'application/json'}:{bytes:audio,contentType:'audio/wav'};}}),trusted=[];
 const server=http.createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(gate(req,res,path))return;trusted.push({path,trusted:req.studioAuthenticated});if(await voice(req,res,path))return;res.writeHead(path==='/api/script/generate'?200:404,{'Content-Type':'application/json'}).end('{}');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});const base=`http://127.0.0.1:${server.address().port}`;
 const send=(path,{method='GET',auth=true,origin=ORIGIN,headers={},data,signal}={})=>fetch(base+path,{method,headers:{Origin:origin,'Sec-Fetch-Site':'cross-site',...(auth?{Authorization:`Bearer ${APP}`} :{}),...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{}),signal});return{calls,send,trusted};}
function secretsAbsent(raw){assert.equal(raw.includes(APP),false);assert.equal(raw.includes(KEY),false);}

test('public Typecast backend permits exact authenticated Pages origin and sends only canonical text to the selected provider',async t=>{
 const {send,calls,trusted}=await setup(t),config=await send('/api/voice/config'),configRaw=await config.text();assert.equal(config.status,200);assert.equal(config.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(JSON.parse(configRaw).provider,'typecast');assert.equal(JSON.parse(configRaw).speakers[0].id,VOICE);secretsAbsent(configRaw);assert.deepEqual(calls.map(value=>value.action),['voices']);
 const result=await send('/api/voice/generate',{method:'POST',data:body}),raw=await result.text(),value=JSON.parse(raw);assert.equal(result.status,200);secretsAbsent(raw);assert.equal(value.provider,'typecast');assert.equal(value.chunks.length,1);assert.ok(Buffer.from(value.chunks[0].audio,'base64').equals(audio));assert.equal(calls[1].apiKey,KEY);assert.equal(calls[1].payload.language,'kor');assert.equal(calls[1].payload.text,body.text);assert.deepEqual(calls[1].payload.output,{audio_format:'mp3',audio_tempo:1,audio_pitch:0,volume:100});assert.ok(trusted.every(item=>item.trusted===true));
});
test('public authentication, exact CORS and backend preflight prevent provider access before credentials are validated',async t=>{
 const {send,calls}=await setup(t);
 assert.equal((await send('/api/voice/config',{auth:false})).status,401);assert.equal((await send('/api/voice/generate',{method:'POST',auth:false,data:body})).status,401);assert.equal((await send('/api/voice/config',{origin:'https://unrelated.example'})).status,403);
 const preflight=await send('/api/voice/generate',{method:'OPTIONS',auth:false,headers:{'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'Authorization,Content-Type'}});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),ORIGIN);assert.equal(preflight.headers.get('access-control-allow-headers'),'Authorization, Content-Type');
 assert.equal((await send('/api/voice/generate',{method:'POST',data:{...body,apiKey:KEY}})).status,400);assert.deepEqual(calls,[]);
});
test('Typecast shares the server-wide paid-job lock and client cancellation releases it without a hidden second synthesis',async t=>{
 let entered;const seen=new Promise(resolve=>entered=resolve),{send,calls}=await setup(t,async request=>{if(request.action==='voices')return{bytes:Buffer.from(JSON.stringify(voices)),contentType:'application/json'};entered();return new Promise(()=>{});});
 const controller=new AbortController(),pending=send('/api/voice/generate',{method:'POST',data:body,signal:controller.signal});await seen;
 const script=await send('/api/script/generate',{method:'POST',data:{sourceText:'다른 유료 작업'}});assert.equal(script.status,429);assert.equal((await script.json()).code,'BACKEND_BUSY');assert.equal((await send('/api/voice/generate',{method:'POST',data:body})).status,429);assert.equal(calls.filter(value=>value.action==='tts').length,1);
 controller.abort();await assert.rejects(pending,cause=>cause.name==='AbortError');
 let released;for(let attempt=0;attempt<40;attempt++){released=await send('/api/script/generate',{method:'POST',data:{sourceText:'취소 후 새 명시 요청'}});if(released.status===200)break;await new Promise(resolve=>setTimeout(resolve,5));}assert.equal(released.status,200);assert.equal(calls.filter(value=>value.action==='tts').length,1);
});
