const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');

// Real upload UI, PNG rendering, IndexedDB, client status transport; synthetic bytes and replies only.
(async()=>{
 const base=process.env.STUDIO_URL||'http://127.0.0.1:4173/',browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[],external=[];
 page.setDefaultTimeout(20000);page.on('pageerror',cause=>errors.push(cause.message));
 await page.route('https://**/*',route=>{external.push(route.request().url());return route.abort();});
 const png=(await fs.readFile(path.join(__dirname,'fixtures','image-test-1.png'))).toString('base64');
 async function setup({fresh=false,scheduled=false,privateDraft=false,baseOnly=false}={}){
  await page.goto(new URL('youtube-privacy.html',base).href);
  await page.evaluate(async({png,fresh,scheduled,privateDraft,baseOnly})=>{
   const [{createProject,createScene,validateProject,saveProject,loadProject},{manualPublishingDraft},{deliverySourceKey},{setupYouTubeStudio},{createYouTubeClient},{youtubeExportSourceKey,normalizeYouTubeUploadDraft}]=await Promise.all([import('./project.js'),import('./production-publishing.js'),import('./production-delivery-utils.js'),import('./youtube-studio.js'),import('./youtube-client.js'),import('./youtube-protocol.js')]);
   document.body.replaceChildren();const mount=document.createElement('main');mount.style.cssText='max-width:1080px;margin:auto;padding:24px';document.body.append(mount);
   let saved=fresh?null:await loadProject(),project,assets;
   if(saved){project=saved.project;assets=saved.assets;}else{
    project=validateProject(createProject({id:scheduled?'scheduled-required':'required-thumbnail',title:'워해머 룰 설명',scenes:[createScene({id:'first',imageId:'image-a',duration:3,motion:'none',caption:'워해머 전장에서 이동 규칙을 설명합니다.'})],settings:{branding:false,transition:0}}));
    assets=new Map([['image-a',{name:'synthetic.png',blob:new Blob([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],{type:'image/png'})}]]);
    project.production={version:1,description:{length:'short',support:false,hashtags:false,channelIntro:false}};project.production.publishing={result:manualPublishingDraft(project),sourceKey:deliverySourceKey(project),selectedTitle:0};
    if(privateDraft)project.production.youtube={draft:normalizeYouTubeUploadDraft({title:project.title,privacyStatus:'private'})};
    await saveProject(project,assets);
   }
   const key='synthetic-required-remote';let remote=JSON.parse(sessionStorage.getItem(key)||'null')||{calls:[],status:{},next:0,thumbnailFail:true,publishFail:true};if(fresh){remote={calls:[],status:{},next:0,thumbnailFail:!scheduled&&!privateDraft,publishFail:!scheduled&&!privateDraft};sessionStorage.setItem(key,JSON.stringify(remote));}
   const fixture={project,assets,remote,persistFail:false,exported:fresh?{projectId:project.id,workspaceId:null,sourceKey:youtubeExportSourceKey(project),blob:new Blob([new Uint8Array(32)],{type:'video/webm'}),name:'synthetic.webm'}:null};window.fixture=fixture;
   const CHANNEL='UC'+'a'.repeat(22),reply=(body,status=200)=>Response.json(body,{status}),saveRemote=()=>sessionStorage.setItem(key,JSON.stringify(remote));
   const client=createYouTubeClient({storage:localStorage,loadIdentity:()=>({initTokenClient(config){return{requestAccessToken(){queueMicrotask(()=>config.callback({access_token:'synthetic-required-token',expires_in:3600,scope:config.scope}));}};}}),fetchImpl:async(url,input)=>{
    const u=new URL(url),call={path:u.pathname,method:input.method,query:u.search,body:typeof input.body==='string'?JSON.parse(input.body):null};remote.calls.push(call);saveRemote();
    if(u.pathname==='/youtube/v3/channels')return reply({items:[{id:CHANNEL,snippet:{title:'필수 썸네일 합성 채널'}}]});
    if(u.pathname==='/upload/youtube/v3/videos'){
     if(input.method==='POST'){const id='required'+String(++remote.next).padStart(3,'0');remote.status[id]={privacyStatus:input.body?JSON.parse(input.body).status.privacyStatus:'private',title:JSON.parse(input.body).snippet.title};saveRemote();return new Response(null,{headers:{Location:'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id='+id}});}
     const id=u.searchParams.get('upload_id'),data=remote.status[id];return reply({id,snippet:{channelId:CHANNEL,title:data.title},status:{privacyStatus:data.privacyStatus}});
    }
    if(u.pathname==='/upload/youtube/v3/thumbnails/set'){if(remote.thumbnailFail){remote.thumbnailFail=false;saveRemote();return reply({error:{errors:[{reason:'forbidden'}]}},403);}return reply({kind:'youtube#thumbnailSetResponse',items:[{}]});}
    if(u.pathname==='/youtube/v3/videos'){
     if(input.method==='GET'){const id=u.searchParams.get('id');return reply({items:[{id,snippet:{channelId:CHANNEL},status:remote.status[id]}]});}
     const body=JSON.parse(input.body);remote.status[body.id]={...remote.status[body.id],...body.status};saveRemote();if(remote.publishFail){remote.publishFail=false;saveRemote();throw TypeError('Synthetic lost final publication response');}return reply({id:body.id,status:remote.status[body.id]});
    }
    throw Error('Unexpected synthetic request '+u.pathname);
   }});client.saveClientId('123456789012-requiredthumb.apps.googleusercontent.com');fixture.client=client;
   let studio;const api={container:mount,youtubeClient:client,getProject:()=>project,getAssets:()=>assets,getWorkspaceId:()=>null,canMutate:()=>true,getExportedVideo:()=>fixture.exported,mutateProductionMetadata:fn=>{fn(project);project=validateProject(project);fixture.project=project;studio?.render();},persist:async()=>{if(fixture.persistFail)throw Error('Synthetic disk failure');await saveProject(project,assets);},clearYouTubeStoredHistory:async()=>{if(project.production.youtube)delete project.production.youtube.uploads;await saveProject(project,assets);}};
   studio=setupYouTubeStudio(api);fixture.studio=studio;fixture.connect=async()=>{await client.prepareIdentity();await client.connect({publicationAccess:!baseOnly});studio.render();};await fixture.connect();
  },{png,fresh,scheduled,privateDraft,baseOnly});
 }
 async function state(){return page.evaluate(()=>structuredClone(window.fixture.project));}
 const uploadPosts=()=>page.evaluate(()=>fixture.remote.calls.filter(call=>call.method==='POST'&&call.path==='/upload/youtube/v3/videos').length);
 async function choose(){await page.locator('#youtubeThumbnailSelect').selectOption('0');await page.waitForFunction(()=>document.querySelector('#youtubeThumbnailPreview').src&&!document.querySelector('#youtubeThumbnailSelect').disabled);}
 async function inputMetadata(){await page.locator('#youtubeTitle').fill('검토한 워해머 이동 룰');await page.locator('#youtubeDescription').fill('워해머 게임의 이동 규칙을 설명합니다.');await page.locator('#saveYouTubeDraftBtn').click();}
 try{
  await setup({fresh:true});assert.equal(await page.locator('#youtubePrivacy').inputValue(),'public');assert.equal(await page.locator('#skipYouTubeThumbnailBtn').count(),0);await inputMetadata();assert.equal(await page.locator('#uploadYouTubeBtn').isDisabled(),true);assert.equal(await page.locator('#armYouTubeAutoBtn').isDisabled(),true);assert.equal(await uploadPosts(),0);
  // Even dispatched clicks cannot bypass validation in the transmission path.
  await page.locator('#uploadYouTubeBtn').dispatchEvent('click');await page.waitForTimeout(100);assert.equal(await uploadPosts(),0);
  await choose();assert.equal(await page.locator('#uploadYouTubeBtn').isEnabled(),true);await page.locator('#uploadYouTubeBtn').click();await page.waitForFunction(()=>fixture.project.production.youtube.uploads?.[0]?.thumbnailStatus==='pending'&&!fixture.studio.getUploadBusy());
  let p=await state(),record=p.production.youtube.uploads[0];assert.equal(record.privacyStatus,'private');assert.equal(record.intendedPrivacyStatus,'public');assert.equal(record.publicationStatus,'pending');assert.equal(await uploadPosts(),1);assert.equal(await page.locator('#uploadYouTubeBtn').isDisabled(),true);assert.equal(await page.evaluate(()=>fixture.remote.calls.some(call=>call.path==='/youtube/v3/videos')),false);
  console.log('PASS mandatory real PNG and missing-thumbnail dispatch guard; failed thumbnail leaves one durable private video');
  await setup();assert.equal(await page.locator('#youtubeThumbnailPending').isVisible(),true);assert.equal(await page.locator('#retryYouTubeThumbnailBtn').isDisabled(),true);await choose();await page.locator('#retryYouTubeThumbnailBtn').click();await page.waitForFunction(()=>fixture.project.production.youtube.uploads[0].thumbnailStatus==='uploaded'&&!fixture.studio.getUploadBusy());
  record=(await state()).production.youtube.uploads[0];assert.equal(record.publicationStatus,'pending');assert.equal(await uploadPosts(),1);assert.equal(await page.evaluate(()=>fixture.remote.calls.filter(call=>call.path==='/youtube/v3/videos'&&call.method==='PUT').length),1);
  await setup();assert.equal(await page.locator('#youtubeThumbnailPreview').isVisible(),false);assert.equal(await page.locator('#retryYouTubeThumbnailBtn').isEnabled(),true);await page.locator('#retryYouTubeThumbnailBtn').click();await page.waitForFunction(()=>fixture.project.production.youtube.uploads[0].publicationStatus==='completed'&&!fixture.studio.getUploadBusy());record=(await state()).production.youtube.uploads[0];assert.equal(record.privacyStatus,'public');assert.equal(await uploadPosts(),1);assert.equal(await page.evaluate(()=>fixture.remote.calls.filter(call=>call.path==='/upload/youtube/v3/thumbnails/set').length),2);assert.equal(await page.evaluate(()=>fixture.remote.calls.filter(call=>call.path==='/youtube/v3/videos'&&call.method==='PUT').length),1);assert.equal(await page.locator('#youtubeThumbnailPending').isVisible(),false);
  console.log('PASS reload restores pending thumbnail/publication; status-only retry confirms accepted publication without duplicate media, thumbnail, or PUT');
  await setup({fresh:true,scheduled:true});await inputMetadata();await choose();await page.locator('#youtubeScheduleEnabled').check();await page.locator('#youtubePublishAtLocal').fill('2027-01-01T12:00');await page.locator('#saveYouTubeDraftBtn').click();await page.locator('#uploadYouTubeBtn').click();await page.waitForFunction(()=>fixture.project.production.youtube.uploads?.[0]?.publicationStatus==='completed'&&!fixture.studio.getUploadBusy());record=(await state()).production.youtube.uploads[0];assert.equal(record.privacyStatus,'private');assert.equal(record.scheduleConfirmed,true);assert.equal(record.publishAt,'2027-01-01T03:00:00.000Z');let calls=await page.evaluate(()=>fixture.remote.calls);const start=calls.find(call=>call.path==='/upload/youtube/v3/videos'&&call.method==='POST'),pub=calls.find(call=>call.path==='/youtube/v3/videos'&&call.method==='PUT');assert.equal(start.body.status.publishAt,undefined);assert.equal(pub.body.status.publishAt,record.publishAt);assert.ok(calls.findIndex(call=>call.path.includes('thumbnails'))<calls.indexOf(pub));
  console.log('PASS scheduling is applied only after required thumbnail, with original timezone and private status preserved');
  await setup({fresh:true,privateDraft:true,baseOnly:true});assert.equal(await page.locator('#youtubePrivacy').inputValue(),'private');await inputMetadata();await choose();await page.locator('#armYouTubeAutoBtn').click();await page.evaluate(async()=>{const {youtubeExportSourceKey}=await import('./youtube-protocol.js');const result={projectId:fixture.project.id,workspaceId:null,sourceKey:youtubeExportSourceKey(fixture.project),blob:new Blob([new Uint8Array(32)],{type:'video/webm'}),name:'auto-synthetic.webm'};await fixture.studio.handleExportReady(result);await fixture.studio.handleExportReady(result);});await page.waitForFunction(()=>fixture.project.production.youtube.uploads?.[0]?.publicationStatus==='completed'&&!fixture.studio.getUploadBusy());assert.equal(await uploadPosts(),1);assert.equal((await state()).production.youtube.uploads[0].privacyStatus,'private');assert.equal(await page.evaluate(()=>fixture.remote.calls.some(call=>call.path==='/youtube/v3/videos')),false);
  console.log('PASS explicit saved private and base OAuth preserved; reviewed auto upload is consumed exactly once');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS no real provider, OAuth, paid API, or rendering request');
 }catch(cause){console.error(await page.evaluate(()=>({error:document.querySelector('#youtubeUploadError')?.textContent,info:document.querySelector('#youtubeThumbnailInfo')?.textContent,thumb:document.querySelector('#youtubeThumbnailOperation')?.textContent,preview:document.querySelector('#youtubeThumbnailPreview')?.outerHTML})));throw cause;}finally{await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
