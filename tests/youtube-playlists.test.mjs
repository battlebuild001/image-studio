import test from 'node:test';
import assert from 'node:assert/strict';
import {createYouTubeClient} from '../dist/youtube-client.js';
import {YOUTUBE_SCOPES} from '../dist/youtube-protocol.js';
import {YOUTUBE_PLAYLIST_SCOPE,normalizePlaylistSelection,normalizePlaylistTransfer,normalizePlaylistPageToken} from '../dist/youtube-playlist-protocol.js';

const CLIENT='123456789012-syntheticclient.apps.googleusercontent.com',OTHER_CLIENT='987654321098-otherclient.apps.googleusercontent.com';
const CHANNEL='UC'+'a'.repeat(22),OTHER_CHANNEL='UC'+'b'.repeat(22),PLAYLIST='PL'+'p'.repeat(32),OTHER_PLAYLIST='PL'+'q'.repeat(32),VIDEO='synthetic01',ITEM='synthetic-playlist-item-id';
const TOKEN='synthetic-google-token-private',CAPABILITY='https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret';
const selection={id:PLAYLIST,title:'워해머 세계관',channelId:CHANNEL},target={playlistId:PLAYLIST,videoId:VIDEO,channelId:CHANNEL};
const metadata={title:'워해머 세계관',description:'검토한 영상 설명',tags:['워해머 40k'],privacyStatus:'unlisted',selfDeclaredMadeForKids:false,containsSyntheticMedia:true};
const video=()=>new Blob([new Uint8Array(12)],{type:'video/webm'});
const reply=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}});
const channel=(id=CHANNEL)=>reply({items:[{id,snippet:{title:'테스트 채널'}}]});
const playlist=(id=PLAYLIST,channelId=CHANNEL,title=selection.title)=>({kind:'youtube#playlist',id,snippet:{title,channelId,description:TOKEN},etag:TOKEN});
const item=(overrides={})=>({kind:'youtube#playlistItem',id:ITEM,snippet:{playlistId:PLAYLIST,channelId:CHANNEL,resourceId:{kind:'youtube#video',videoId:VIDEO}},...overrides});
const defer=()=>{let resolve;const promise=new Promise(res=>{resolve=res;});return{promise,resolve};};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));

function harness(t,{handler,grantResponse,channelId=CHANNEL,...options}={}){
  const calls=[],oauth=[],events=[],stored=new Map(),tokenRequests=[];let loads=0;
  const storage={getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)};
  const identity={initTokenClient(config){oauth.push(config);return{requestAccessToken(input){tokenRequests.push(input);const result=typeof grantResponse==='function'?grantResponse(config):grantResponse;queueMicrotask(()=>config.callback(result||{access_token:TOKEN,scope:config.scope,expires_in:3600}));}};},revoke(_token,done){done?.();}};
  const client=createYouTubeClient({...options,storage,loadIdentity:()=>{loads++;return identity;},fetchImpl:async(url,input)=>{const address=new URL(url);calls.push({url:address.href,...input});if(address.pathname==='/youtube/v3/channels')return channel(typeof channelId==='function'?channelId():channelId);if(!handler)throw new Error('Unexpected playlist request');return handler(address,input,calls);}});
  client.subscribe(event=>events.push(event));client.saveClientId(CLIENT);t.after(()=>client.dispose());
  return{client,calls,oauth,events,stored,identity,tokenRequests,get loads(){return loads;}};
}
function defaultHandler(url,input){
  if(url.pathname==='/youtube/v3/playlists')return reply({items:[playlist()]});
  if(input.method==='GET')return reply({items:[]});
  return reply(item());
}
function safePublic(h){const value=JSON.stringify({session:h.client.getSession(),upload:h.client.getUploadState(),settings:h.client.getSettings(),events:h.events,storage:[...h.stored]});assert.equal(value.includes(TOKEN),false);assert.equal(value.includes('upload_id'),false);return value;}
function official(call){assert.equal(new URL(call.url).origin,'https://www.googleapis.com');assert.equal(call.redirect,'error');assert.equal(call.credentials,'omit');assert.equal(call.headers.Authorization,`Bearer ${TOKEN}`);}
function postCalls(h){return h.calls.filter(call=>call.method==='POST');}

