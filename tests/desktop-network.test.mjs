import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createDesktopFetch} from '../dist/desktop-fetch.js';
import {createYouTubeClient} from '../dist/youtube-client.js';
const require=createRequire(import.meta.url);
const {createDesktopNetwork,safeNormalizeServerBase}=require('../desktop/network.cjs');
const text=value=>new TextEncoder().encode(value).buffer;
const payload=(url,options={})=>({id:'request_test_1234',url,method:'GET',headers:[['Authorization','Bearer test-token']],body:null,...options});
const openai='https://api.openai.com/v1/models';
const location='https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=mock_session_123';
const errorCode=code=>cause=>cause.code===code;

test('desktop network transports fixed OpenAI, Typecast and YouTube routes without browser CORS or credentials',async()=>{
 const calls=[],network=createDesktopNetwork({fetchImpl:async(url,init)=>{calls.push({url,init});return new Response('ok',{headers:{'Content-Type':'application/json','Set-Cookie':'never=expose'}});}});
 const cases=[
  payload(openai),
  ...['responses','images/generations','images/edits','audio/transcriptions'].map(route=>payload('https://api.openai.com/v1/'+route,{method:'POST',headers:[['Authorization','Bearer test-key'],['Content-Type',route.includes('edits')?'multipart/form-data; boundary=test':'application/json']],body:text('{}')})),
  payload('https://api.typecast.ai/v3/voices?model=ssfm-v31',{headers:[['X-API-KEY','typecast-test-key-1234']]}),
  payload('https://api.typecast.ai/v1/text-to-speech',{method:'POST',headers:[['X-API-KEY','typecast-test-key-1234'],['Content-Type','application/json']],body:text('{}')}),
  payload('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50'),
  payload('https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50&pageToken=abc%2B%2F%3D'),
  payload('https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=PLabcdefghijkl&maxResults=1'),
  payload('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=PLabcdefghijkl&videoId=abcdefghijk&maxResults=1'),
  payload('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',{method:'POST',body:text('{}')}),
  payload('https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=abcdefghijk&uploadType=media',{method:'POST',headers:[['Authorization','Bearer test-token'],['Content-Type','image/png']],body:text('png')}),
  payload(location,{method:'PUT',headers:[['Authorization','Bearer test-token'],['Content-Range','bytes 0-2/3'],['Content-Type','video/mp4']],body:text('mp4')})
 ];
 for(const item of cases){const result=await network.fetch(item,'main-frame');assert.equal(new TextDecoder().decode(result.body),'ok');assert.equal(result.headers.some(([name])=>name==='set-cookie'),false);}
 assert.equal(calls.length,cases.length);for(const{init}of calls){assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert.equal(init.referrerPolicy,'no-referrer');assert.equal(init.cache,'no-store');}
 assert.equal(network.getActiveCount(),0);
});

test('desktop network preserves validated YouTube resumable Location and 308 Range without following redirects',async()=>{
 const calls=[],network=createDesktopNetwork({fetchImpl:async(url,init)=>{calls.push({url,init});return init.method==='POST'?new Response(null,{status:200,headers:{Location:location}}):new Response(null,{status:308,headers:{Range:'bytes=0-262143'}});}});
 const start=await network.fetch(payload('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',body:text('{}'),headers:[['Authorization','Bearer test-token'],['Content-Type','application/json; charset=UTF-8'],['X-Upload-Content-Length','524288'],['X-Upload-Content-Type','video/mp4']]}),'owner');
 assert.equal(new Headers(start.headers).get('Location'),location);
 const resume=await network.fetch(payload(location,{method:'PUT',headers:[['Authorization','Bearer test-token'],['Content-Range','bytes */524288']],body:new ArrayBuffer(0)}),'owner');
 assert.equal(resume.status,308);assert.equal(new Headers(resume.headers).get('Range'),'bytes=0-262143');assert.equal(calls.length,2);
});

