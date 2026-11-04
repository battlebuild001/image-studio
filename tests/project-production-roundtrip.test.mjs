import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {createProject,validateProject,exportProjectBackup,importProjectBackup,referencedAssetIds,canonicalAssets} from '../dist/project.js';
import {normalizeProductionState} from '../dist/production-state.js';
import {normalizeVoicePreferences,voiceTextKey,voiceSettingsKey} from '../dist/voice-preferences-protocol.js';
import {buildDramaSeriesPlan} from '../dist/short-series-protocol.js';
const preferences=normalizeVoicePreferences({provider:'typecast',speaker:'tc_fixture',model:'ssfm-v31',tempo:1.2,pitch:2,volume:90,emotionType:'preset',emotion:'sad',emotionIntensity:1.5,paragraphPauseSeconds:.4,paragraphPauses:[{afterParagraph:1,seconds:.7}]});
const sample={assetId:'preview-audio',name:'보관한 샘플.wav',textKey:voiceTextKey('첫 단락.\n\n둘째 단락.'),settingsKey:voiceSettingsKey(preferences),createdAt:'2026-11-04T12:00:00.000Z',duration:4,settings:preferences};
test('unapplied voice previews remain actual typed audio assets in portable projects alongside per-project settings',async()=>{
 const bytes=await readFile(new URL('./fixtures/narration-test.wav',import.meta.url)),blob=new Blob([bytes],{type:'audio/wav'});
 const project=validateProject(createProject({title:'기본 설정만 있는 프로젝트',settings:{aiImageNotice:true,aiImageNoticePosition:'bottom-right'},production:{version:1,speech:{voicePreferences:preferences,voiceSamples:[sample],voiceDraft:{text:'첫 단락.\n\n둘째 단락.',baseScriptKey:voiceTextKey('')}},youtube:{sourceNotes:'사용자가 입력한 외부 영상 대본'}}}));
 const assets=new Map([['preview-audio',{blob,name:sample.name}]]);
 assert.equal(project.audio.narrationId,null);assert.ok(referencedAssetIds(project).has('preview-audio'));assert.equal(canonicalAssets(project,assets)[0].type,'audio/wav');
 const restored=await importProjectBackup(await exportProjectBackup(project,assets));
 assert.deepEqual(restored.project.production,project.production);assert.equal(restored.assets.get('preview-audio').blob.size,bytes.length);assert.equal(restored.project.settings.aiImageNoticePosition,'bottom-right');
 assert.throws(()=>canonicalAssets(project,new Map()),/필요한/);
});
test('voice preference/sample/draft hydration rejects secret fields, duplicate identities and invalid pauses before UI use',()=>{
 for(const speech of [
  {voicePreferences:{...preferences,apiKey:'do-not-store'}},
  {voicePreferences:{...preferences,paragraphPauseSeconds:11}},
  {voiceSamples:[sample,sample]},
  {voiceSamples:[{...sample,assetId:'bad/id'}]},
  {voiceSamples:[{...sample,settings:{...preferences,accessToken:'do-not-store'}}]},
  {voiceDraft:{text:'대본',baseScriptKey:'key',rawProviderResponse:{}}},
  {voiceDraft:{text:'가'.repeat(30001),baseScriptKey:'key'}},
 ])assert.throws(()=>normalizeProductionState({version:1,speech}));
});
test('drama plan and ordered queue metadata survive portable validation without embedding queued media or OAuth state',()=>{
 const plan=buildDramaSeriesPlan({durationSeconds:125,targetSeconds:60,captions:[{start:0,end:61,text:'첫 이야기'},{start:61,end:118,text:'두 번째 이야기'}],title:'전체 이야기',sourceKey:'render-fixture'});
 const queue={version:1,sourceKey:plan.sourceKey,baseTitle:plan.baseTitle,targetSeconds:plan.targetSeconds,createdAt:plan.createdAt,updatedAt:plan.createdAt,privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true,episodes:plan.parts.map(part=>({id:part.id,start:part.start,end:part.end,title:part.title,description:part.label,status:'planned'}))};
 const project=validateProject(createProject({production:{version:1,shorts:{mode:'drama',targetSeconds:60,dramaTargetSeconds:60,dramaPlan:plan},uploadSeries:queue}}));
 assert.equal(project.production.uploadSeries.episodes.length,plan.parts.length);assert.equal(plan.parts[0].start,0);assert.equal(plan.parts.at(-1).end,125);assert.deepEqual([...referencedAssetIds(project)],[]);
 for(const extra of [{uploadUri:'https://www.googleapis.com/upload?upload_id=secret'},{accessToken:'secret'},{blob:new Blob(['not-portable'])}])assert.throws(()=>normalizeProductionState({version:1,uploadSeries:{...queue,...extra}}));
});