// Portable records contain only bounded IDs/display text; provider envelopes are never persisted.
test('playlist selections normalize null and exact metadata while rejecting credentials, URLs and unsupported fields',()=>{
  assert.equal(normalizePlaylistSelection(),null);assert.equal(normalizePlaylistSelection(null),null);assert.deepEqual(normalizePlaylistSelection(selection),selection);
  assert.notEqual(normalizePlaylistSelection(selection),selection);
  for(const value of [[],new Date(),{...selection,token:TOKEN},{...selection,url:CAPABILITY},{...selection,id:CAPABILITY},{...selection,channelId:OTHER_PLAYLIST},{...selection,title:''},{...selection,title:'a'.repeat(151)},{...selection,title:'bad\nname'},{...selection,title:'ya29.'+'a'.repeat(30)},{...selection,title:CAPABILITY},{...selection,id:'sk-'+'a'.repeat(30)}])assert.throws(()=>normalizePlaylistSelection(value));
});

test('playlist transfer records enforce known statuses, strict IDs, timestamps and confirmed item identifiers',()=>{
  const base={videoId:VIDEO,playlistId:PLAYLIST,playlistTitle:selection.title,channelId:CHANNEL,status:'pending',updatedAt:'2026-11-05T12:00:00Z'};
  assert.deepEqual(normalizePlaylistTransfer(base),{...base,updatedAt:'2026-11-05T12:00:00.000Z'});
  for(const status of ['pending','needs-check','failed','skipped'])assert.equal(normalizePlaylistTransfer({...base,status}).status,status);
  assert.equal(normalizePlaylistTransfer({...base,status:'added',playlistItemId:ITEM}).playlistItemId,ITEM);
  for(const value of [{...base,status:'added'},{...base,status:'complete'},{...base,updatedAt:'2026-02-30T00:00:00Z'},{...base,updatedAt:0},{...base,videoId:CAPABILITY},{...base,playlistItemId:CAPABILITY},{...base,rawBody:{token:TOKEN}},{...base,authorization:TOKEN}])assert.throws(()=>normalizePlaylistTransfer(value));
  assert.equal(normalizePlaylistPageToken('CAUQAA=='),'CAUQAA==');assert.equal(normalizePlaylistPageToken(), '');
  for(const token of [CAPABILITY,'x\ny',{},'a'.repeat(1001),'ya29.'+'a'.repeat(30)])assert.throws(()=>normalizePlaylistPageToken(token));
});

test('ordinary OAuth scopes stay unchanged and readonly playlists return only owned canonical entries across pages',async t=>{
  const h=harness(t,{handler:url=>url.searchParams.has('pageToken')?reply({items:[playlist(OTHER_PLAYLIST,CHANNEL,'블랙아웃')]}):reply({items:[playlist(),playlist(OTHER_PLAYLIST,OTHER_CHANNEL,'다른 채널')],nextPageToken:'CAUQAA==',etag:TOKEN})});
  assert.equal(h.loads,0);assert.equal(h.calls.length,0);await h.client.connect();assert.equal(h.oauth[0].scope,YOUTUBE_SCOPES);assert.equal(h.client.getSession().playlistAccess,false);
  const first=await h.client.listPlaylists();assert.deepEqual(first,{items:[selection],nextPageToken:'CAUQAA=='});
  const second=await h.client.listPlaylists({pageToken:first.nextPageToken});assert.deepEqual(second,{items:[{id:OTHER_PLAYLIST,title:'블랙아웃',channelId:CHANNEL}],nextPageToken:''});
  for(const call of h.calls){official(call);assert.equal(call.method,'GET');}
  const url=new URL(h.calls[1].url);assert.equal(url.pathname,'/youtube/v3/playlists');assert.deepEqual([...url.searchParams],[['part','snippet'],['mine','true'],['maxResults','50']]);
  assert.equal(new URL(h.calls[2].url).searchParams.get('pageToken'),'CAUQAA==');assert.equal(h.oauth.length,1);assert.equal(postCalls(h).length,0);safePublic(h);
});

test('only explicit playlist permission requests the additional scope and preloaded SDK preserves the click gesture',async t=>{
  const h=harness(t);await h.client.prepareIdentity();let synchronous=false;
  const original=h.identity.initTokenClient;h.identity.initTokenClient=config=>{const token=original(config);return{requestAccessToken(input){synchronous=true;token.requestAccessToken(input);}};};
  const pending=h.client.connect({playlistAccess:true});assert.equal(synchronous,true);const state=await pending;
  assert.equal(state.playlistAccess,true);assert.equal(h.oauth[0].scope,`${YOUTUBE_SCOPES} ${YOUTUBE_PLAYLIST_SCOPE}`);assert.equal(h.oauth[0].include_granted_scopes,false);assert.deepEqual(h.tokenRequests,[{prompt:'select_account'}]);safePublic(h);
});