test('desktop broker accepts existing external video formats such as MOV and rejects non-video upload MIME',async()=>{
 let calls=0;const network=createDesktopNetwork({fetchImpl:async()=>{calls++;return new Response(null,{headers:{Location:location}});}});
 for(const mime of ['video/mp4','video/webm','video/x-matroska','video/quicktime','video/mpeg','video/mp2t','video/x-msvideo','video/avi','video/x-flv','video/x-ms-wmv','video/3gpp','video/3gpp2','video/ogg'])await network.fetch(payload('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',body:text('{}'),headers:[['Authorization','Bearer test-token'],['X-Upload-Content-Type',mime]]}),'owner');
 assert.equal(calls,13);
 for(const mime of ['application/octet-stream','image/png','text/html','video/unknown'])await assert.rejects(network.fetch(payload('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',body:text('{}'),headers:[['Authorization','Bearer test-token'],['X-Upload-Content-Type',mime]]}),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));
 assert.equal(calls,13);
});

test('existing YouTube client connects, uploads MOV, applies a thumbnail and adds an owned playlist through the native broker',async t=>{
 const channel='UC'+'a'.repeat(22),video='synthetic01',playlist='PL'+'p'.repeat(32),calls=[];
 const network=createDesktopNetwork({fetchImpl:async(address,init)=>{
  const url=new URL(address);calls.push({url,init});
  if(url.pathname==='/youtube/v3/channels')return Response.json({items:[{id:channel,snippet:{title:'합성 네이티브 채널'}}]});
  if(url.pathname==='/upload/youtube/v3/videos')return init.method==='POST'?new Response(null,{headers:{Location:location}}):Response.json({id:video,snippet:{title:'합성 영상',channelId:channel},status:{privacyStatus:'private'}});
  if(url.pathname==='/upload/youtube/v3/thumbnails/set')return Response.json({kind:'youtube#thumbnailSetResponse',items:[{}]});
  if(url.pathname==='/youtube/v3/playlists')return Response.json({items:[{id:playlist,snippet:{title:'검토한 재생목록',channelId:channel}}]});
  if(url.pathname==='/youtube/v3/playlistItems')return init.method==='GET'?Response.json({items:[]}):Response.json({kind:'youtube#playlistItem',id:'playlist-item-123',snippet:{playlistId:playlist,channelId:channel,resourceId:{kind:'youtube#video',videoId:video}}});
  throw new Error('Unexpected mocked endpoint');
 }});
 const bridge={version:1,network:{fetch:input=>network.fetch(input,'renderer'),cancel:input=>network.cancel(input,'renderer')}},fetchImpl=createDesktopFetch({bridge,fetchImpl:()=>assert.fail('No raw provider fetch is allowed')});
 const storage=new Map(),client=createYouTubeClient({fetchImpl,storage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},loadIdentity:()=>({initTokenClient:config=>({requestAccessToken:()=>queueMicrotask(()=>config.callback({access_token:'mock-google-token',expires_in:3600,scope:config.scope}))})})});
 t.after(()=>client.dispose());client.saveClientId('123456789012-syntheticclient.apps.googleusercontent.com');assert.equal(calls.length,0);
 await client.connect({playlistAccess:true});assert.equal(client.getSession().channelId,channel);
 const uploaded=await client.uploadVideo({blob:new Blob([new Uint8Array(10)],{type:'video/quicktime'}),fileName:'합성영상.mov',metadata:{title:'합성 영상',description:'합성 내용 요약',tags:[],privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true}});assert.equal(uploaded.videoId,video);
 const png=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url));await client.setThumbnail({videoId:video,channelId:channel,blob:new Blob([png],{type:'image/png'})});
 assert.equal((await client.listPlaylists()).items[0].id,playlist);assert.equal((await client.addVideoToPlaylist({playlistId:playlist,videoId:video,channelId:channel})).alreadyPresent,false);
 const start=calls.find(call=>call.url.pathname==='/upload/youtube/v3/videos'&&call.init.method==='POST');assert.equal(start.init.headers.get('X-Upload-Content-Type'),'video/quicktime');assert.equal(calls.filter(call=>call.url.pathname==='/upload/youtube/v3/videos'&&call.init.method==='POST').length,1);assert.equal(calls.length,8);
});

