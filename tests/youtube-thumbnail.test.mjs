import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createYouTubeClient} from '../dist/youtube-client.js';
import {YOUTUBE_SCOPES,YOUTUBE_MAX_THUMBNAIL_BYTES,validateYouTubeThumbnailFile} from '../dist/youtube-protocol.js';

const CLIENT='123456789012-thumbnailtest.apps.googleusercontent.com',CHANNEL='UC'+'t'.repeat(22),OTHER_CHANNEL='UC'+'u'.repeat(22),VIDEO='thumbnail01',TOKEN='synthetic-thumbnail-token-kept-only-in-memory';
const LOCATION='https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=thumbnail-video-test';
const pngBytes=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url));
const jpegBytes=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDpaKKK+QPcP//Z','base64');
const image=()=>new Blob([pngBytes],{type:'image/png'}),video=()=>new Blob([Uint8Array.of(26,69,223,163,1,2,3)],{type:'video/webm'});
const metadata={title:'사용자가 확인한 영상',description:'실제 내용 요약입니다.',tags:[],privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true};
const reply=(body,status=200,headers={})=>Response.json(body,{status,headers});
const done=()=>reply({kind:'youtube#thumbnailSetResponse',items:[{default:{url:'https://i.ytimg.com/vi/thumbnail01/default.jpg',width:1280,height:720}}]});
const defer=()=>{let resolve;const promise=new Promise(value=>resolve=value);return{promise,resolve};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function harness({thumbnail=async()=>done(),...options}={}){
 const stored=new Map(),calls=[],events=[],scopes=[];
 const identity={initTokenClient(config){scopes.push(config.scope);return{requestAccessToken(){queueMicrotask(()=>config.callback({access_token:TOKEN,scope:config.scope,expires_in:3600}));}};}};
 const client=createYouTubeClient({storage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},loadIdentity:()=>identity,fetchImpl:async(url,init)=>{
  calls.push({url:String(url),...init});const target=new URL(url);
  if(target.pathname==='/youtube/v3/channels')return reply({items:[{id:CHANNEL,snippet:{title:'합성 썸네일 테스트 채널'}}]});
  if(target.pathname==='/upload/youtube/v3/thumbnails/set')return thumbnail(String(url),init);
  if(init.method==='POST')return new Response(null,{status:200,headers:{Location:LOCATION}});
  return reply({id:VIDEO,snippet:{title:metadata.title,channelId:CHANNEL},status:{privacyStatus:'private'}});
 },...options});client.saveClientId(CLIENT);client.subscribe(event=>events.push(event));
 return{client,calls,events,stored,scopes,async uploaded(){await client.connect();return client.uploadVideo({blob:video(),fileName:'합성영상.webm',metadata});}};
}
const videoPosts=h=>h.calls.filter(call=>call.method==='POST'&&new URL(call.url).pathname==='/upload/youtube/v3/videos');
const thumbnailPosts=h=>h.calls.filter(call=>new URL(call.url).pathname==='/upload/youtube/v3/thumbnails/set');

test('thumbnail preflight validates actual PNG/JPEG bytes and the intentional5MiB app bound',async()=>{
 assert.equal(YOUTUBE_MAX_THUMBNAIL_BYTES,5*1024**2);
 for(const type of['image/png','application/octet-stream',''])assert.equal(await validateYouTubeThumbnailFile(new Blob([pngBytes],{type})),'image/png');
 for(const type of['image/jpeg','image/jpg','application/octet-stream',''])assert.equal(await validateYouTubeThumbnailFile(new Blob([jpegBytes],{type})),'image/jpeg');
 for(const blob of[new Blob(),new Blob([new Uint8Array(YOUTUBE_MAX_THUMBNAIL_BYTES+1)],{type:'image/png'}),new Blob([pngBytes],{type:'image/jpeg'}),new Blob([jpegBytes],{type:'image/webp'}),new Blob(['not image bytes'],{type:'image/png'}),new Blob([pngBytes.subarray(0,32)],{type:'image/png'}),new Blob([jpegBytes.subarray(0,jpegBytes.length-2)],{type:'image/jpeg'})])await assert.rejects(validateYouTubeThumbnailFile(blob));
});

test('explicit thumbnails.set sends exact selected bytes to the fixed official media endpoint using existing scopes and no persisted response data',async()=>{
 const h=harness({thumbnail:async()=>reply({kind:'youtube#thumbnailSetResponse',etag:TOKEN,items:[{default:{url:'https://untrusted.example/'+TOKEN}}],metadata:{token:TOKEN}})});
 const record=await h.uploaded(),before=h.client.getUploadState(),blob=image(),result=await h.client.setThumbnail({videoId:record.videoId,channelId:record.channelId,blob});
 assert.deepEqual(result,{videoId:VIDEO,uploaded:true});assert.deepEqual(h.client.getUploadState(),before);assert.equal(h.client.getSession().busy,false);assert.deepEqual(h.scopes,[YOUTUBE_SCOPES]);
 const request=thumbnailPosts(h)[0];assert.equal(request.url,'https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=thumbnail01&uploadType=media');assert.equal(request.method,'POST');assert.equal(request.credentials,'omit');assert.equal(request.redirect,'error');assert.equal(request.headers.Authorization,'Bearer '+TOKEN);assert.equal(request.headers['Content-Type'],'image/png');assert.equal(request.body,blob);assert.deepEqual(new Uint8Array(await request.body.arrayBuffer()),new Uint8Array(pngBytes));assert.equal(videoPosts(h).length,1);assert.equal(thumbnailPosts(h).length,1);
 const exposed=JSON.stringify({result,events:h.events,settings:h.client.getSettings(),session:h.client.getSession(),upload:h.client.getUploadState(),storage:[...h.stored]});assert.equal(exposed.includes(TOKEN),false);assert.equal(exposed.includes('upload_id'),false);assert.equal(exposed.includes('untrusted.example'),false);h.client.dispose();
});

