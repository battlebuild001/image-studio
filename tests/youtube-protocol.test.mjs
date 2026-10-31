import assert from 'node:assert/strict';
import {test} from 'node:test';
import {YOUTUBE_UPLOAD_SCOPE,YOUTUBE_READONLY_SCOPE,YOUTUBE_SCOPES,YOUTUBE_MAX_VIDEO_BYTES,normalizeYouTubeClientId,normalizeYouTubeMetadata,buildYouTubeVideoResource,normalizeYouTubeUploadDraft,normalizeYouTubeUploadRecord,publishingToYouTubeMetadata,youtubeExportSourceKey,youtubeTagCharacterCount,validateYouTubeVideoFile} from '../dist/youtube-protocol.js';

const clientId='123456789012-synthetic-web-client.apps.googleusercontent.com';
function metadata(overrides={}) {return {title:'우주 이야기의 시작',description:'이 영상의 내용을 소개합니다.\n\n원본 흐름을 따라 살펴보세요.',tags:['세계관','우주 이야기'],privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true,...overrides};}
function receipt(overrides={}) {return {videoId:'synthetic01',title:'업로드한 영상',privacyStatus:'private',channelId:'UC'+'a'.repeat(22),channelTitle:'사용자가 연결한 채널',uploadedAt:'2026-10-31T04:40:00.000Z',fileName:'완성한 영상.webm',bytes:1234,...overrides};}
function project() {return {id:'project-one',title:'영상 제목',aspect:'16:9',settings:{subtitles:true,branding:false},scenes:[{id:'scene-one',imageId:'image-one',caption:'첫 화면',duration:4,motion:'zoom-in'}],audio:{narrationId:'voice-one',bgmId:'bgm-one',narrationStart:1,narrationEnd:5},captions:[{start:0,end:4,text:'첫 번째 화면 자막'}],captionMode:'speech',captionAnalysis:{narrationId:'voice-one',sourceStart:1,sourceEnd:5}};}

test('public Google OAuth client IDs accept configured web IDs and reject secrets or destinations',()=>{
  assert.equal(normalizeYouTubeClientId(' '+clientId+' '),clientId);assert.equal(normalizeYouTubeClientId('  '),'');assert.equal(normalizeYouTubeClientId(), '');
  for(const value of ['AIzaSy-not-an-oauth-id','GOCSPX-not-a-web-client','https://example.com/client','ya29.synthetic-google-token-value','client.apps.googleusercontent.com','123456-client.apps.googleusercontent.com.evil.test',42,{},'1'.repeat(257)])assert.throws(()=>normalizeYouTubeClientId(value));
  assert.equal(YOUTUBE_SCOPES,`${YOUTUBE_UPLOAD_SCOPE} ${YOUTUBE_READONLY_SCOPE}`);assert.ok(YOUTUBE_SCOPES.includes('/youtube.upload'));assert.ok(YOUTUBE_SCOPES.includes('/youtube.readonly'));
});

test('metadata keeps exact description and explicit disclosure/privacy values in the real YouTube resource',()=>{
  const input=metadata({title:'  눈으로 보는 우주  ',description:'  첫 문장\r\n\r\n원문을 유지합니다.\t  ',privacyStatus:'unlisted'}),before=structuredClone(input),value=normalizeYouTubeMetadata(input);
  assert.equal(value.title,'눈으로 보는 우주');assert.equal(value.description,input.description);assert.deepEqual(input,before);
  const resource=buildYouTubeVideoResource(value);assert.deepEqual(resource,{snippet:{title:value.title,description:input.description,tags:['세계관','우주 이야기'],categoryId:'22',defaultLanguage:'ko'},status:{privacyStatus:'unlisted',selfDeclaredMadeForKids:false,containsSyntheticMedia:true}});
  assert.equal(normalizeYouTubeMetadata(metadata({defaultLanguage:'en',privacyStatus:'public',selfDeclaredMadeForKids:true,containsSyntheticMedia:false})).defaultLanguage,'en');
  for(const key of ['privacyStatus','selfDeclaredMadeForKids','containsSyntheticMedia']){const absent=metadata();delete absent[key];assert.throws(()=>normalizeYouTubeMetadata(absent));}
  for(const value of [metadata({privacyStatus:'PUBLIC'}),metadata({selfDeclaredMadeForKids:'false'}),metadata({containsSyntheticMedia:1}),metadata({categoryId:'arbitrary'}),metadata({defaultLanguage:'unrecognized'}),metadata({publishAt:'2027-01-01T00:00:00Z'})])assert.throws(()=>normalizeYouTubeMetadata(value));
});

