import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeProductionState} from '../dist/production-state.js';
import {createProject,createScene,validateProject,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {normalizeYouTubeUploadDraft,normalizeYouTubeUploadRecord} from '../dist/youtube-protocol.js';
import {SUPPORT_BLOCK} from '../dist/description-preferences.js';

const CHANNEL='UC'+'s'.repeat(22),OTHER_CHANNEL='UC'+'t'.repeat(22),PLAYLIST='PL'+'p'.repeat(32);
const ownedLine='#블랙아웃 #BLKOUT #미니어처게임',selection={id:PLAYLIST,title:'블랙아웃 세계관',channelId:CHANNEL};
const CAPABILITY='https://www.googleapis.com/upload/youtube/v3/videos?upload_id=synthetic-private-session';
const videoId=n=>'v'+String(n).padStart(10,'0');
function transfer(n=1,status='pending',patch={}){return{videoId:videoId(n),playlistId:PLAYLIST,playlistTitle:selection.title,channelId:CHANNEL,status,updatedAt:'2026-11-05T12:00:00.000Z',...(status==='added'?{playlistItemId:`synthetic-playlist-item-${n}`} :{}),...patch};}
function receipt(n=1){return normalizeYouTubeUploadRecord({videoId:videoId(n),title:'블랙아웃 이야기',privacyStatus:'unlisted',channelId:CHANNEL,channelTitle:'직접 선택한 채널',uploadedAt:'2026-11-05T11:00:00.000Z',fileName:'synthetic.webm',bytes:4096});}
const state=youtube=>({version:1,youtube});
const draft=normalizeYouTubeUploadDraft({title:'블랙아웃 이야기',description:'  희망으로 시작한 이주는 새로운 갈등을 맞습니다.\r\n\r\n직접 검토한 문장입니다.\n\n'+ownedLine+'\n\n'+SUPPORT_BLOCK,tags:['블랙아웃','BLKOUT','미니어처 게임'],privacyStatus:'unlisted'});
function fixture(){return createProject({id:'playlist-project',title:'재생목록과 해시태그 복원',scenes:[createScene({id:'first',imageId:'image',caption:'블랙아웃 세계관 이야기',duration:2})],production:{version:1,description:{length:'short',support:true,hashtags:true,channelIntro:false},publishing:{hashtagLine:ownedLine},youtube:{draft,uploads:[receipt()],hashtagLine:ownedLine,playlistSelection:selection,playlistTransfers:[transfer(1,'added'),transfer(2,'needs-check'),transfer(3,'skipped')]}}});}

// These are state/backup tests only; no Google SDK, network, upload, or permission grant runs here.
test('legacy project and YouTube metadata remain absent of new playlist and hashtag fields',()=>{
  const empty=validateProject(createProject());assert.equal(Object.hasOwn(empty,'production'),false);
  const source=state({draft,uploads:[receipt()]}),normalized=normalizeProductionState(source);
  assert.deepEqual(normalized,source);for(const key of ['playlistSelection','playlistTransfers','hashtagLine'])assert.equal(Object.hasOwn(normalized.youtube,key),false);
  assert.deepEqual(normalizeProductionState({version:1,publishing:{}}),{version:1,publishing:{}});
});

test('playlist selections preserve an explicit null or exact bounded metadata without mutating the source',()=>{
  for(const playlistSelection of [null,selection]){
    const input=state({playlistSelection}),before=structuredClone(input),result=normalizeProductionState(input);
    assert.deepEqual(result,before);assert.deepEqual(input,before);assert.notEqual(result,input);
    if(playlistSelection){assert.notEqual(result.youtube.playlistSelection,selection);result.youtube.playlistSelection.title='다른 표시명';assert.equal(selection.title,'블랙아웃 세계관');}
    assert.deepEqual(validateProject(createProject({production:input})).production,before);
  }
  for(const playlistSelection of [false,'',[],{...selection,id:'bad'},{...selection,channelId:'not-a-channel'},{...selection,title:'x'.repeat(151)}])assert.throws(()=>normalizeProductionState(state({playlistSelection})));
});

test('twenty terminal playlist records or ten active plus ten terminal records fit portable bounds',()=>{
  const terminal=Array.from({length:20},(_,index)=>transfer(index+1,index%2?'added':'skipped'));
  assert.deepEqual(normalizeProductionState(state({playlistTransfers:terminal})).youtube.playlistTransfers,terminal);
  const mixed=Array.from({length:20},(_,index)=>transfer(index+1,index<10?['pending','needs-check','failed'][index%3]:index%2?'added':'skipped'));
  const result=normalizeProductionState(state({playlistSelection:null,playlistTransfers:mixed}));assert.equal(result.youtube.playlistTransfers.length,20);assert.equal(result.youtube.playlistTransfers.filter(value=>!['added','skipped'].includes(value.status)).length,10);assert.equal(result.youtube.playlistSelection,null);
  assert.deepEqual(normalizeProductionState(state({playlistTransfers:[]})),state({playlistTransfers:[]}));
});

test('twenty-one total or eleven unresolved playlist records are rejected regardless of receipt history',()=>{
  assert.throws(()=>normalizeProductionState(state({playlistTransfers:Array.from({length:21},(_,index)=>transfer(index+1,'skipped'))})),/20/u);
  for(const status of ['pending','needs-check','failed']){
    const playlistTransfers=Array.from({length:11},(_,index)=>transfer(index+1,status));
    assert.throws(()=>normalizeProductionState(state({uploads:[receipt()],playlistTransfers})),/확인하지 않은/u);
    assert.throws(()=>validateProject(createProject({production:state({playlistTransfers})})),/확인하지 않은/u);
  }
  for(const playlistTransfers of [null,{},'records',true])assert.throws(()=>normalizeProductionState(state({playlistTransfers})));
});

test('playlist ledger identities use the unique video and playlist pair across status/channel changes',()=>{
  for(const duplicate of [transfer(1),transfer(1,'needs-check'),transfer(1,'skipped',{channelId:OTHER_CHANNEL}),transfer(1,'added',{updatedAt:'2026-11-06T12:00:00.000Z'})])assert.throws(()=>normalizeProductionState(state({playlistTransfers:[transfer(1),duplicate]})),/중복/u);
  const separate=[transfer(1),transfer(2),transfer(1,'pending',{playlistId:'PL'+'q'.repeat(32),playlistTitle:'워해머 세계관'})];
  assert.deepEqual(normalizeProductionState(state({playlistTransfers:separate})).youtube.playlistTransfers,separate);
});

test('playlist state canonicalizes timestamps and rejects unknown status, invalid IDs or unconfirmed added records',()=>{
  const input=state({playlistTransfers:[transfer(1,'pending',{updatedAt:'2026-11-05T12:00:00Z'})]}),before=structuredClone(input),result=normalizeProductionState(input);
  assert.equal(result.youtube.playlistTransfers[0].updatedAt,'2026-11-05T12:00:00.000Z');assert.deepEqual(input,before);
  for(const patch of [{status:'uploaded'},{status:'added'},{videoId:'bad'},{playlistId:CAPABILITY},{channelId:'bad'},{playlistItemId:CAPABILITY},{updatedAt:'2026-02-30T12:00:00Z'},{updatedAt:'not-a-time'}])assert.throws(()=>normalizeProductionState(state({playlistTransfers:[transfer(1,'pending',patch)]})));
});

test('playlist and YouTube portable objects reject sensitive and unknown fields at every nesting level',()=>{
  const extraFields=[{accessToken:'synthetic-secret'},{refresh_token:'synthetic-secret'},{client_secret:'synthetic-secret'},{authorization:'Bearer synthetic-secret'},{token:'synthetic-secret'},{credentials:{}},{sessionUri:CAPABILITY},{rawProviderResponse:{}},{unexpected:true}];
  for(const extra of extraFields){
    assert.throws(()=>normalizeProductionState(state({...extra})));
    assert.throws(()=>normalizeProductionState(state({playlistSelection:{...selection,...extra}})));
    assert.throws(()=>normalizeProductionState(state({playlistTransfers:[{...transfer(),...extra}]})));
  }
  for(const playlistSelection of [{...selection,title:'ya29.'+'a'.repeat(30)},{...selection,title:'sk-'+'a'.repeat(30)},{...selection,title:CAPABILITY},{...selection,id:CAPABILITY}])assert.throws(()=>normalizeProductionState(state({playlistSelection})));
  assert.throws(()=>normalizeProductionState(state({playlistTransfers:[transfer(1,'pending',{playlistTitle:CAPABILITY})]})));
  for(const key of ['playlistAccess','autoUpload','pendingUpload','oauthScope','clientId'])assert.throws(()=>normalizeProductionState(state({[key]:true})));
});

test('publishing and YouTube owned hashtag markers preserve exact valid syntax and do not invent missing fields',()=>{
  for(const hashtagLine of ['',ownedLine,'#워해머40K #Warhammer40k','#미니어처_게임']){
    const input={version:1,publishing:{hashtagLine},youtube:{hashtagLine}},result=normalizeProductionState(input);
    assert.deepEqual(result,input);assert.equal(result.publishing.hashtagLine,hashtagLine);assert.equal(result.youtube.hashtagLine,hashtagLine);
  }
  const input=state({draft,hashtagLine:ownedLine}),normalized=normalizeProductionState(input);assert.equal(normalized.youtube.draft.description,draft.description);assert.deepEqual(normalized.youtube.draft.tags,draft.tags);
});

test('owned hashtag markers reject objects, prose, duplicates, excess tokens and malformed Unicode syntax in both domains',()=>{
  const invalid=[null,[],{},false,3,'plain text',' #BLKOUT','#BLKOUT ','#BLKOUT\n#블랙아웃','#BLKOUT #blkout','#BLKOUT #ＢＬＫＯＵＴ','#a #b #c #d #e #f','#'+ '가'.repeat(500),'#BLKOUT https://example.test','#BLKOUT <script>','#BLKOUT\u0001'];
  for(const hashtagLine of invalid){assert.throws(()=>normalizeProductionState({version:1,publishing:{hashtagLine}}));assert.throws(()=>normalizeProductionState(state({hashtagLine})));}
});

test('real project backup restores selected playlist, ledger, owned hashtag markers and original image bytes',async()=>{
  const bytes=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url)),source=fixture(),before=structuredClone(source),assets=new Map([['image',{blob:new Blob([bytes],{type:'image/png'}),name:'synthetic.png'}]]);
  const backup=await exportProjectBackup(source,assets),restored=await importProjectBackup(backup);
  assert.deepEqual(source,before);assert.deepEqual(restored.project.production,source.production);assert.deepEqual(restored.project.scenes,source.scenes);assert.deepEqual(Buffer.from(await restored.assets.get('image').blob.arrayBuffer()),bytes);
  assert.equal(restored.project.production.youtube.draft.description,draft.description);assert.deepEqual(restored.project.production.youtube.draft.tags,draft.tags);assert.equal(restored.project.production.publishing.hashtagLine,ownedLine);assert.equal(restored.project.production.youtube.playlistTransfers[0].playlistItemId,'synthetic-playlist-item-1');
  const raw=await backup.text();for(const forbidden of ['access_token','refresh_token','client_secret','upload_id','sessionUri','playlistAccess','force-ssl','clientId','oauthScope'])assert.equal(raw.includes(forbidden),false);
});