test('invalid image/target and wrong channel reject before any thumbnail request and preserve a completed video',async()=>{
 const h=harness();await h.uploaded();const before=h.client.getUploadState();
 for(const input of[{videoId:'not-valid',channelId:CHANNEL,blob:image()},{videoId:VIDEO,channelId:'invalid',blob:image()},{videoId:VIDEO,channelId:OTHER_CHANNEL,blob:image()},{videoId:VIDEO,channelId:CHANNEL,blob:new Blob(['fake'],{type:'image/png'})}])await assert.rejects(h.client.setThumbnail(input));
 assert.equal(thumbnailPosts(h).length,0);assert.equal(videoPosts(h).length,1);assert.deepEqual(h.client.getUploadState(),before);h.client.dispose();
});

test('thumbnail permission/image/rate/not-found errors stay actionable and safe without erasing successful video state or retrying',async()=>{
 for(const[status,reason,code,expected]of[[403,'forbidden','YOUTUBE_THUMBNAIL_PERMISSION',/맞춤 썸네일 사용 자격/u],[400,'invalidImage','YOUTUBE_THUMBNAIL_IMAGE',/PNG·JPEG/u],[400,'mediaBodyRequired','YOUTUBE_THUMBNAIL_IMAGE',/이미지 내용/u],[404,'videoNotFound','YOUTUBE_THUMBNAIL_VIDEO_NOT_FOUND',/영상 링크/u],[429,'uploadRateLimitExceeded','YOUTUBE_THUMBNAIL_RATE_LIMIT',/최근 썸네일/u],[503,'unknown-'+TOKEN,'YOUTUBE_THUMBNAIL_UNCERTAIN',/현재 썸네일/u]]){
  const h=harness({thumbnail:async()=>reply({error:{message:TOKEN,errors:[{reason,message:TOKEN}],metadata:{secret:TOKEN}}},status)});await h.uploaded();const before=h.client.getUploadState();
  await assert.rejects(h.client.setThumbnail({videoId:VIDEO,channelId:CHANNEL,blob:image()}),cause=>{assert.equal(cause.code,code);assert.equal(cause.phase,'thumbnail');assert.match(cause.message,expected);assert.equal(cause.message.includes(TOKEN),false);assert.equal(JSON.stringify(cause).includes(TOKEN),false);return true;});
  assert.deepEqual(h.client.getUploadState(),before);assert.equal(h.client.getSession().busy,false);assert.equal(videoPosts(h).length,1);assert.equal(thumbnailPosts(h).length,1);h.client.dispose();
 }
});

test('cancelled thumbnail requests release the shared lock, ignore late success and retry only the same thumbnail explicitly',async()=>{
 const entered=defer(),held=defer();let first=true;
 const h=harness({thumbnail:async()=>{if(first){first=false;entered.resolve();return held.promise;}return done();}});await h.uploaded();const before=h.client.getUploadState(),controller=new AbortController(),pending=h.client.setThumbnail({videoId:VIDEO,channelId:CHANNEL,blob:image(),signal:controller.signal});await entered.promise;
 assert.equal(h.client.getSession().uploading,true);await assert.rejects(h.client.uploadVideo({blob:video(),metadata}),{code:'YOUTUBE_BUSY'});await assert.rejects(h.client.connect(),{code:'YOUTUBE_BUSY'});await assert.rejects(h.client.setThumbnail({videoId:VIDEO,channelId:CHANNEL,blob:image()}),{code:'YOUTUBE_BUSY'});assert.throws(()=>h.client.clearUpload(),{code:'YOUTUBE_BUSY'});
 controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(h.client.getSession().busy,false);assert.deepEqual(h.client.getUploadState(),before);held.resolve(done());await tick();assert.equal(h.events.filter(event=>event.type==='thumbnail-complete').length,0);assert.equal(thumbnailPosts(h).length,1);
 await h.client.setThumbnail({videoId:VIDEO,channelId:CHANNEL,blob:image()});assert.equal(thumbnailPosts(h).length,2);assert.equal(videoPosts(h).length,1);assert.deepEqual(h.client.getUploadState(),before);h.client.dispose();
});

test('expired credentials preserve the completed video and malformed or stalled thumbnail responses cannot claim success',async()=>{
 for(const mode of['401','malformed','stalled']){
  const h=harness({requestTimeoutMs:15,thumbnail:async()=>mode==='401'?reply({error:{}},401):mode==='malformed'?reply({kind:'wrong',items:[]}):new Response(new ReadableStream({start(){}}),{status:200})});await h.uploaded();const before=h.client.getUploadState();
  await assert.rejects(h.client.setThumbnail({videoId:VIDEO,channelId:CHANNEL,blob:image()}),{code:mode==='401'?'YOUTUBE_AUTH_EXPIRED':'YOUTUBE_THUMBNAIL_UNCERTAIN'});assert.deepEqual(h.client.getUploadState(),before);assert.equal(videoPosts(h).length,1);assert.equal(thumbnailPosts(h).length,1);assert.equal(h.client.getSession().busy,false);assert.equal(h.client.getSession().connected,mode!=='401');h.client.dispose();
 }
});
