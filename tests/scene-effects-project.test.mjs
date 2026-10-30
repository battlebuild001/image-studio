import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createProject,createScene,validateProject,updateScenes,duplicateScenes,splitScene,mergeScenes,getTimeline,exportProjectBackup,importProjectBackup} from '../dist/project.js';

const effectFields = scene => ({motion:scene.motion,effect:scene.effect,effectIntensity:scene.effectIntensity});
const bytes = new Uint8Array(await readFile(new URL('./fixtures/image-test-1.png',import.meta.url)));
const media = () => new Map([['shared-image',{blob:new Blob([bytes],{type:'image/png'}),name:'synthetic-shared.png',type:'image/png'}]]);

test('legacy scenes keep their camera defaults and receive no visible effect',()=>{
 const scene={id:'legacy',duration:7.5,caption:'원래 장면입니다.',imageId:'shared-image',motion:'pan-left',fit:'contain'};
 const source=createProject({scenes:[scene]}),before=structuredClone(source);
 const canonical=validateProject(source);
 assert.equal(canonical.schemaVersion,1);assert.equal(canonical.scenes[0].motion,'pan-left');assert.equal(canonical.scenes[0].fit,'contain');
 assert.equal(canonical.scenes[0].effect,'none');assert.equal(canonical.scenes[0].effectIntensity,.25);assert.equal(canonical.scenes[0].duration,7.5);assert.equal(canonical.scenes[0].caption,scene.caption);
 assert.deepEqual(source,before);assert.equal(Object.hasOwn(scene,'effect'),false);
 assert.equal(createScene().motion,'zoom-in');assert.equal(createScene().effect,'none');assert.equal(createScene().effectIntensity,.25);
});

test('gentle motion and each effect are bounded canonical per-scene settings with zero intensity preserved',()=>{
 for(const motion of ['subtle-zoom','subtle-drift'])for(const effect of ['none','dust','fog','light'])for(const effectIntensity of [0,.25,1]){
  const scene=createScene({id:'gentle',imageId:'shared-image',duration:5.25,motion,effect,effectIntensity});
  const result=validateProject(createProject({scenes:[scene]}));assert.deepEqual(effectFields(result.scenes[0]),{motion,effect,effectIntensity});
  assert.deepEqual(effectFields(getTimeline(result).scenes[0]),{motion,effect,effectIntensity});
 }
});

test('invalid effects or strengths fail without partially changing the caller or scene patch',()=>{
 const source=createProject({scenes:[createScene({id:'one',motion:'subtle-zoom',effect:'fog',effectIntensity:.35}),createScene({id:'two',effect:'light'})]});const before=structuredClone(source);
 for(const effect of ['rain','unknown','url(secret)',true,4,{},[]]){
  assert.throws(()=>validateProject({...source,scenes:[{...source.scenes[0],effect}]}),/장면 효과/);
  assert.throws(()=>updateScenes(source,['one'],{effect}),/장면 효과/);
 }
 for(const effectIntensity of [-.01,1.01,NaN,Infinity,'0.5',true,{},[]]){
  assert.throws(()=>validateProject({...source,scenes:[{...source.scenes[0],effectIntensity}]}),/효과 강도/);
  assert.throws(()=>updateScenes(source,['one'],{effectIntensity}),/효과 강도/);
 }
 assert.throws(()=>updateScenes(source,['one'],{effect:'dust',effectIntensity:2}),/효과 강도/);
 assert.throws(()=>updateScenes(source,['one'],{effect:'dust',effectSeed:'unreviewed-extra-field'}),/적용할 설정/);
 assert.deepEqual(source,before);
});