test('partial, lookalike, or unsolicited scope grants cannot authorize playlist mutation',async t=>{
  for(const scope of [YOUTUBE_SCOPES,`${YOUTUBE_SCOPES} ${YOUTUBE_PLAYLIST_SCOPE}.evil`,YOUTUBE_PLAYLIST_SCOPE]){
    const h=harness(t,{grantResponse:{access_token:TOKEN,scope,expires_in:3600}});
    await assert.rejects(h.client.connect({playlistAccess:true}),{code:scope===YOUTUBE_PLAYLIST_SCOPE?'YOUTUBE_SCOPE_REQUIRED':'YOUTUBE_PLAYLIST_SCOPE_REQUIRED'});assert.equal(h.calls.length,0);assert.equal(h.client.getSession().playlistAccess,false);
  }
  const h=harness(t,{grantResponse:{access_token:TOKEN,scope:`${YOUTUBE_SCOPES} ${YOUTUBE_PLAYLIST_SCOPE}`,expires_in:3600}});await h.client.connect();assert.equal(h.client.getSession().playlistAccess,false);
  await assert.rejects(h.client.addVideoToPlaylist(target),{code:'YOUTUBE_PLAYLIST_SCOPE_REQUIRED'});assert.equal(h.calls.length,1);await assert.rejects(h.client.connect({playlistAccess:'true'}),{code:'YOUTUBE_PLAYLIST_SCOPE_REQUIRED'});assert.equal(h.oauth.length,1);
});

test('playlist scopes expire with the token and switching to ordinary OAuth removes write access',async t=>{
  let clock=100000;const h=harness(t,{now:()=>clock});await h.client.connect({playlistAccess:true});assert.equal(h.client.getSession().playlistAccess,true);
  clock+=3600000;assert.equal(h.client.getSession().playlistAccess,false);await assert.rejects(h.client.addVideoToPlaylist(target),{code:'YOUTUBE_AUTH_EXPIRED'});assert.equal(h.calls.length,1);
  await h.client.connect({playlistAccess:true});await h.client.connect();assert.equal(h.client.getSession().playlistAccess,false);assert.equal(h.oauth.at(-1).scope,YOUTUBE_SCOPES);safePublic(h);
});

test('adding a video verifies live ownership and existing membership before exactly one official insert',async t=>{
  const h=harness(t,{handler:defaultHandler});await h.client.connect({playlistAccess:true});const before=h.client.getUploadState();
  const result=await h.client.addVideoToPlaylist(target);assert.deepEqual(result,{playlistItemId:ITEM,playlistId:PLAYLIST,videoId:VIDEO,alreadyPresent:false});assert.deepEqual(h.client.getUploadState(),before);
  assert.equal(h.calls.length,4);const [owned,lookup,insert]=h.calls.slice(1);for(const call of h.calls)official(call);
  assert.equal(owned.method,'GET');assert.deepEqual([...new URL(owned.url).searchParams],[['part','snippet'],['id',PLAYLIST],['maxResults','1']]);
  assert.equal(lookup.method,'GET');assert.deepEqual([...new URL(lookup.url).searchParams],[['part','snippet'],['playlistId',PLAYLIST],['videoId',VIDEO],['maxResults','1']]);
  assert.equal(insert.method,'POST');assert.equal(new URL(insert.url).pathname,'/youtube/v3/playlistItems');assert.equal(new URL(insert.url).search,'?part=snippet');assert.equal(insert.headers['Content-Type'],'application/json; charset=UTF-8');assert.deepEqual(JSON.parse(insert.body),{snippet:{playlistId:PLAYLIST,resourceId:{kind:'youtube#video',videoId:VIDEO}}});
  assert.equal(postCalls(h).length,1);assert.equal(h.calls.some(call=>call.url.includes('/upload/')),false);assert.ok(h.events.some(event=>event.type==='playlist-add-complete'));assert.equal(h.client.getSession().busy,false);safePublic(h);
});