test('YouTube title limits count Unicode characters and description limits count UTF-8 bytes',()=>{
  assert.equal(Array.from(normalizeYouTubeMetadata(metadata({title:'🌌'.repeat(100)})).title).length,100);
  assert.throws(()=>normalizeYouTubeMetadata(metadata({title:'🌌'.repeat(101)})),/100/);
  assert.throws(()=>normalizeYouTubeMetadata(metadata({title:'   '})),/제목/);
  assert.equal(new TextEncoder().encode(normalizeYouTubeMetadata(metadata({description:'한'.repeat(1666)+'ab'})).description).length,5000);
  assert.equal(normalizeYouTubeMetadata(metadata({description:'🌌'.repeat(1250)})).description.length,2500);
  assert.throws(()=>normalizeYouTubeMetadata(metadata({description:'한'.repeat(1667)})),/5,000바이트/);
  assert.throws(()=>normalizeYouTubeMetadata(metadata({description:'🌌'.repeat(1251)})),/5,000바이트/);
  for(const value of [metadata({title:'<제목>'}),metadata({title:'한 줄\n두 줄'}),metadata({description:'주소 <원문>'}),metadata({description:'제어\u0001문자'})])assert.throws(()=>normalizeYouTubeMetadata(value));
});

test('tag limits include comma separators and quoted space tags without changing user terms',()=>{
  assert.equal(youtubeTagCharacterCount(['우주','우주 이야기']),11);
  assert.deepEqual(normalizeYouTubeMetadata(metadata({tags:['  Warhammer 40K  ','세계관']})).tags,['Warhammer 40K','세계관']);
  assert.equal(youtubeTagCharacterCount(normalizeYouTubeMetadata(metadata({tags:['a'.repeat(498),'b']})).tags),500);
  assert.equal(youtubeTagCharacterCount(normalizeYouTubeMetadata(metadata({tags:['a'.repeat(496)+' b']})).tags),500);
  for(const tags of [['a'.repeat(499),'b'],['a'.repeat(497)+' b'],Array(31).fill('tag'),[''],['  '],['<tag>'],['tag\nnext'],'not-array'])assert.throws(()=>normalizeYouTubeMetadata(metadata({tags})));
});

test('portable drafts allow incomplete titles with private defaults and reject credential/raw session fields',()=>{
  const value=normalizeYouTubeUploadDraft();assert.deepEqual(value,{title:'',description:'',tags:[],privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true});
  assert.equal(normalizeYouTubeUploadDraft({description:'원문만 먼저 작성합니다.'}).title,'');
  for(const field of ['clientId','clientSecret','accessToken','refresh_token','authorization','uploadUrl','sessionUri','autoUpload','blob','rawResponse'])assert.throws(()=>normalizeYouTubeUploadDraft({...value,[field]:'forbidden'}));
  assert.throws(()=>normalizeYouTubeUploadDraft({title:'ya29.'+'a'.repeat(25)}));assert.throws(()=>normalizeYouTubeUploadDraft({description:'sk-synthetic-credential-value-never-portable'}));
  const input={...value,tags:['우주']},copy=normalizeYouTubeUploadDraft(input);copy.tags.push('다른 태그');assert.deepEqual(input.tags,['우주']);
});

test('upload receipts derive a fixed video URL, canonicalize real timestamps and retain only safe metadata',()=>{
  const input=receipt(),value=normalizeYouTubeUploadRecord(input);assert.equal(value.videoUrl,'https://www.youtube.com/watch?v=synthetic01');assert.deepEqual(Object.keys(value),['videoId','videoUrl','title','privacyStatus','channelId','channelTitle','uploadedAt','fileName','bytes']);
  assert.equal(normalizeYouTubeUploadRecord(receipt({uploadedAt:'2026-10-31T04:40:00Z'})).uploadedAt,'2026-10-31T04:40:00.000Z');
  assert.deepEqual(normalizeYouTubeUploadRecord({...input,videoUrl:value.videoUrl}),value);
  assert.equal(normalizeYouTubeUploadRecord(receipt({fileName:'a>b.webm',channelTitle:'세상 <3 이야기'})).fileName,'a>b.webm');
  for(const patch of [{videoId:'short'},{videoId:12345678901},{channelId:'UCshort'},{videoUrl:'https://evil.test/watch?v=synthetic01'},{videoUrl:'https://www.youtube.com/watch?v=other000001'},{uploadedAt:'2026-02-30T00:00:00.000Z'},{uploadedAt:'yesterday'},{bytes:0},{bytes:NaN},{bytes:YOUTUBE_MAX_VIDEO_BYTES+1},{fileName:'../private.webm'},{title:'<invalid>'},{accessToken:'never-store'},{uploadUrl:'https://www.googleapis.com/session'}])assert.throws(()=>normalizeYouTubeUploadRecord(receipt(patch)));
});

