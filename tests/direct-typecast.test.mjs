import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createDirectTypecastClient,DirectTypecastError,handlesTypecastPath,validateTypecastApiRequest} from '../dist/direct-typecast.js';

const KEY='typecast-synthetic-personal-api-key-not-real',SECOND='typecast-synthetic-replacement-api-key-not-real';
const SESSION='bth-studio-typecast-session-v1',BROWSER='bth-studio-typecast-browser-v1';
const VOICE='tc_synthetic_korean_voice';
const rawVoices=()=>[{voice_id:VOICE,voice_name:{eng:'Synthetic sample',kor:'합성 검증 목소리'},models:[{version:'ssfm-v31',emotions:['normal','happy','sad']},{version:'ssfm-v30',emotions:['normal','happy']},{version:'ssfm-v21',emotions:['normal','happy']}],gender:'female',age:'young_adult',preview_url:'https://static2.typecast.ai/data/actor/synthetic.mp3'}];
const WAV=new Uint8Array(await readFile(new URL('./fixtures/narration-test.wav',import.meta.url)));
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const speech=()=>new Response(WAV.slice(),{headers:{'Content-Type':'audio/wav'}});
const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const input=(extra={})=>({provider:'typecast',speaker:VOICE,text:'일구구일년의 이야기입니다.',...extra});
function store(){const values=new Map();return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}
function events(){const listeners=new Map();return{addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name),emit:value=>listeners.get('storage')?.(value)};}
function create(options={}){return createDirectTypecastClient({localStorage:store(),sessionStorage:store(),storageEvents:null,dispatchChange(){},...options});}
function gate(){let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};}
const pause=()=>new Promise(resolve=>setImmediate(resolve));