test('desktop network rejects arbitrary destinations, paths, methods, queries and credential-bearing URLs before dispatch',async()=>{
 let calls=0;const network=createDesktopNetwork({fetchImpl:async()=>{calls++;return new Response('{}');}});
 const urls=['https://evil.example/v1/models','http://api.openai.com/v1/models','https://api.openai.com.evil.example/v1/models','https://127.0.0.1/api/script/config','file:///etc/passwd','studio://app/index.html','https://api.openai.com:444/v1/models','https://user:password@api.openai.com/v1/models','https://api.openai.com/v1/models#secret','https://api.openai.com/v1/files','https://api.openai.com/v1/models?access_token=secret','https://api.typecast.ai/v3/voices?model=ssfm-v31&url=https://evil.example','https://www.googleapis.com/youtube/v3/playlists?part=snippet&access_token=secret','https://www.googleapis.com/upload/youtube/v3/videos?upload_id=one&upload_id=two'];
 for(const url of urls)await assert.rejects(network.fetch(payload(url),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));
 for(const method of ['DELETE','PATCH','POST'])await assert.rejects(network.fetch(payload(openai,{method,body:method==='POST'?text('{}'):null}),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));
 await assert.rejects(network.fetch(payload('https://api.openai.com/v1/%2e%2e/models'),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));
 assert.equal(calls,0);
});

test('desktop network forbids cookies, untrusted headers, cross-provider credential types and duplicate authentication',async()=>{
 let calls=0;const network=createDesktopNetwork({fetchImpl:async()=>{calls++;return new Response('{}');}});
 for(const headers of [[],[['Cookie','session=x']],[['Proxy-Authorization','Basic x']],[['Authorization','Bearer key'],['Host','evil.example']],[['Authorization','Bearer key'],['Authorization','Bearer two']],[['X-API-KEY','typecast-test-key-1234']],[['Authorization','Bearer key\r\nCookie: bad']],[['Authorization','Bearer key'],['X-Upload-Content-Type','video/mp4']]])await assert.rejects(network.fetch(payload(openai,{headers}),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));
 await assert.rejects(network.fetch(payload('https://api.typecast.ai/v3/voices?model=ssfm-v31',{headers:[['Authorization','Bearer key']]}),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));
 assert.equal(calls,0);
});

test('desktop backend access is restricted to the exact configured prefix and existing application API routes',async()=>{
 let base='https://studio-backend.example/service',calls=[];const network=createDesktopNetwork({serverBase:()=>base,fetchImpl:async(url,init)=>{calls.push({url,init});return new Response('{}');}});
 await network.fetch(payload(base+'/api/script/config',{headers:[['Accept','application/json']]}),'owner');
 await network.fetch(payload(base+'/api/script/generate',{method:'POST',headers:[['Authorization','Bearer application-access-code'],['Content-Type','application/json']],body:text('{}')}),'owner');
 for(const url of ['https://studio-backend.example/api/script/config','https://studio-backend.example/service-other/api/script/config',base+'/api/script/config?target=elsewhere',base+'/admin',base+'/api/other/config'])await assert.rejects(network.fetch(payload(url),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));
 base='http://127.0.0.1:8123';await network.fetch(payload(base+'/api/voice/config',{headers:[]}), 'owner');
 base='';await assert.rejects(network.fetch(payload('http://127.0.0.1:8123/api/voice/config',{headers:[]}), 'owner'),errorCode('DESKTOP_NETWORK_INPUT'));
 assert.equal(calls.length,3);
 assert.equal(safeNormalizeServerBase('https://render-app.example/service///'),'https://render-app.example/service');
 for(const value of ['https://api.openai.com','https://192.168.1.1','https://10.0.0.1','https://[::ffff:127.0.0.1]','https://host.local','https://host.internal','https://metadata','http://example.com','https://user:pass@example.com','https://example.com/path/../hidden','https://example.com/%2e%2e/hidden','https://example.com?x=1'])assert.throws(()=>safeNormalizeServerBase(value),errorCode('DESKTOP_NETWORK_INPUT'));
});