test('explicit no-playlist selection remains null through a portable backup',async()=>{
  const source=createProject({id:'no-playlist-project',production:state({draft,hashtagLine:'',playlistSelection:null,playlistTransfers:[]})}),restored=await importProjectBackup(await exportProjectBackup(source,new Map()));
  assert.deepEqual(restored.project.production.youtube,source.production.youtube);assert.equal(restored.project.production.youtube.playlistSelection,null);assert.equal(restored.assets.size,0);
});

test('import rejects tampered playlist and hashtag backup data before exposing a restored project',async()=>{
  const source=createProject({id:'tamper-test',production:state({playlistSelection:selection,playlistTransfers:[transfer()],hashtagLine:ownedLine})}),manifest=JSON.parse(await (await exportProjectBackup(source,new Map())).text());
  const mutations=[
    youtube=>{youtube.playlistSelection.accessToken='synthetic-secret';},
    youtube=>{youtube.playlistSelection.id=CAPABILITY;},
    youtube=>{youtube.playlistTransfers[0].rawProviderResponse={};},
    youtube=>{youtube.playlistTransfers.push({...youtube.playlistTransfers[0],status:'skipped'});},
    youtube=>{youtube.playlistTransfers=Array.from({length:21},(_,index)=>transfer(index+1,'skipped'));},
    youtube=>{youtube.playlistTransfers=Array.from({length:11},(_,index)=>transfer(index+1,'pending'));},
    youtube=>{youtube.hashtagLine='#BLKOUT #blkout';},
    youtube=>{youtube.playlistAccess=true;},
  ];
  for(const mutate of mutations){const corrupt=structuredClone(manifest);mutate(corrupt.project.production.youtube);await assert.rejects(importProjectBackup(JSON.stringify(corrupt)));}
  const corrupt=structuredClone(manifest);corrupt.project.production.publishing={hashtagLine:{raw:'not-text'}};await assert.rejects(importProjectBackup(corrupt));
  assert.deepEqual((await importProjectBackup(manifest)).project.production,source.production);
});