test('Typecast imports, settings, disabled config and safe metadata perform no network or project writes',async()=>{
 const local=store(),session=store();let calls=0,changes=0;
 const client=create({localStorage:local,sessionStorage:session,dispatchChange:()=>changes++,fetchImpl:()=>{calls++;throw Error('No request expected');}});
 assert.equal(typeof validateTypecastApiRequest,'function');assert.deepEqual(client.getSettings(),{enabled:false,hasKey:false,model:'ssfm-v31',rememberForTab:false,rememberInBrowser:false});
 const value=client.setSettings({apiKey:KEY});assert.equal(value.hasKey,true);assert.equal(value.enabled,true);assert.equal(JSON.stringify(value).includes(KEY),false);assert.equal(local.values.size,0);assert.equal(session.values.size,0);
 client.setEnabled(false);const configured=await(await client.fetch('/api/voice/config')).json();assert.equal(configured.configured,false);assert.equal(configured.provider,'typecast');assert.equal(JSON.stringify(configured).includes(KEY),false);assert.equal(changes,2);assert.equal(calls,0);
 assert.equal(create({localStorage:local,sessionStorage:session}).getSettings().hasKey,false);
 assert.equal(handlesTypecastPath('/api/voice/config'),true);assert.equal(handlesTypecastPath('/api/voice/generate'),true);assert.equal(handlesTypecastPath('/api/script/generate'),false);
});
test('explicit tab/browser scope restore, blank save, disable and removal preserve independent key consent',()=>{
 const local=store(),session=store();const client=create({localStorage:local,sessionStorage:session});
 client.setSettings({apiKey:KEY,model:'ssfm-v30',rememberForTab:true});assert.ok(session.values.get(SESSION).includes(KEY));assert.equal(local.values.size,0);
 const restored=create({localStorage:local,sessionStorage:session});assert.equal(restored.getSettings().model,'ssfm-v30');assert.equal(restored.getSettings().rememberForTab,true);
 restored.setSettings({apiKey:'',rememberInBrowser:true});assert.equal(session.values.size,0);assert.equal(local.values.size,1);assert.equal(restored.getSettings().rememberForTab,false);
 const browser=create({localStorage:local,sessionStorage:store()});assert.equal(browser.getSettings().hasKey,true);assert.equal(browser.getSettings().rememberInBrowser,true);
 browser.setEnabled(false);assert.equal(browser.getSettings().hasKey,true);assert.equal(browser.getSettings().enabled,false);browser.setEnabled(true);
 browser.clearSettings();assert.equal(local.values.size,0);assert.equal(browser.getSettings().hasKey,false);assert.equal(JSON.stringify(browser.getSettings()).includes(KEY),false);
});
test('failed scope transition rolls both stores back and leaves the old working key enabled',async()=>{
 const local=store(),session=store();let seen='';const client=create({localStorage:local,sessionStorage:session,fetchImpl:async(_url,options)=>{seen=options.headers.get('X-API-KEY');return response(rawVoices());}});
 client.setSettings({apiKey:KEY,rememberInBrowser:true});const original=local.values.get(BROWSER),remove=local.removeItem;local.removeItem=()=>{throw Error('write denied');};
 assert.throws(()=>client.setSettings({apiKey:SECOND,rememberForTab:true}),cause=>cause.code==='TYPECAST_SETTINGS_STORAGE');
 assert.equal(local.values.get(BROWSER),original);assert.equal(session.values.size,0);assert.equal(client.getSettings().rememberInBrowser,true);
 local.removeItem=remove;await client.checkKey({apiKey:''});assert.equal(seen,KEY);
});
test('invalid stored keys are discarded and storage changes do not opt tab/memory clients into browser retention',()=>{
 const local=store(),session=store(),ev=events();local.values.set(BROWSER,JSON.stringify({enabled:true,apiKey:'bad key',rememberInBrowser:true,rememberForTab:false,model:'ssfm-v31'}));
 const client=create({localStorage:local,sessionStorage:session,storageEvents:ev});assert.equal(client.getSettings().hasKey,false);assert.equal(local.values.size,0);
 client.setSettings({apiKey:KEY,rememberForTab:true});local.values.set(BROWSER,JSON.stringify({enabled:true,apiKey:SECOND,rememberInBrowser:true,rememberForTab:false,model:'ssfm-v30'}));ev.emit({key:BROWSER,storageArea:local});assert.equal(client.getSettings().model,'ssfm-v31');assert.equal(client.getSettings().rememberForTab,true);
});
test('candidate verification is a free fixed-endpoint voices GET and never commits candidate key or retention',async()=>{
 const calls=[];const local=store(),session=store(),client=create({localStorage:local,sessionStorage:session,fetchImpl:async(url,options)=>{calls.push({url,options});return response(rawVoices());}});
 client.setSettings({apiKey:KEY});const config=await client.checkKey({apiKey:SECOND,model:'ssfm-v30',rememberInBrowser:true});
 assert.equal(config.provider,'typecast');assert.equal(config.configured,true);assert.equal(config.verified,true);assert.equal(config.model,'ssfm-v30');assert.equal(config.speakers[0].id,VOICE);assert.equal(config.speakers[0].language,'multi');assert.equal(JSON.stringify(config).includes(SECOND),false);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.typecast.ai/v3/voices?model=ssfm-v30');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.headers.get('X-API-KEY'),SECOND);assert.equal(calls[0].options.headers.has('Authorization'),false);assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');assert.equal(local.values.size,0);assert.equal(session.values.size,0);assert.equal(client.getSettings().model,'ssfm-v31');
 await client.checkKey({apiKey:''});assert.equal(calls[1].options.headers.get('X-API-KEY'),KEY);
});
test('actual full-script chunks keep every Unicode character, use Korean MP3 payload and return real binary audio',async()=>{
 const calls=[];const text=('설정 이야기는 한글과 숫자를 포함합니다. 🚀\n').repeat(180);
 const client=create({fetchImpl:async(url,options)=>{calls.push({url,options,body:options.body?JSON.parse(options.body):null});return options.method==='GET'?response(rawVoices()):speech();}});client.setSettings({apiKey:KEY});
 const config=await(await client.fetch('/api/voice/config')).json();assert.equal(config.speakers.length,1);
 const result=await(await client.fetch('/api/voice/generate',post(input({text,tempo:1.2,pitch:-2,volume:120})))).json();
 assert.equal(result.provider,'typecast');assert.equal(result.characters,Array.from(text).length);const tts=calls.filter(value=>value.options.method==='POST');assert.ok(tts.length>1);assert.equal(tts.map(value=>value.body.text).join(''),text);assert.equal(calls.filter(value=>value.options.method==='GET').length,1,'generation reuses its matching verified voices cache');
 for(let index=0;index<tts.length;index++){const {body,url,options}=tts[index];assert.equal(url,'https://api.typecast.ai/v1/text-to-speech');assert.ok(Array.from(body.text).length<=2000);assert.equal(body.voice_id,VOICE);assert.equal(body.language,'kor');assert.equal(body.model,'ssfm-v31');assert.deepEqual(body.output,{audio_format:'mp3',audio_tempo:1.2,audio_pitch:-2,volume:120});assert.equal(body.prompt.emotion_type,'smart');if(index)assert.equal(body.prompt.previous_text,tts[index-1].body.text);if(index+1<tts.length)assert.equal(body.prompt.next_text,tts[index+1].body.text);assert.equal(options.headers.get('X-API-KEY'),KEY);assert.equal(options.headers.has('Authorization'),false);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');}
 assert.equal(result.chunks.length,tts.length);for(const chunk of result.chunks){assert.equal(chunk.mimeType,'audio/wav');assert.deepEqual(Buffer.from(chunk.audio,'base64'),Buffer.from(WAV));}assert.equal(JSON.stringify(result).includes(KEY),false);
});
test('older model requests use their own voice list and preset schema without the smart discriminator',async()=>{
 const calls=[];const client=create({fetchImpl:async(url,options)=>{calls.push({url,options});return options.method==='GET'?response(rawVoices()):speech();}});client.setSettings({apiKey:KEY,model:'ssfm-v21'});
 const value=await client.fetch('/api/voice/generate',post(input({emotionType:'preset',emotion:'happy',emotionIntensity:1.5})));assert.equal(value.status,200);assert.equal(calls[0].url,'https://api.typecast.ai/v3/voices?model=ssfm-v21');const body=JSON.parse(calls[1].options.body);assert.equal(body.model,'ssfm-v21');assert.equal(Object.hasOwn(body.prompt,'emotion_type'),false);assert.equal(body.prompt.emotion_preset,'happy');
});
test('preflight refuses malformed controls, unsupported cached voices/emotions and caller credentials before any charged request',async()=>{
 let calls=0;const client=create({fetchImpl:async()=>{calls++;return response(rawVoices());}});client.setSettings({apiKey:KEY});await client.fetch('/api/voice/config');assert.equal(calls,1);
 for(const body of [input({speed:0}),input({tempo:4}),input({pitch:1.2}),input({speaker:'tc_missing'}),input({emotionType:'preset',emotion:'angry'}),input({apiKey:KEY})])assert.throws(()=>client.validate('/api/voice/generate',post(body)));
 for(const header of ['Authorization','Proxy-Authorization','X-API-KEY'])assert.throws(()=>client.validate('/api/voice/generate',{...post(input()),headers:{'Content-Type':'application/json',[header]:'bad'}}));
 assert.equal(calls,1);assert.throws(()=>client.validate('/api/image/generate',post(input())));assert.equal((await client.fetch('/api/voice/generate',{method:'GET'})).status,405);assert.equal((await client.fetch('/api/voice/config',{method:'POST'})).status,405);
});
test('uncached unsupported voice cannot cause a paid TTS call and no provider error body is leaked',async()=>{
 const requests=[];const client=create({fetchImpl:async(url,options)=>{requests.push(url);return response(rawVoices());}});client.setSettings({apiKey:KEY});const value=await client.fetch('/api/voice/generate',post(input({speaker:'tc_missing'})));assert.equal(value.status,400);assert.equal(requests.length,1);assert.ok(requests[0].includes('/v3/voices'));
 const leaked=create({fetchImpl:async()=>response({detail:{input:KEY,raw:'private reference text'}},403)});leaked.setSettings({apiKey:KEY});const output=await leaked.fetch('/api/voice/config');assert.equal(output.status,403);const text=await output.text();assert.equal(text.includes(KEY),false);assert.equal(text.includes('private reference text'),false);
});
test('empty/invalid voice lists and JSON masquerading as audio preserve prior results without a synthetic fallback',async()=>{
 for(const data of [[],{voices:rawVoices()}]){let posts=0;const client=create({fetchImpl:async(_url,options)=>{if(options.method==='POST'){posts++;return speech();}return response(data);}});client.setSettings({apiKey:KEY});const value=await client.fetch('/api/voice/config');if(Array.isArray(data))assert.equal((await value.json()).configured,false);else assert.equal(value.status,502);const generation=await client.fetch('/api/voice/generate',post(input()));assert.notEqual(generation.status,200);assert.equal(posts,0);}
 let requests=0;const client=create({fetchImpl:async(_url,options)=>{requests++;return options.method==='GET'?response(rawVoices()):new Response('{"url":"https://example.com/fake.mp3"}',{headers:{'Content-Type':'audio/mpeg'}});}});client.setSettings({apiKey:KEY});const value=await client.fetch('/api/voice/generate',post(input()));assert.equal(value.status,502);assert.equal(requests,2);assert.equal((await value.json()).code,'INVALID_TYPECAST_RESPONSE');
});
test('paid calls are sequential and never automatically retried or continued after a rate limit',async()=>{
 let paid=0;const client=create({fetchImpl:async(_url,options)=>options.method==='GET'?response(rawVoices()):(paid++,response({detail:'rate limit'},429))});client.setSettings({apiKey:KEY});const result=await client.fetch('/api/voice/generate',post(input({text:'가'.repeat(4001)})));assert.equal(result.status,429);assert.equal(paid,1);assert.equal((await result.json()).code,'TYPECAST_RATE_LIMITED');
});
test('concurrent full/partial generation cannot create a second paid job or release a newer lock',async()=>{
 const held=gate();let paid=0;const client=create({fetchImpl:async(_url,options)=>options.method==='GET'?response(rawVoices()):(paid++,held.promise)});client.setSettings({apiKey:KEY});const first=client.fetch('/api/voice/generate',post(input()));await pause();const second=await client.fetch('/api/voice/generate',post(input()));assert.equal(second.status,429);assert.equal(paid,1);assert.throws(()=>client.validate('/api/voice/generate',post(input())),cause=>cause.code==='TYPECAST_BUSY');held.resolve(speech());assert.equal((await first).status,200);
});
test('cancel aborts an uncooperative provider and stops all remaining chunks without an automatic retry',async()=>{
 const held=gate(),started=gate();let paid=0;const client=create({fetchImpl:async(_url,options)=>{if(options.method==='GET')return response(rawVoices());paid++;started.resolve();return held.promise;}});client.setSettings({apiKey:KEY});const controller=new AbortController();const pending=client.fetch('/api/voice/generate',{...post(input({text:'한'.repeat(4001)})),signal:controller.signal});await started.promise;controller.abort();await assert.rejects(pending,cause=>cause.name==='AbortError');held.resolve(speech());await pause();assert.equal(paid,1);
});
test('key/model changes cancel in-flight verification and generation, ignore late results and do not block new jobs',async()=>{
 const held=gate(),started=gate();let tts=0;const keys=[];const client=create({fetchImpl:async(_url,options)=>{keys.push(options.headers.get('X-API-KEY'));if(options.method==='GET')return response(rawVoices());if(++tts===1){started.resolve();return held.promise;}return speech();}});client.setSettings({apiKey:KEY});const old=client.fetch('/api/voice/generate',post(input()));await started.promise;client.setSettings({apiKey:SECOND});await assert.rejects(old,cause=>cause.name==='AbortError');const latest=await client.fetch('/api/voice/generate',post(input()));assert.equal(latest.status,200);held.resolve(speech());await pause();assert.ok(keys.slice(2).every(value=>value===SECOND));
 const delayed=gate(),entered=gate(),check=create({fetchImpl:async()=>{entered.resolve();return delayed.promise;}});check.setSettings({apiKey:KEY});const pending=check.checkKey({apiKey:SECOND});await entered.promise;check.clearSettings();await assert.rejects(pending,cause=>cause.name==='AbortError');delayed.resolve(response(rawVoices()));
});
test('other-tab browser key removal revokes the active in-memory key and cancels an otherwise-stuck check',async()=>{
 const local=store(),ev=events(),held=gate(),entered=gate();let changes=0;
 const client=create({localStorage:local,storageEvents:ev,dispatchChange:()=>changes++,fetchImpl:async()=>{entered.resolve();return held.promise;}});client.setSettings({apiKey:KEY,rememberInBrowser:true});const pending=client.checkKey({});await entered.promise;local.removeItem(BROWSER);ev.emit({key:BROWSER,storageArea:local});await assert.rejects(pending,cause=>cause.name==='AbortError');assert.equal(client.getSettings().enabled,false);assert.equal(client.getSettings().hasKey,false);assert.equal(changes,2);held.resolve(response(rawVoices()));
});
test('response bodies remain abortable after headers and time out without retries or leaking user text',async()=>{
 let calls=0;const stalled=()=>new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}});
 const client=create({checkTimeoutMs:15,fetchImpl:async()=>{calls++;return stalled();}});client.setSettings({apiKey:KEY});await assert.rejects(client.checkKey({}),cause=>cause.code==='TYPECAST_TIMEOUT'&&cause.status===504);assert.equal(calls,1);
 const started=gate(),controller=new AbortController(),cancel=create({fetchImpl:async()=>{started.resolve();return stalled();}});cancel.setSettings({apiKey:KEY});const pending=cancel.checkKey({}, {signal:controller.signal});await started.promise;controller.abort();await assert.rejects(pending,cause=>cause.name==='AbortError');
 const audio=create({timeoutMs:15,fetchImpl:async(_url,options)=>options.method==='GET'?response(rawVoices()):new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'audio/mpeg'}})});audio.setSettings({apiKey:KEY});assert.equal((await audio.fetch('/api/voice/generate',post(input()))).status,504);
});
test('declared oversized audio and voice payloads are rejected before buffering and never retried',async()=>{
 let calls=0;const client=create({fetchImpl:async(_url,options)=>{calls++;return options.method==='GET'?response(rawVoices()):new Response(WAV,{headers:{'Content-Type':'audio/wav','Content-Length':String(33*1024*1024)}});}});client.setSettings({apiKey:KEY});const output=await client.fetch('/api/voice/generate',post(input()));assert.equal(output.status,502);assert.equal((await output.json()).code,'TYPECAST_RESPONSE_TOO_LARGE');assert.equal(calls,2);
 const voices=create({fetchImpl:async()=>new Response('[]',{headers:{'Content-Type':'application/json','Content-Length':String(9*1024*1024)}})});voices.setSettings({apiKey:KEY});await assert.rejects(voices.checkKey({}),cause=>cause.code==='TYPECAST_RESPONSE_TOO_LARGE');
});