test('an existing membership succeeds without POST and each explicit retry performs a fresh lookup',async t=>{
  let inserted=false;const h=harness(t,{handler:(url,input)=>{if(url.pathname.endsWith('/playlists'))return reply({items:[playlist()]});if(input.method==='GET')return reply({items:inserted?[item()]:[]});inserted=true;return reply(item());}});await h.client.connect({playlistAccess:true});
  assert.equal((await h.client.addVideoToPlaylist(target)).alreadyPresent,false);assert.equal((await h.client.addVideoToPlaylist(target)).alreadyPresent,true);assert.equal((await h.client.addVideoToPlaylist(target)).alreadyPresent,true);
  assert.equal(postCalls(h).length,1);assert.equal(h.calls.filter(call=>new URL(call.url).pathname.endsWith('/playlistItems')&&call.method==='GET').length,3);safePublic(h);
});

test('invalid targets, missing permission, changed channel or foreign playlist ownership never issue an insert',async t=>{
  const h=harness(t,{handler:defaultHandler});await h.client.connect();await assert.rejects(h.client.addVideoToPlaylist(target),{code:'YOUTUBE_PLAYLIST_SCOPE_REQUIRED'});assert.equal(h.calls.length,1);
  await h.client.connect({playlistAccess:true});const before=h.calls.length;
  for(const change of [{playlistId:CAPABILITY},{videoId:'invalid'},{channelId:'invalid'}])await assert.rejects(h.client.addVideoToPlaylist({...target,...change}),{code:'YOUTUBE_PLAYLIST_TARGET'});
  await assert.rejects(h.client.addVideoToPlaylist({...target,channelId:OTHER_CHANNEL}),{code:'YOUTUBE_PLAYLIST_CHANNEL_CHANGED'});assert.equal(h.calls.length,before);
  for(const owner of [OTHER_CHANNEL,CHANNEL]){
    const other=harness(t,{handler:()=>reply({items:[playlist(owner===CHANNEL?OTHER_PLAYLIST:PLAYLIST,owner)]})});await other.client.connect({playlistAccess:true});await assert.rejects(other.client.addVideoToPlaylist(target),{code:'YOUTUBE_PLAYLIST_OWNERSHIP'});assert.equal(other.calls.length,2);assert.equal(postCalls(other).length,0);
  }
});

test('missing, duplicate, oversized and malformed playlist pages fail safely without accepting response envelopes',async t=>{
  for(const body of [{items:null},{items:Array.from({length:51},()=>playlist())},{items:[playlist(),playlist()]},{items:[playlist(PLAYLIST,CHANNEL,'ya29.'+'x'.repeat(30))]},{items:[playlist()],nextPageToken:CAPABILITY},{items:[playlist()],nextPageToken:'x'.repeat(1001)}]){
    const h=harness(t,{handler:()=>reply(body)});await h.client.connect();await assert.rejects(h.client.listPlaylists(),{code:'YOUTUBE_PLAYLIST_RESPONSE'});assert.equal(h.client.getSession().busy,false);assert.equal(h.calls.length,2);safePublic(h);
  }
  const h=harness(t);await h.client.connect();for(const pageToken of [CAPABILITY,'a\nb',{},'x'.repeat(1001)])await assert.rejects(h.client.listPlaylists({pageToken}),{code:'YOUTUBE_PLAYLIST_PAGE'});assert.equal(h.calls.length,1);
});

test('malformed membership and missing playlist responses stop before mutation',async t=>{
  for(const [owned,membership,code]of [[[],[], 'YOUTUBE_PLAYLIST_NOT_FOUND'],[[playlist()], [item({snippet:{playlistId:PLAYLIST,resourceId:{kind:'youtube#video',videoId:'different01'}}})], 'YOUTUBE_PLAYLIST_UNCERTAIN'],[[playlist()], [item({id:CAPABILITY})], 'YOUTUBE_PLAYLIST_UNCERTAIN'],[[playlist()], [item(),item()], 'YOUTUBE_PLAYLIST_RESPONSE']]){
    const h=harness(t,{handler:url=>reply({items:url.pathname.endsWith('/playlists')?owned:membership})});await h.client.connect({playlistAccess:true});await assert.rejects(h.client.addVideoToPlaylist(target),{code});assert.equal(postCalls(h).length,0);assert.equal(h.client.getSession().busy,false);safePublic(h);
  }
});

