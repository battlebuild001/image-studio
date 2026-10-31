import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {captureVersion,restoreVersion,compareScriptVersions} from '../dist/production-history.js';
import {createProject,createScene,validateProject,referencedAssetIds,canonicalAssets,exportProjectBackup,importProjectBackup} from '../dist/project.js';

const original='일구구일년, 우주를 향한 첫 항해가 시작됩니다.';
const display='1991년, 우주를 향한 첫 항해가 시작됩니다.';
function draft(script=original){return{sourceText:'직접 보관한 자료',instructions:'배경을 자세히',targetMinutes:8,charsPerMinute:330,draftScript:script,displayScript:display,result:null};}
const png=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url));
const image=id=>[id,{blob:new Blob([png],{type:'image/png'}),name:`${id}.png`,type:'image/png'}];

test('script versions preserve separate screen/narration text and source inputs, deduplicate content and show changed region',()=>{
  const project=createProject({scriptDraft:draft()}),entry=captureVersion(project,'script',{label:'초안'});assert.ok(entry);assert.equal(captureVersion(project,'script',{label:'다른 이름'}),null);
  project.scriptDraft.draftScript='바뀐 두 번째 대본입니다.';project.scriptDraft.displayScript='바뀐 화면 대본';restoreVersion(project,entry);
  assert.equal(project.scriptDraft.draftScript,original);assert.equal(project.scriptDraft.displayScript,display);assert.equal(project.scriptDraft.sourceText,'직접 보관한 자료');assert.equal(project.scriptDraft.instructions,'배경을 자세히');
  assert.deepEqual(compareScriptVersions('앞\n이전\n끝','앞\n수정\n끝'),{unchanged:false,beforeCharacters:6,afterCharacters:6,removed:'이전',added:'수정'});
  assert.equal(compareScriptVersions('같음','같음').unchanged,true);
});

test('history bounds and raw snapshot structure never recursively copy the project, assets or its own history',()=>{
  const project=createProject({scriptDraft:draft()});for(let i=0;i<40;i++){project.scriptDraft.draftScript=`${i}번째 실제 대본`;captureVersion(project,'script');}
  assert.equal(project.production.versions.length,30);assert.equal(project.production.versions[0].script,'10번째 실제 대본');
  for(const entry of project.production.versions){assert.equal('production'in entry,false);assert.equal('project'in entry,false);assert.equal('assets'in entry,false);}
  assert.doesNotThrow(()=>validateProject(project));
});

test('image versions retain actual old media across replacement and backup, restoring only the image leaves current captions/timing untouched',async()=>{
  const scene=createScene({id:'scene-version',imageId:'image-old',caption:'원래 자막',duration:4}),project=createProject({scenes:[scene]}),assets=new Map([image('image-old'),image('image-new')]);
  const entry=captureVersion(project,'image',{sceneId:scene.id});scene.imageId='image-new';scene.caption='새 자막';scene.duration=8;
  const canonical=validateProject(project);assert.ok(referencedAssetIds(canonical).has('image-old'));assert.equal(canonicalAssets(canonical,assets).length,2);
  const backup=await exportProjectBackup(canonical,assets),restored=await importProjectBackup(await backup.text());assert.deepEqual(await restored.assets.get('image-old').blob.arrayBuffer(),await assets.get('image-old').blob.arrayBuffer());
  restoreVersion(restored.project,entry,{assets:restored.assets});assert.equal(restored.project.scenes[0].imageId,'image-old');assert.equal(restored.project.scenes[0].caption,'새 자막');assert.equal(restored.project.scenes[0].duration,8);
  assert.throws(()=>restoreVersion(restored.project,entry,{assets:new Map()}),/실제 미디어/);
});

test('voice versions restore retained real audio/trim metadata while protecting BGM and invalidated speech captions',async()=>{
  const wav=await readFile(new URL('./fixtures/narration-test.wav',import.meta.url)),blob=new Blob([wav],{type:'audio/wav'}),project=createProject({audio:{narrationId:'voice-old',narrationStart:1,narrationEnd:4,narrationOffset:.5,bgmId:'bgm-stays'}}),assets=new Map([['voice-old',{blob,type:'audio/wav'}]]);
  const entry=captureVersion(project,'voice');project.audio.narrationId='voice-new';project.audio.narrationStart=0;project.audio.narrationEnd=null;project.captionMode='speech';project.captionAnalysis={narrationId:'voice-new'};project.captions=[{start:0,end:1,text:'다른 음성'}];
  restoreVersion(project,entry,{assets});assert.equal(project.audio.narrationId,'voice-old');assert.equal(project.audio.narrationStart,1);assert.equal(project.audio.narrationEnd,4);assert.equal(project.audio.narrationOffset,.5);assert.equal(project.audio.bgmId,'bgm-stays');assert.equal(project.captionMode,'auto');assert.deepEqual(project.captions,[]);
  const malicious={...entry,audio:{...entry.audio,bgmId:'must-not-overwrite'}};restoreVersion(project,malicious,{assets});assert.equal(project.audio.bgmId,'bgm-stays');
  assert.throws(()=>restoreVersion(project,{...entry,audio:{narrationStart:'not-a-time'}},{assets}),/구간 정보/);
});

test('only requested media is captured and an absent result never manufactures a history entry',()=>{
  const project=createProject();assert.equal(captureVersion(project,'script'),null);assert.equal(captureVersion(project,'image'),null);assert.equal(captureVersion(project,'voice'),null);assert.equal(project.production,undefined);
  assert.throws(()=>captureVersion(project,'unknown'),/종류/);
});
