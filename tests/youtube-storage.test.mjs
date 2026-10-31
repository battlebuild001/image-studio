import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve, sep} from 'node:path';
let chromium;
try {({chromium}=createRequire(import.meta.url)('playwright'));} catch {}

test('YouTube history purge atomically removes current/workspace/library receipts while preserving drafts, media and timestamps',{
  skip:!chromium||!existsSync('/usr/bin/chromium'),timeout:45000,
},async()=>{
  const root=resolve(fileURLToPath(new URL('../dist/',import.meta.url)));
  const server=createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>YouTube receipt storage</title>');return;}
    const path=resolve(root,`.${pathname}`);
    if(!path.startsWith(root+sep)||!/^\/[A-Za-z0-9_.-]+\.js$/u.test(pathname)){res.writeHead(404).end();return;}
    try{res.setHeader('Content-Type','text/javascript');res.end(await readFile(path));}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
  const page=await browser.newPage(),errors=[],external=[];
  page.on('pageerror',cause=>errors.push(cause.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).hostname!=='127.0.0.1'){external.push(route.request().url());return route.abort();}return route.continue();});
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const png=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url)),wav=await readFile(new URL('./fixtures/narration-test.wav',import.meta.url));
    const result=await page.evaluate(async fixture=>{
      const {openDatabase,transactionResult,createProject,createScene}=await import('/project.js');
      const {clearStoredYouTubeUploadHistory}=await import('/youtube-storage.js');
      const check=(value,message)=>{if(!value)throw Error(message);};
      const blob=(data,type)=>new Blob([Uint8Array.from(atob(data),character=>character.charCodeAt(0))],{type});
      const assets=[{id:'kept-image',blob:blob(fixture.png,'image/png'),name:'고정 이미지.png',extra:{note:'원본 미디어 메타데이터'}},{id:'kept-voice',blob:blob(fixture.wav,'audio/wav'),name:'원본 음성.wav'}];
      const draft={title:'보존할 업로드 제목',description:'사용자가 직접 작성한 설명입니다.',tags:['설명'],privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true};
      const record=n=>({videoId:`fixture000${n}`,videoUrl:`https://www.youtube.com/watch?v=fixture000${n}`,title:'이미 올린 영상',privacyStatus:'private',channelId:'UC'+'a'.repeat(22),channelTitle:'연결된 채널',uploadedAt:'2026-10-31T04:40:00.000Z',fileName:'완성 영상.webm',bytes:5678});
      const project=(id,count)=>createProject({id,title:'유지할 '+id,scenes:[createScene({id:'scene-'+id,imageId:'kept-image',duration:4,caption:'보존할 화면 자막'})],audio:{narrationId:'kept-voice'},scriptDraft:{draftScript:'그대로 유지할 대본'},production:{version:1,youtube:{draft:structuredClone(draft),uploads:Array.from({length:count},(_,index)=>record(index))},budget:{spentUsd:3,ledger:[]}},settings:{branding:false}});
      const current={project:project('current-project',1),savedAt:'2026-10-31T01:00:00.000Z',unrelated:{keep:'현재 기록'}},workspace={id:'workspace-one',project:project('workspace-project',2),assets:structuredClone(assets),createdAt:'2026-10-30T01:00:00.000Z',updatedAt:'2026-10-31T02:00:00.000Z',extra:['작업 탭 정보']},library={id:'library-project',project:project('library-project',3),assets:structuredClone(assets),updatedAt:'2026-10-31T03:00:00.000Z',extra:'보관함 정보'};
      const legacy={id:'legacy-workspace',project:createProject({id:'legacy-project',title:'유튜브 기록 없는 프로젝트'}),assets:[],updatedAt:'2026-10-31T00:00:00.000Z'};
      const libraryMeta={id:library.id,title:library.project.title,thumbnail:'local-thumbnail-reference',updatedAt:library.updatedAt};
      const workspaceMeta={version:1,activeId:workspace.id,tabs:[{id:workspace.id,name:'독립 탭',createdAt:workspace.createdAt,updatedAt:workspace.updatedAt}]};
      async function seed(){const db=await openDatabase(),tx=db.transaction(['projects','workspaces','library','assets','libraryMeta','workspaceMeta'],'readwrite'),done=transactionResult(tx,db);tx.objectStore('projects').put(current,'current');tx.objectStore('projects').put({project:null,unrelated:'no project here'},'unrelated');tx.objectStore('workspaces').put(workspace);tx.objectStore('workspaces').put(legacy);tx.objectStore('library').put(library);for(const asset of assets)tx.objectStore('assets').put(asset);tx.objectStore('libraryMeta').put(libraryMeta);tx.objectStore('workspaceMeta').put(workspaceMeta,'current');await done;}
      async function readAll(){const db=await openDatabase(),names=['projects','workspaces','library','assets','libraryMeta','workspaceMeta'],tx=db.transaction(names,'readonly'),done=transactionResult(tx,db),requests=names.map(name=>new Promise((resolve,reject)=>{const request=tx.objectStore(name).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);}));const values=await Promise.all(requests);await done;return Object.fromEntries(names.map((name,index)=>[name,values[index]]));}
      async function packed(value){if(value instanceof Blob)return{mime:value.type,bytes:[...new Uint8Array(await value.arrayBuffer())]};if(Array.isArray(value))return Promise.all(value.map(packed));if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await packed(item)])));return value;}
      await seed();const before=await packed(await readAll()),calls=[],updates=[];
      const nativeTransaction=IDBDatabase.prototype.transaction,nativeUpdate=IDBCursor.prototype.update;
      IDBDatabase.prototype.transaction=function(stores,mode,...rest){calls.push({stores:[...stores],mode});return nativeTransaction.call(this,stores,mode,...rest);};
      IDBCursor.prototype.update=function(value){updates.push(this.source.name);return nativeUpdate.call(this,value);};
      let removed;
      try{removed=await clearStoredYouTubeUploadHistory();}finally{IDBDatabase.prototype.transaction=nativeTransaction;IDBCursor.prototype.update=nativeUpdate;}
      check(removed===6,'Expected receipt copies removed from all three storage locations');
      check(calls.length===1&&JSON.stringify(calls[0])===JSON.stringify({stores:['projects','workspaces','library'],mode:'readwrite'}),'Purge must use one atomic readwrite transaction covering all three project stores');
      check(updates.length===3&&new Set(updates).size===3,'Only nonempty upload history records should be written');
      const after=await packed(await readAll()),expected=structuredClone(before);for(const name of ['projects','workspaces','library'])for(const value of expected[name])if(value.project?.production?.youtube?.uploads?.length)value.project.production.youtube.uploads=[];
      check(JSON.stringify(after)===JSON.stringify(expected),'Purge changed user drafts, scenes, assets, unrelated records or timestamps');
      const noopUpdates=[];IDBCursor.prototype.update=function(value){noopUpdates.push(this.source.name);return nativeUpdate.call(this,value);};
      let noop;try{noop=await clearStoredYouTubeUploadHistory();}finally{IDBCursor.prototype.update=nativeUpdate;}
      check(noop===0&&noopUpdates.length===0,'Repeated purge should be a no-op without writes');
      check(JSON.stringify(await packed(await readAll()))===JSON.stringify(after),'No-op purge changed storage');
      // Fail after a write was queued in another store; the transaction must roll everything back.
      await seed();const rollbackBefore=await packed(await readAll());let attempted=0,rejected=false;
      IDBCursor.prototype.update=function(value){attempted++;if(this.source.name==='workspaces')throw Error('Synthetic write failure');return nativeUpdate.call(this,value);};
      try{await clearStoredYouTubeUploadHistory();}catch{rejected=true;}finally{IDBCursor.prototype.update=nativeUpdate;}
      check(rejected&&attempted>=2,'Expected a synthetic write failure after another store update was queued');
      check(JSON.stringify(await packed(await readAll()))===JSON.stringify(rollbackBefore),'A failed purge must not leave partially removed history');
      check(await clearStoredYouTubeUploadHistory()===6,'A new explicit purge should still succeed after rollback');
      return{removed,noop,atomicRollback:true,transactions:calls,updatedStores:updates,retainedMedia:assets.length,legacyProjectUnchanged:true};
    },{png:png.toString('base64'),wav:wav.toString('base64')});
    assert.equal(result.removed,6);assert.equal(result.noop,0);assert.equal(result.atomicRollback,true);assert.equal(result.retainedMedia,2);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
