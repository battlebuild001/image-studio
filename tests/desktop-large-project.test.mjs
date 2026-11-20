import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject,createScene,validateProject,referencedAssetIds,exportProjectBackup,importProjectBackup,MAX_ASSET_COUNT,MAX_ASSET_BYTES,MAX_BACKUP_BYTES} from '../dist/project.js';
import {captureVersion} from '../dist/production-history.js';

const require=createRequire(import.meta.url);
const native=require('../desktop/files.cjs');
const digest=async blob=>createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
async function fixture(){
 const pictures=await Promise.all(['image-test-1.png','image-test-2.png'].map(name=>readFile(new URL('./fixtures/'+name,import.meta.url))));
 const voice=await readFile(new URL('./fixtures/narration-test.wav',import.meta.url)),music=await readFile(new URL('./fixtures/bgm-test.wav',import.meta.url));
 const project=createProject({title:'200장면과 보관한 원본',scenes:Array.from({length:200},(_,index)=>createScene({id:'scene-'+index,imageId:'image-'+index,caption:'장면 '+index,duration:1})),imageStudio:{references:Array.from({length:5},(_,index)=>({assetId:'reference-'+index,label:'레퍼런스 '+index,role:'concept',enabled:true}))},audio:{narrationId:'narration',bgmId:'music'}});
 project.scenes[0].imageId='retained-original-image';captureVersion(project,'image',{sceneId:project.scenes[0].id});project.scenes[0].imageId='image-0';
 const checked=validateProject(project),assets=new Map([...referencedAssetIds(checked)].map((id,index)=>[id,{name:id+(id==='narration'||id==='music'?'.wav':'.png'),blob:new Blob([id==='narration'?voice:id==='music'?music:pictures[index%2]],{type:id==='narration'||id==='music'?'audio/wav':'image/png'})}]));
 assert.equal(assets.size,208);return{project:checked,assets};
}
async function sameMedia(expected,actual){
 assert.deepEqual([...actual.keys()].sort(),[...expected.keys()].sort());
 for(const[id,asset]of expected){assert.equal(actual.get(id).name,asset.name);assert.equal(actual.get(id).blob.type,asset.blob.type);assert.equal(await digest(actual.get(id).blob),await digest(asset.blob));}
}

test('large project backup retains 200 scenes, five references, narration, BGM and a historic image byte for byte',async()=>{
 const source=await fixture(),backup=await exportProjectBackup(source.project,source.assets),restored=await importProjectBackup(backup);
 assert.deepEqual(restored.project,source.project);await sameMedia(source.assets,restored.assets);
 assert.equal(MAX_ASSET_COUNT,2000);assert.equal(native.MAX_ASSET_COUNT,MAX_ASSET_COUNT);assert.equal(native.MAX_MEDIA_BYTES,MAX_ASSET_BYTES);assert.equal(native.MAX_BACKUP_BYTES,MAX_BACKUP_BYTES);
});

test('native folder saving and reopening preserves every large-project original and rejects 2001-entry manifests',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'content-studio-large-project-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const source=await fixture(),backup=await exportProjectBackup(source.project,source.assets);
 let selected=directory;
 const dialog={showOpenDialog:async()=>({canceled:false,filePaths:[selected]}),showMessageBox:async()=>({response:0})};
 const files=native.createProjectFileStore({dialog,defaultDirectory:directory});
 const saved=await files.saveProjectBundle({backupText:await backup.text(),suggestedName:'대형 프로젝트'});assert.equal(saved.cancelled,false);
 selected=join(directory,'project.json');const opened=await files.openProjectBundle(),restored=await importProjectBackup(opened.backupText);
 assert.deepEqual(restored.project,source.project);await sameMedia(source.assets,restored.assets);
 const manifest=JSON.parse(await readFile(selected,'utf8'));assert.equal(manifest.assets.length,208);
 manifest.assets=Array.from({length:MAX_ASSET_COUNT+1},()=>manifest.assets[0]);await writeFile(selected,JSON.stringify(manifest));
 await assert.rejects(files.openProjectBundle(),cause=>cause.code==='DESKTOP_PROJECT_INVALID');
});

test('portable imports reject 2001 records before decoding data while preserving duplicate-ID and byte limits',async()=>{
 const project=createProject(),entry={id:'same',name:'tiny.png',type:'image/png',data:'eA=='};
 await assert.rejects(importProjectBackup({kind:'bth-image-studio',version:1,project,assets:Array.from({length:MAX_ASSET_COUNT+1},()=>entry)}),/미디어 목록/u);
 await assert.rejects(importProjectBackup({kind:'bth-image-studio',version:1,project,assets:[entry,entry]}),/중복/u);
 assert.equal(MAX_ASSET_BYTES,180*1024*1024);assert.equal(MAX_BACKUP_BYTES,250*1024*1024);
});