test('a lost insert response is uncertain, never auto-retried, and explicit retry finds the existing membership',async t=>{
  let inserted=false;const h=harness(t,{handler:(url,input)=>{if(url.pathname.endsWith('/playlists'))return reply({items:[playlist()]});if(input.method==='GET')return reply({items:inserted?[item()]:[]});inserted=true;throw new TypeError(TOKEN+CAPABILITY);}});await h.client.connect({playlistAccess:true});
  await assert.rejects(h.client.addVideoToPlaylist(target),cause=>{assert.equal(cause.code,'YOUTUBE_PLAYLIST_UNCERTAIN');assert.equal(cause.message.includes(TOKEN),false);assert.equal(cause.message.includes(CAPABILITY),false);return true;});
  await turn();assert.equal(postCalls(h).length,1);assert.equal(h.client.getSession().busy,false);assert.equal((await h.client.addVideoToPlaylist(target)).alreadyPresent,true);assert.equal(postCalls(h).length,1);safePublic(h);
});

test('cancelling a stalled insert releases the shared lock, ignores late success and retries by membership',async t=>{
  const pending=defer(),started=defer();let inserted=false;const h=harness(t,{handler:(url,input)=>{if(url.pathname.endsWith('/playlists'))return reply({items:[playlist()]});if(input.method==='GET')return reply({items:inserted?[item()]:[]});inserted=true;started.resolve();return pending.promise;}});await h.client.connect({playlistAccess:true});
  const controller=new AbortController(),operation=h.client.addVideoToPlaylist({...target,signal:controller.signal});await started.promise;
  await assert.rejects(h.client.connect(),{code:'YOUTUBE_BUSY'});await assert.rejects(h.client.uploadVideo({blob:video(),metadata}),{code:'YOUTUBE_BUSY'});await assert.rejects(h.client.listPlaylists(),{code:'YOUTUBE_BUSY'});await assert.rejects(h.client.setThumbnail({...target,blob:new Blob([])}),{code:'YOUTUBE_BUSY'});
  controller.abort();await assert.rejects(operation,cause=>cause.name==='AbortError'&&cause.uncertain===true&&cause.phase==='playlist');assert.equal(h.client.getSession().busy,false);assert.equal(h.events.some(event=>event.type==='playlist-add-complete'),false);
  pending.resolve(reply(item()));await turn();assert.equal(h.events.some(event=>event.type==='playlist-add-complete'),false);assert.equal((await h.client.addVideoToPlaylist(target)).alreadyPresent,true);assert.equal(postCalls(h).length,1);safePublic(h);
});

test('disconnect or client ID changes cancel a pending list and cannot commit late playlist results',async t=>{
  for(const stop of [client=>client.disconnect(),client=>client.saveClientId(OTHER_CLIENT)]){
    const pending=defer(),started=defer(),h=harness(t,{handler:()=>{started.resolve();return pending.promise;}});await h.client.connect({playlistAccess:true});const list=h.client.listPlaylists();await started.promise;
    assert.equal(h.client.getSession().busy,true);await assert.rejects(h.client.addVideoToPlaylist(target),{code:'YOUTUBE_BUSY'});stop(h.client);await assert.rejects(list,{name:'AbortError'});assert.equal(h.client.getSession().connected,false);assert.equal(h.client.getSession().playlistAccess,false);assert.equal(h.client.getSession().busy,false);
    pending.resolve(reply({items:[playlist()]}));await turn();assert.equal(h.client.getSession().connected,false);safePublic(h);
  }
});

test('playlist JSON bodies stay bounded, abortable and timed even after successful headers',async t=>{
  for(const type of ['oversized','stalled']){
    const h=harness(t,{requestTimeoutMs:15,handler:()=>type==='oversized'?new Response('x'.repeat(1024*1024+1)):new Response(new ReadableStream({start(){}}))});await h.client.connect();
    await assert.rejects(h.client.listPlaylists(),{code:type==='oversized'?'YOUTUBE_BAD_RESPONSE':'YOUTUBE_TIMEOUT'});assert.equal(h.client.getSession().busy,false);assert.equal(h.calls.length,2);safePublic(h);
  }
  const headers=defer(),h=harness(t,{handler:()=>{headers.resolve();return new Response(new ReadableStream({start(){}}));}});await h.client.connect();const controller=new AbortController(),list=h.client.listPlaylists({signal:controller.signal});await headers.promise;controller.abort();await assert.rejects(list,{name:'AbortError'});assert.equal(h.client.getSession().busy,false);
});