test('desktop request cancellation is owner scoped, releases active work and never retries',async()=>{
 let calls=0;const network=createDesktopNetwork({fetchImpl:()=>{calls++;return new Promise(()=>{});}});
 const pending=network.fetch(payload(openai),'owner-one');await Promise.resolve();assert.equal(network.getActiveCount(),1);
 assert.deepEqual(network.cancel({id:'request_test_1234'},'owner-two'),{cancelled:false});
 assert.deepEqual(network.cancel({id:'request_test_1234'},'owner-one'),{cancelled:true});
 await assert.rejects(pending,cause=>cause.name==='AbortError');assert.equal(network.getActiveCount(),0);assert.equal(calls,1);
});

test('desktop timeout and disposal settle even when the network implementation ignores abort',async()=>{
 let calls=0;const network=createDesktopNetwork({timeoutMs:15,fetchImpl:()=>{calls++;return new Promise(()=>{});}});
 await assert.rejects(network.fetch(payload(openai),'owner'),errorCode('DESKTOP_NETWORK_TIMEOUT'));assert.equal(network.getActiveCount(),0);assert.equal(calls,1);
 const pending=network.fetch(payload(openai),'owner');network.dispose();await assert.rejects(pending,cause=>cause.name==='AbortError');assert.equal(network.getActiveCount(),0);await assert.rejects(network.fetch(payload(openai),'owner'),cause=>cause.name==='AbortError');assert.equal(calls,1);
});

test('desktop renderer crash cancellation aborts all owners and leaves the broker reusable',async()=>{
 let calls=0;const network=createDesktopNetwork({fetchImpl:async()=>{calls++;if(calls<3)return new Promise(()=>{});return new Response('recovered');}});
 const first=network.fetch(payload(openai),'first'),second=network.fetch(payload(openai),'second');await Promise.resolve();network.cancelAll();
 await assert.rejects(first,cause=>cause.name==='AbortError');await assert.rejects(second,cause=>cause.name==='AbortError');assert.equal(network.getActiveCount(),0);
 const result=await network.fetch(payload(openai),'new-renderer');assert.equal(new TextDecoder().decode(result.body),'recovered');assert.equal(calls,3);
});

test('desktop broker enforces request and streamed response sizes and sanitizes network errors',async()=>{
 let calls=0;const network=createDesktopNetwork({maxBytes:8,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(5));controller.enqueue(new Uint8Array(5));controller.close();}}));}});
 await assert.rejects(network.fetch(payload('https://api.openai.com/v1/responses',{method:'POST',body:new ArrayBuffer(9)}),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));assert.equal(calls,0);
 await assert.rejects(network.fetch(payload(openai),'owner'),errorCode('DESKTOP_NETWORK_SIZE'));assert.equal(calls,1);assert.equal(network.getActiveCount(),0);
 const leaked='Bearer secret-key';let failures=0;const bad=createDesktopNetwork({fetchImpl:async()=>{failures++;throw new Error(leaked);}});await assert.rejects(bad.fetch(payload(openai),'owner'),cause=>cause.code==='DESKTOP_NETWORK_FAILED'&&!cause.message.includes(leaked));assert.equal(failures,1);
 const oversized=createDesktopNetwork({fetchImpl:async()=>new Response('{}',{headers:{'Content-Length':String(9*1024*1024)}})});await assert.rejects(oversized.fetch(payload('https://api.typecast.ai/v3/voices?model=ssfm-v31',{headers:[['X-API-KEY','typecast-test-key-1234']]}),'owner'),errorCode('DESKTOP_NETWORK_SIZE'));
});

test('desktop broker blocks redirects and unsafe upload session locations without replaying side effects',async()=>{
 let calls=0;const redirect=createDesktopNetwork({fetchImpl:async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://evil.example/'}});}});await assert.rejects(redirect.fetch(payload(openai),'owner'),errorCode('DESKTOP_NETWORK_RESPONSE'));assert.equal(calls,1);
 const unsafe=createDesktopNetwork({fetchImpl:async()=>{calls++;return new Response(null,{headers:{Location:'https://evil.example/upload?upload_id=secret'}});}});await assert.rejects(unsafe.fetch(payload('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',{method:'POST',body:text('{}')}),'owner'),errorCode('DESKTOP_NETWORK_INPUT'));assert.equal(calls,2);
});
