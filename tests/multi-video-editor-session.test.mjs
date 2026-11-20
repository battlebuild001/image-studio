import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProject,createScene} from '../dist/project.js';
import {youtubeExportSourceKey} from '../dist/youtube-protocol.js';
import {createMultiVideoEditorSession} from '../dist/multi-video-editor-session.js';

test('full-editor saves retain all project fields and original media with serial ownership tokens',async()=>{
 const project=createProject({id:'job-project',scenes:[createScene({imageId:'picture',duration:2})]}),assets=new Map([['picture',{blob:new Blob(['original pixels'],{type:'image/png'}),name:'reference.png'}]]);
 project.settings.introFadeIn=true;project.scenePlan=undefined;
 let token='original',saved;const engine={async replaceSnapshot(id,input){assert.equal(id,'job');assert.equal(input.expectedToken,token);saved=input;return{token:token==='original'?(token='second'):(token='third')};}};
 const session=createMultiVideoEditorSession({engine,jobId:'job',snapshot:{project,assets,token}});
 await session.save(project,assets);assert.deepEqual(saved.project,project);assert.equal(await saved.assets.get('picture').blob.text(),'original pixels');
 await session.save({...project,title:'편집 제목'},assets);assert.equal(session.token,'third');assert.equal(saved.project.settings.introFadeIn,true);
});
test('derived shorts and restoring the original workspace never replace the parent queue video',async()=>{
 const project=createProject({id:'source-project'}),derived={...project,id:'derived-short'},calls=[],engine={async replaceSnapshot(){throw new Error('parent must not be overwritten');}};
 const session=createMultiVideoEditorSession({engine,jobId:'source-job',snapshot:{project,token:'v1'},saveDerived:async(p,a)=>calls.push({p,a})});
 const media=new Map();await session.save(derived,media);assert.equal(calls.length,1);assert.equal(calls[0].p.id,'derived-short');assert.equal(session.token,'v1');
 session.restoring=true;await session.save(project,media);assert.equal(calls.length,1);
});
test('failed saves preserve the retry token and stale exported bytes are never accepted as the current edit',async()=>{
 const project=createProject({id:'source-project'}),media=new Map();let fail=true,input;
 const session=createMultiVideoEditorSession({engine:{async replaceSnapshot(id,value){input=value;assert.equal(value.expectedToken,'v1');if(fail)throw new Error('quota');return{token:'v2'};}},jobId:'job',snapshot:{project,token:'v1'}});
 const video={blob:new Blob(['encoded video'],{type:'video/mp4'}),extension:'mp4',projectId:project.id,sourceKey:youtubeExportSourceKey(project)};
 await assert.rejects(session.save(project,media,video),/quota/);assert.equal(session.token,'v1');assert.equal(input.video.blob,video.blob);
 fail=false;await session.save({...project,title:'changed content'},media,video);assert.equal(input.video,undefined);assert.equal(session.token,'v2');
});