test('insert timeout or malformed success leaves an uncertain result without any automatic retry',async t=>{
  for(const response of [()=>new Promise(()=>{}),()=>reply({kind:'youtube#playlistItem',id:ITEM,snippet:{playlistId:OTHER_PLAYLIST,channelId:CHANNEL,resourceId:{kind:'youtube#video',videoId:VIDEO}}}),()=>reply({kind:'unexpected',...selection}),()=>new Response('{broken'),()=>new Response(new ReadableStream({start(){}}))]){
    const h=harness(t,{requestTimeoutMs:15,handler:(url,input)=>url.pathname.endsWith('/playlists')?reply({items:[playlist()]}):input.method==='GET'?reply({items:[]}):response()});await h.client.connect({playlistAccess:true});
    await assert.rejects(h.client.addVideoToPlaylist(target),{code:'YOUTUBE_PLAYLIST_UNCERTAIN'});assert.equal(postCalls(h).length,1);assert.equal(h.client.getSession().busy,false);assert.equal(h.events.some(event=>event.type==='playlist-add-complete'),false);safePublic(h);
  }
});

test('playlist errors classify scope, ownership, quota and uncertain server failures without raw provider details',async t=>{
  for(const [status,reason,code]of [[403,'insufficientPermissions','YOUTUBE_PLAYLIST_SCOPE_REQUIRED'],[403,'ACCESS_TOKEN_SCOPE_INSUFFICIENT','YOUTUBE_PLAYLIST_SCOPE_REQUIRED'],[404,'playlistNotFound','YOUTUBE_PLAYLIST_NOT_FOUND'],[403,'playlistItemsNotAccessible','YOUTUBE_PLAYLIST_PERMISSION'],[403,'forbidden','YOUTUBE_PLAYLIST_PERMISSION'],[403,'playlistContainsMaximumNumberOfVideos','YOUTUBE_PLAYLIST_FULL'],[403,'quotaExceeded','YOUTUBE_QUOTA'],[403,'serviceDisabled','YOUTUBE_API_DISABLED'],[503,'unrecognized','YOUTUBE_PLAYLIST_UNCERTAIN']]){
    const h=harness(t,{handler:()=>reply({error:{message:TOKEN+CAPABILITY,errors:[{reason,message:TOKEN}],details:[{metadata:{consumer:TOKEN,token:CAPABILITY}}]}},status)});await h.client.connect({playlistAccess:true});
    await assert.rejects(h.client.addVideoToPlaylist(target),cause=>{assert.equal(cause.code,code);assert.equal(cause.phase,'playlist');assert.match(cause.message,/재생목록/u);assert.equal(cause.message.includes(TOKEN),false);assert.equal(cause.message.includes(CAPABILITY),false);return true;});assert.equal(h.calls.length,2);assert.equal(postCalls(h).length,0);safePublic(h);
  }
});

test('401 expires playlist access and preserves a completed video receipt',async t=>{
  let playlistFail=false;const h=harness(t,{handler:(url,input)=>{if(url.pathname==='/upload/youtube/v3/videos')return input.method==='POST'?new Response(null,{headers:{Location:CAPABILITY}}):reply({id:VIDEO,snippet:{title:metadata.title,channelId:CHANNEL},status:{privacyStatus:'unlisted'}});return playlistFail?reply({error:{errors:[{reason:'insufficientPermissions'}],message:TOKEN}},401):defaultHandler(url,input);}});
  await h.client.connect({playlistAccess:true});const record=await h.client.uploadVideo({blob:video(),metadata});assert.equal(record.videoId,VIDEO);const before=h.client.getUploadState();playlistFail=true;
  await assert.rejects(h.client.addVideoToPlaylist(target),{code:'YOUTUBE_AUTH_EXPIRED'});assert.equal(h.client.getSession().playlistAccess,false);assert.equal(h.client.getSession().connected,false);assert.deepEqual(h.client.getUploadState(),before);assert.equal(postCalls(h).length,1);safePublic(h);
});

test('an unfinished resumable upload blocks playlist writes while read-only list does not erase the session',async t=>{
  const h=harness(t,{handler:(url,input)=>{if(url.pathname==='/upload/youtube/v3/videos'){if(input.method==='POST')return new Response(null,{headers:{Location:CAPABILITY}});throw Error('lost chunk');}return reply({items:[playlist()]});}});await h.client.connect({playlistAccess:true});await assert.rejects(h.client.uploadVideo({blob:video(),metadata}),{code:'YOUTUBE_NETWORK'});const before=h.client.getUploadState();assert.equal(before.paused,true);
  await assert.rejects(h.client.addVideoToPlaylist(target),{code:'YOUTUBE_UPLOAD_PENDING'});assert.deepEqual(await h.client.listPlaylists(),{items:[selection],nextPageToken:''});assert.deepEqual(h.client.getUploadState(),before);assert.equal(postCalls(h).length,1);safePublic(h);
});