test('bulk updates preserve durations, captions and unselected scenes while enabling copied image effects',()=>{
 const source=validateProject(createProject({scenes:[createScene({id:'one',imageId:'shared-image',duration:3,caption:'첫 장면',motion:'subtle-zoom',effect:'dust',effectIntensity:.4}),createScene({id:'two',imageId:'shared-image',duration:6,caption:'둘째 장면',effect:'fog',effectIntensity:.2}),createScene({id:'three',duration:2,caption:'선택하지 않음',effect:'none'})]}));const before=structuredClone(source);
 const patch=effectFields(source.scenes[0]);const changed=updateScenes(source,['two'],patch);
 assert.deepEqual(effectFields(changed.scenes[1]),patch);assert.deepEqual(changed.scenes[0],source.scenes[0]);assert.deepEqual(changed.scenes[2],source.scenes[2]);
 assert.equal(changed.scenes[1].id,'two');assert.equal(changed.scenes[1].duration,6);assert.equal(changed.scenes[1].caption,'둘째 장면');assert.equal(changed.scenes[1].imageId,'shared-image');assert.deepEqual(source,before);
});

test('duplicate, split and merge retain chosen effects and all timed captions without altering total duration',()=>{
 const scene=createScene({id:'scene-one',imageId:'shared-image',duration:9.75,caption:'첫 번째 문장을 읽고 다음 🛰️ 문장으로 이어갑니다.',motion:'subtle-drift',effect:'light',effectIntensity:.32});
 const source=validateProject(createProject({scenes:[scene],captionMode:'srt',captions:[{start:.1,end:9.5,text:'별도로 맞춘 시간 자막'}]}));const before=structuredClone(source);
 const duplicate=duplicateScenes(source,['scene-one']);assert.equal(duplicate.scenes.length,2);assert.notEqual(duplicate.scenes[0].id,duplicate.scenes[1].id);assert.deepEqual(effectFields(duplicate.scenes[1]),effectFields(source.scenes[0]));assert.equal(duplicate.scenes[1].imageId,'shared-image');
 const divided=splitScene(source,'scene-one',3.25);assert.equal(divided.scenes.length,2);assert.equal(getTimeline(divided).duration,9.75);assert.equal(divided.scenes[0].caption+divided.scenes[1].caption,scene.caption);
 for(const child of divided.scenes){assert.deepEqual(effectFields(child),effectFields(source.scenes[0]));assert.equal(child.imageId,'shared-image');}assert.deepEqual(divided.captions,source.captions);
 const merged=mergeScenes(divided,divided.scenes.map(s=>s.id));assert.equal(merged.scenes.length,1);assert.equal(merged.scenes[0].duration,9.75);assert.deepEqual(effectFields(merged.scenes[0]),effectFields(source.scenes[0]));assert.deepEqual(merged.captions,source.captions);
 const unequal=updateScenes(divided,[divided.scenes[1].id],{effect:'fog',effectIntensity:.8});const firstWins=mergeScenes(unequal,unequal.scenes.map(s=>s.id));assert.deepEqual(effectFields(firstWins.scenes[0]),effectFields(source.scenes[0]),'merge uses its documented first-scene settings');
 assert.deepEqual(validateProject(structuredClone(before)),before,'an undo snapshot restores exact camera and effect choices');assert.deepEqual(source,before);
});

test('schema-one backups roundtrip actual shared image bytes, gentle motion, effects and existing media references',async()=>{
 for(const effect of ['dust','fog','light']){
  const original=validateProject(createProject({scenes:[createScene({id:'one',imageId:'shared-image',duration:4.25,caption:'자료를 읽습니다.',motion:'subtle-zoom',effect,effectIntensity:.41}),createScene({id:'two',imageId:'shared-image',duration:5.5,caption:'다음 장면',motion:'subtle-drift',effect:'none',effectIntensity:0})],captionMode:'srt',captions:[{start:.25,end:8.5,text:'정확한 자막 시간'}]}));
  const blob=await exportProjectBackup(original,media()),serialized=JSON.parse(await blob.text()),loaded=await importProjectBackup(blob);
  assert.equal(serialized.project.schemaVersion,1);assert.equal(serialized.assets.length,1,'shared source image is not duplicated');assert.deepEqual(loaded.project,original);assert.deepEqual(new Uint8Array(await loaded.assets.get('shared-image').blob.arrayBuffer()),bytes);
  assert.equal(getTimeline(loaded.project).duration,9.75);assert.equal(loaded.project.scenes[1].effectIntensity,0);assert.deepEqual(loaded.project.captions,original.captions);
 }
});