test('publishing import preserves real description, tags and chapter times and never copies the full script',()=>{
  const source=project();source.scriptDraft={draftScript:'사용자가 공개하기로 하지 않은 긴 원본 대본'};source.production={publishing:{selectedTitle:1,result:{titles:['첫 후보','선택한 영상 제목'],description:'  사용자가 검토한 설명입니다.  ',tags:['세계관','우주'],chapters:[{start:0,title:'도입'},{start:65.7,title:'항해'},{start:3601,title:'정착'}]}}};
  const before=structuredClone(source),value=publishingToYouTubeMetadata(source);
  assert.equal(value.title,'선택한 영상 제목');assert.equal(value.description,'  사용자가 검토한 설명입니다.  \n\n챕터\n00:00 도입\n01:05 항해\n01:00:01 정착');assert.deepEqual(value.tags,['세계관','우주']);assert.equal(value.description.includes(source.scriptDraft.draftScript),false);assert.deepEqual(source,before);
  const noKit=publishingToYouTubeMetadata(project());assert.equal(noKit.title,'영상 제목');assert.equal(noKit.description,'');assert.equal(noKit.privacyStatus,'private');
});

test('oversized publishing imports fail without truncating the source or current draft',()=>{
  const source=project();source.production={publishing:{selectedTitle:0,result:{titles:['올릴 제목'],description:'한'.repeat(1660),tags:[],chapters:[{start:0,title:'긴 챕터 설명입니다.'}]}}};const before=structuredClone(source);
  assert.throws(()=>publishingToYouTubeMetadata(source),/5,000바이트/);assert.deepEqual(source,before);
  source.production.publishing.result.description='짧은 설명';source.production.publishing.result.titles=['가'.repeat(101)];assert.throws(()=>publishingToYouTubeMetadata(source),/100/);
});

test('export signatures ignore production bookkeeping and scripts but detect every visible media/timing change',()=>{
  const source=project(),key=youtubeExportSourceKey(source);source.production={version:1,budget:{spentUsd:1},youtube:{draft:{title:'메타데이터'}}};source.scriptDraft={draftScript:'음성으로 아직 만들지 않은 대본'};source.imageStudio={background:'아직 생성하지 않은 설명'};source.scenePlan={confirmedAt:'new-time'};assert.equal(youtubeExportSourceKey(source),key);
  const edits=[p=>p.id='another-project',p=>p.title+=' 변경',p=>p.aspect='9:16',p=>p.settings.subtitles=false,p=>p.scenes[0].imageId='new-image',p=>p.scenes[0].duration=5,p=>p.scenes[0].motion='none',p=>p.audio.bgmId='new-bgm',p=>p.audio.narrationEnd=4,p=>p.captions[0].text+=' 새 문장',p=>p.captionMode='srt',p=>p.captionAnalysis.sourceEnd=4];
  for(const edit of edits){const next=structuredClone(source);edit(next);assert.notEqual(youtubeExportSourceKey(next),key);}
});

test('export signatures are stable across object insertion order and reject malformed cycles or numeric state',()=>{
  const source=project(),other=structuredClone(source);other.settings={branding:false,subtitles:true};other.audio={narrationEnd:5,bgmId:'bgm-one',narrationId:'voice-one',narrationStart:1};assert.equal(youtubeExportSourceKey(source),youtubeExportSourceKey(other));
  const cycle=project();cycle.scenes[0].self=cycle.scenes[0];assert.throws(()=>youtubeExportSourceKey(cycle));const invalid=project();invalid.scenes[0].duration=NaN;assert.throws(()=>youtubeExportSourceKey(invalid));
});

test('video file validation supports real browser MIME descriptors without claiming codec processing',()=>{
  assert.equal(validateYouTubeVideoFile(new Blob(['synthetic-webm-bytes'],{type:'video/webm;codecs=vp9,opus'})),'video/webm');assert.equal(validateYouTubeVideoFile(new File(['synthetic-mp4-bytes'],'완성 영상.mp4',{type:'video/mp4'})),'video/mp4');
  assert.equal(validateYouTubeVideoFile(new File(['synthetic-mov-bytes'],'완성 영상.mov')),'video/quicktime');assert.equal(validateYouTubeVideoFile(new Blob(['m4v'],{type:'video/x-m4v'})),'video/mp4');
  assert.equal(validateYouTubeVideoFile(new File(['synthetic-mkv-bytes'],'완성 영상.mkv')),'video/x-matroska');assert.equal(validateYouTubeVideoFile(new Blob(['synthetic-mkv-bytes'],{type:'video/x-matroska'})),'video/x-matroska');
  for(const value of [new Blob([],{type:'video/webm'}),new Blob(['text'],{type:'text/plain'}),new Blob(['empty-mime']),new File(['video'],'../video.mp4',{type:'video/mp4'}),{size:3,type:'video/mp4'},null])assert.throws(()=>validateYouTubeVideoFile(value));
  const oversized=new Blob(['test'],{type:'video/webm'});Object.defineProperty(oversized,'size',{value:YOUTUBE_MAX_VIDEO_BYTES+1});assert.throws(()=>validateYouTubeVideoFile(oversized));
});
