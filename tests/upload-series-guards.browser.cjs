const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),page=await browser.newPage();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  const projectSource=await fs.readFile(require('node:path').join(__dirname,'../dist/project.js'),'utf8');
  await page.route('**/project.js',route=>route.fulfill({contentType:'application/javascript',body:projectSource.replace('export async function loadLibraryProject(id) {','export async function loadLibraryProject(id) { if(globalThis.__seriesLibraryGate) await globalThis.__seriesLibraryGate;')}));
  await page.route(/https:\/\/(?:api\.openai\.com|accounts\.google\.com|www\.googleapis\.com)\//,route=>route.abort());
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:4173/',{waitUntil:'networkidle'});
  const imageBase64=(await fs.readFile(require('node:path').join(__dirname,'fixtures/image-test-1.png'))).toString('base64');
  await page.evaluate(async imageBase64=>{
   const {createProject,createScene}=await import('./project.js'),{youtubeExportSourceKey}=await import('./youtube-protocol.js'),{setupUploadSeries}=await import('./upload-series.js');
   const image=new Blob([Uint8Array.from(atob(imageBase64),x=>x.charCodeAt(0))],{type:'image/png'});
   const makeProject=id=>{const p=createProject({id,title:'시리즈',scenes:[createScene({imageId:'test-frame',duration:2,motion:'none',caption:'실제 자막'})]});const now=new Date().toISOString();p.production={version:1,uploadSeries:{version:1,sourceKey:youtubeExportSourceKey(p),baseTitle:'시리즈',targetSeconds:60,createdAt:now,updatedAt:now,privacyStatus:'private',selfDeclaredMadeForKids:false,containsSyntheticMedia:true,episodes:[{id:'part-001',start:0,end:2,title:'시리즈 | 제01화',description:'처음 설명',status:'planned'}]}};return p;};
   window.__seriesHarness=()=>{
    let project=makeProject('guard-'+Math.random().toString(36).slice(2)),session={connected:true,channelId:'UCabcdefghijklmnopqrstuv',channelTitle:'처음 채널'},listener,uploads=0,renders=0,resolveRender;
    const container=document.createElement('section');document.body.append(container);
    const api={container,getProject:()=>project,getAssets:()=>new Map([['test-frame',{blob:image,name:'장면.png'}]]),getWorkspaceId:()=>null,mutateProductionMetadata:fn=>fn(project),persist:async()=>{},setUploadBatchBusy:()=>{},youtubeClient:{getSession:()=>session,getUploadState:()=>({available:false,paused:false}),subscribe:fn=>{listener=fn;return()=>{};},uploadVideo:async()=>{uploads++;throw new Error('실제 업로드를 호출하면 안 돼요.');}},renderUploadProject:options=>{renders++;return new Promise((resolve,reject)=>{resolveRender=()=>resolve({blob:new Blob(['synthetic video'],{type:'video/mp4'}),extension:'mp4'});options.signal.addEventListener('abort',()=>reject(new DOMException('중지','AbortError')),{once:true});});}};
    const feature=setupUploadSeries(api);
    return {feature,container,getProject:()=>project,getCounts:()=>({uploads,renders}),makeProject,changeProject:value=>{project=value;},changeChannel:(id,emit=true)=>{session={...session,channelId:id};if(emit)listener({type:'connected'});},resolveRender:()=>resolveRender?.(),click:id=>container.querySelector('#'+id).dispatchEvent(new Event('click'))};
   };
  },imageBase64);
  const recovery=await page.evaluate(async()=>{
   const h=__seriesHarness();window.__seriesLibraryGate=new Promise(resolve=>window.__releaseSeriesLibrary=resolve);
   const episode=h.getProject().production.uploadSeries.episodes[0];Object.assign(episode,{status:'uploading',projectId:'missing-series-episode',attemptAt:new Date().toISOString()});h.feature.render();h.feature.onOpen();
   const blocked=h.container.querySelector('#runUploadSeriesBtn').disabled;h.click('runUploadSeriesBtn');await Promise.resolve();const counts=h.getCounts();
   episode.status='uploaded';episode.description='복구 도중 사용자가 수정한 설명';h.feature.render();__releaseSeriesLibrary();window.__seriesLibraryGate=null;await new Promise(resolve=>setTimeout(resolve,100));
   const result={blocked,counts,status:h.getProject().production.uploadSeries.episodes[0].status,description:h.getProject().production.uploadSeries.episodes[0].description};h.feature.dispose();h.container.remove();return result;
  });
  assert.equal(recovery.blocked,true);assert.deepEqual(recovery.counts,{uploads:0,renders:0});assert.equal(recovery.status,'uploaded');assert.equal(recovery.description,'복구 도중 사용자가 수정한 설명');
  console.log('PASS persisted uploading is blocked before async recovery; late recovery cannot overwrite newer queue status/metadata');
  async function begin(){await page.evaluate(()=>{window.__guard=__seriesHarness();__guard.click('runUploadSeriesBtn');});await page.waitForFunction(()=>__guard.getCounts().renders===1);}
  await begin();const switched=await page.evaluate(async()=>{__guard.changeChannel('UCzyxwvutsrqponmlkjihgfe');await new Promise(resolve=>setTimeout(resolve,20));const result={...__guard.getCounts(),busy:__guard.feature.getBusy(),status:__guard.getProject().production.uploadSeries.episodes[0].status};__guard.feature.dispose();__guard.container.remove();return result;});assert.equal(switched.uploads,0);assert.equal(switched.busy,false);assert.equal(switched.status,'ready');
  await begin();const silent=await page.evaluate(async()=>{__guard.changeChannel('UCzyxwvutsrqponmlkjihgfe',false);__guard.resolveRender();await new Promise(resolve=>setTimeout(resolve,50));const result={...__guard.getCounts(),busy:__guard.feature.getBusy(),status:__guard.getProject().production.uploadSeries.episodes[0].status};__guard.feature.dispose();__guard.container.remove();return result;});assert.equal(silent.uploads,0);assert.equal(silent.busy,false);assert.equal(silent.status,'error');
  console.log('PASS account change during render cancels safely, and a silent channel change is rejected again before any upload initialization');
  await begin();const scoped=await page.evaluate(async()=>{const other=__guard.makeProject('other-owner');other.production.uploadSeries.episodes[0].description='다른 프로젝트 유지';__guard.changeProject(other);__guard.feature.render();await new Promise(resolve=>setTimeout(resolve,20));const result={...__guard.getCounts(),busy:__guard.feature.getBusy(),status:other.production.uploadSeries.episodes[0].status,description:other.production.uploadSeries.episodes[0].description};__guard.feature.dispose();__guard.container.remove();return result;});assert.equal(scoped.uploads,0);assert.equal(scoped.busy,false);assert.equal(scoped.status,'planned');assert.equal(scoped.description,'다른 프로젝트 유지');
  console.log('PASS forced owner change while rendering cannot mutate another project with the same episode identifier');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
