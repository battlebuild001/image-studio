import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createYouTubeClient} from '../dist/youtube-client.js';
import {YOUTUBE_SCOPES} from '../dist/youtube-protocol.js';

const CLIENT='123456789012-syntheticschedule.apps.googleusercontent.com', CHANNEL='UC'+'a'.repeat(22), VIDEO='synthetic01', TOKEN='synthetic-in-memory-schedule-token', UNIT=256*1024;
const LOCATION='https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=synthetic-schedule';
const START=Date.parse('2027-01-01T00:00:00Z'), PUBLISH='2027-01-01T00:03:00.000Z';
const data=patch=>({title:'예약 영상',description:'내용 요약',tags:['예약'],privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true,publishAt:PUBLISH,scheduleTimeZone:'Asia/Seoul',...patch});
const reply=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
const initialized=()=>new Response(null,{status:200,headers:{Location:LOCATION}});
const ack=bytes=>new Response(null,{status:308,headers:bytes?{Range:`bytes=0-${bytes-1}`}:{}});
const complete=status=>reply({id:VIDEO,snippet:{title:'예약 영상',channelId:CHANNEL},status});
const video=(size=12)=>new Blob([new Uint8Array(size)],{type:'video/webm'});
function harness(handler){
  let time=START;const calls=[],events=[],storage=new Map();
  const identity={initTokenClient(config){return{requestAccessToken(){queueMicrotask(()=>config.callback({access_token:TOKEN,scope:YOUTUBE_SCOPES,expires_in:3600}));}};}};
  const client=createYouTubeClient({storage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},now:()=>time,chunkSize:UNIT,loadIdentity:()=>identity,fetchImpl:async(url,input)=>{const call={url:String(url),...input};calls.push(call);if(call.url.includes('/youtube/v3/channels?'))return reply({items:[{id:CHANNEL,snippet:{title:'합성 예약 채널'}}]});return handler(call,{setTime:value=>time=value,time:()=>time,calls});}});
  client.saveClientId(CLIENT);client.subscribe(event=>events.push(event));return{client,calls,events,setTime:value=>time=value};
}

test('scheduled videos initialize privately with exact canonical publishAt and unchanged OAuth scopes',async()=>{
  const h=harness(async call=>{
    if(call.method==='POST'){const resource=JSON.parse(call.body);assert.equal(resource.status.privacyStatus,'private');assert.equal(resource.status.publishAt,PUBLISH);assert.equal(resource.status.scheduleTimeZone,undefined);assert.equal(JSON.stringify(resource).includes('Asia/Seoul'),false);return initialized();}
    assert.equal(call.url,LOCATION);assert.equal(call.headers['Content-Range'],'bytes 0-11/12');assert.equal(call.body.size,12);return complete({privacyStatus:'private',publishAt:'2027-01-01T00:03:00+00:00'});
  });
  await h.client.connect();const record=await h.client.uploadVideo({blob:video(),fileName:'예약.webm',metadata:data()});
  assert.equal(record.publishAt,PUBLISH);assert.equal(record.scheduleTimeZone,'Asia/Seoul');assert.equal(record.scheduleConfirmed,true);assert.equal(record.privacyStatus,'private');assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.calls.filter(call=>call.method==='PUT').length,1);
  assert.equal(JSON.stringify(h.events).includes(TOKEN),false);assert.equal(JSON.stringify(h.client.getUploadState()).includes('upload_id'),false);h.client.dispose();
});

test('expired or too-close schedules and nonprivate schedules fail before any Google upload initialization',async()=>{
  const h=harness(()=>{throw Error('Must not upload');});await h.client.connect();
  for(const [patch,code]of [[{publishAt:'2026-01-01T00:00:00Z'},'YOUTUBE_SCHEDULE_EXPIRED'],[{publishAt:'2027-01-01T00:01:59Z'},'YOUTUBE_SCHEDULE_TOO_SOON']])await assert.rejects(h.client.uploadVideo({blob:video(),metadata:data(patch)}),{code});
  await assert.rejects(h.client.uploadVideo({blob:video(),metadata:data({privacyStatus:'public'})}),/비공개/u);
  await assert.rejects(h.client.uploadVideo({blob:video(),metadata:data({scheduleTimeZone:'not/a-zone'})}));assert.equal(h.calls.length,1);assert.equal(h.client.getUploadState().available,false);h.client.dispose();
});

test('missing, mismatched or invalid schedule echoes retain the successful receipt without claiming confirmation',async()=>{
  for(const status of [{privacyStatus:'private'},{privacyStatus:'private',publishAt:'2027-01-01T00:04:00Z'},{privacyStatus:'private',publishAt:'bad-date'},{publishAt:PUBLISH},{privacyStatus:'public',publishAt:PUBLISH},undefined]){
    const h=harness(async call=>call.method==='POST'?initialized():complete(status));await h.client.connect();const record=await h.client.uploadVideo({blob:video(),metadata:data()});
    assert.equal(record.videoId,VIDEO);assert.equal(record.publishAt,PUBLISH);assert.equal(record.scheduleConfirmed,false);assert.equal(h.client.getUploadState().complete,true);assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.calls.filter(call=>call.method==='PUT').length,1);h.client.dispose();
  }
});

test('a delayed initialization stops before all media bytes and expired resume probes without retransmitting',async()=>{
  const h=harness(async(call,clock)=>{if(call.method==='POST'){clock.setTime(START+151000);return initialized();}assert.equal(call.headers['Content-Range'],'bytes */12');return ack(0);});await h.client.connect();
  await assert.rejects(h.client.uploadVideo({blob:video(),metadata:data()}),{code:'YOUTUBE_SCHEDULE_TOO_SOON'});assert.equal(h.calls.filter(call=>call.method==='PUT').length,0);assert.equal(h.client.getUploadState().available,true);
  h.setTime(START+181000);await assert.rejects(h.client.resumeUpload(),{code:'YOUTUBE_SCHEDULE_EXPIRED'});assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.calls.filter(call=>call.method==='PUT').length,1);assert.equal(h.calls.at(-1).body.size,0);assert.equal(h.client.getUploadState().uploadedBytes,0);h.client.dispose();
});

test('a schedule deadline after a confirmed chunk prevents the final chunk, retaining same-session progress',async()=>{
  const h=harness(async(call,clock)=>{if(call.method==='POST')return initialized();if(call.headers['Content-Range'].startsWith('bytes */'))return ack(UNIT);assert.equal(call.headers['Content-Range'],`bytes 0-${UNIT-1}/${UNIT+3}`);clock.setTime(START+151000);return ack(UNIT);});await h.client.connect();
  await assert.rejects(h.client.uploadVideo({blob:video(UNIT+3),metadata:data()}),{code:'YOUTUBE_SCHEDULE_TOO_SOON'});assert.equal(h.client.getUploadState().uploadedBytes,UNIT);assert.equal(h.client.getUploadState().available,true);assert.equal(h.calls.filter(call=>call.method==='PUT').length,1);
  h.setTime(START+181000);await assert.rejects(h.client.resumeUpload(),{code:'YOUTUBE_SCHEDULE_EXPIRED'});assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.calls.filter(call=>call.method==='PUT'&&call.body.size>0).length,1);assert.equal(h.calls.at(-1).body.size,0);h.client.dispose();
});

test('a lost final response recovers its already-uploaded scheduled video after expiry with only a completion probe',async()=>{
  const h=harness(async(call,clock)=>{if(call.method==='POST')return initialized();if(call.headers['Content-Range'].startsWith('bytes */'))return complete({privacyStatus:'private',publishAt:PUBLISH});clock.setTime(START+181000);throw new TypeError('Synthetic final response lost after provider acceptance');});await h.client.connect();
  await assert.rejects(h.client.uploadVideo({blob:video(),metadata:data()}),{code:'YOUTUBE_NETWORK'});assert.equal(h.client.getUploadState().uncertain,true);
  const receipt=await h.client.resumeUpload();assert.equal(receipt.videoId,VIDEO);assert.equal(receipt.scheduleConfirmed,true);assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.calls.filter(call=>call.method==='PUT'&&call.body.size>0).length,1);assert.equal(h.calls.at(-1).headers['Content-Range'],'bytes */12');assert.equal(h.client.getUploadState().complete,true);h.client.dispose();
});

test('provider schedule rejection never silently switches privacy or retries an upload',async()=>{
  const h=harness(async call=>{assert.equal(call.method,'POST');assert.equal(JSON.parse(call.body).status.privacyStatus,'private');return reply({error:{errors:[{reason:'invalidPublishAt'}],message:TOKEN}},400);});await h.client.connect();
  await assert.rejects(h.client.uploadVideo({blob:video(),metadata:data()}),error=>!error.message.includes(TOKEN));assert.equal(h.calls.filter(call=>call.method==='POST').length,1);assert.equal(h.calls.filter(call=>call.method==='PUT').length,0);h.client.dispose();
});

test('unscheduled uploads omit publishAt exactly and do not acquire new portable confirmation fields',async()=>{
  const h=harness(async call=>{if(call.method==='POST'){assert.equal(Object.hasOwn(JSON.parse(call.body).status,'publishAt'),false);return initialized();}return complete({privacyStatus:'unlisted'});});await h.client.connect();
  const metadata=data({privacyStatus:'unlisted'});delete metadata.publishAt;delete metadata.scheduleTimeZone;const receipt=await h.client.uploadVideo({blob:video(),metadata});assert.equal(Object.hasOwn(receipt,'publishAt'),false);assert.equal(Object.hasOwn(receipt,'scheduleConfirmed'),false);h.client.dispose();
});
