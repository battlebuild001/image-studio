const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {chromium}=require('playwright');

// The actual editor and existing destinations, with only free API configuration mocked.
(async()=>{
 const base=new URL(process.env.STUDIO_URL||'http://127.0.0.1:4173/'),browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1050},acceptDownloads:true});page.setDefaultTimeout(22000);
 const errors=[],posts=[],external=[],filePickers=[];page.on('pageerror',cause=>errors.push(cause.message));page.on('request',request=>{if(request.method()==='POST')posts.push(request.url());});page.on('filechooser',chooser=>filePickers.push(chooser));
 await page.route('https://**/*',route=>{if(new URL(route.request().url()).origin===base.origin)return route.continue();external.push(route.request().url());return route.abort();});
 await page.route('**/api/**',route=>{assert.equal(route.request().method(),'GET','Opening a tool must not send a provider task');return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:false,model:'synthetic-unconfigured',provider:'synthetic',voices:[]})});});
 const ready=()=>page.waitForFunction(()=>document.querySelector('#toolNavigationBtn')&&!document.querySelector('#toolNavigationBtn').disabled&&!document.querySelector('#addWorkspaceBtn').disabled);
 const stored=()=>page.evaluate(async()=>(await(await import('./project.js')).loadProject())?.project);
 async function waitProject(predicate){for(let attempt=0;attempt<300;attempt++){const project=await stored();if(project&&predicate(project))return project;await page.waitForTimeout(35);}assert.fail('Expected actual project persistence');}
 const hashes=()=>page.evaluate(async()=>{const {loadProject}=await import('./project.js'),loaded=await loadProject();return Promise.all([...loaded.assets].sort(([a],[b])=>a.localeCompare(b)).map(async([id,asset])=>({id,name:asset.name,bytes:asset.blob.size,hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await asset.blob.arrayBuffer()))].join(',')})));});
 let currentRoute='initial';
 async function choose(id,category){currentRoute=id;await page.keyboard.press('Control+k');await page.locator('#toolNavigationDialog').waitFor({state:'visible'});await page.locator('#toolCategory-'+category).click();await page.locator('[data-tool-id="'+id+'"]').click();await page.locator('#toolNavigationDialog').waitFor({state:'hidden'});}
 async function oneDialog(id){await page.locator('#'+id).waitFor({state:'visible'});assert.deepEqual(await page.locator('dialog[open]').evaluateAll(values=>values.map(value=>value.id)),[id],currentRoute);}
 async function production(section){await oneDialog('productionWorkbenchDialog');assert.equal(await page.locator('#productionTab-'+section).getAttribute('aria-selected'),'true',currentRoute);assert.equal(await page.locator('#productionPanel-'+section).isVisible(),true,currentRoute);}
 async function upload(section){await oneDialog('videoUploadDialog');assert.equal(await page.locator('#uploadTab-'+section).getAttribute('aria-selected'),'true',currentRoute);}
 async function assertRoute(id){
  switch(id){
   case 'script-draft':await oneDialog('scriptStudioDialog');break;
   case 'topic-research':await oneDialog('scriptStudioDialog');assert.equal(await page.locator('#researchTopic').isVisible(),true);break;
   case 'source-files':await oneDialog('scriptStudioDialog');assert.equal(await page.locator('#chooseResearchFilesBtn').isVisible(),true);break;
   case 'reference-images':await oneDialog('scriptStudioDialog');assert.equal(await page.locator('#referenceMediaSection').evaluate(value=>value.open),true);assert.equal(await page.locator('#referenceImageQuery').isVisible(),true);break;
   case 'speech-texts':await production('speech');break;
   case 'pronunciation':await production('speech');assert.equal(await page.locator('#productionPronunciations').isVisible(),true);break;
   case 'voice-generation':await oneDialog('voiceStudioDialog');break;
   case 'voice-samples':await oneDialog('voiceStudioDialog');assert.equal(await page.locator('#voiceSavedSampleSelect').isVisible(),true);break;
   case 'audio-files':assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('#audioToolsDrawer').evaluate(value=>value.open),true);assert.equal(await page.locator('#narrationBtn').isVisible(),true);break;
   case 'music':await oneDialog('musicRecommendationsDialog');break;
   case 'captions-edit':await oneDialog('captionEditorDialog');break;
   case 'transcript':await oneDialog('transcriptStudioDialog');break;
   case 'sync':await oneDialog('syncStudioDialog');await page.waitForFunction(()=>!document.querySelector('#syncMode').disabled);break;
   case 'scene-timing':case 'images-batch':await oneDialog('scriptDialog');break;
   case 'image-reference':await oneDialog('imageStudioDialog');break;
   case 'scene-layout':assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('#focusX').isVisible(),true);assert.equal(await page.locator('#framingDetails').evaluate(value=>value.open),true);break;
   case 'scene-effects':assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('#sceneExposure').isVisible(),true);break;
   case 'title-cards':await oneDialog('templatesDialog');break;
   case 'diagrams':await production('diagrams');break;
   case 'quality':case 'fidelity':case 'chat-edit':await oneDialog('aiAssistantDialog');assert.equal(await page.locator('#aiAssistantTab-'+(id==='chat-edit'?'chat':id)).getAttribute('aria-selected'),'true');break;
   case 'partial-regenerate':await production('changes');break;
   case 'image-review':await production('visual');break;
   case 'version-history':await production('versions');break;
   case 'publishing':await upload('publishing');break;
   case 'upload-video':await upload('youtube');break;
   case 'shorts':await upload('shorts');assert.equal(await page.locator('#shortsSection-create').getAttribute('aria-selected'),'true');break;
   case 'shorts-framing':await upload('shorts');assert.equal(await page.locator('#shortsSection-create').getAttribute('aria-selected'),'true');assert.equal(await page.locator('#shortsFramingSection').evaluate(value=>value.open),true);assert.equal(await page.locator('#prepareShortsFramingBtn').isVisible(),true);break;
   case 'series':await upload('shorts');assert.equal(await page.locator('#shortsSection-series').getAttribute('aria-selected'),'true');assert.equal(await page.locator('#uploadPanel-series').isVisible(),true);break;
   case 'upload-settings':await upload('settings');break;
   case 'project-defaults':await production('basics');break;
   case 'channel-presets':await production('channels');break;
   case 'budget':await production('budget');break;
   case 'project-files':assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await page.locator('#projectMenu').evaluate(value=>value.open),true);break;
   case 'api-settings':await oneDialog('apiSettingsDialog');break;
   case 'workspace-management':await oneDialog('workspaceManageDialog');break;
   default:assert.fail('Missing real destination assertion: '+id);
  }
 }
 try{
  await page.goto(base.href,{waitUntil:'networkidle'});await ready();
  const backup=await page.evaluate(async()=>{
   const p=await import('./project.js'),{encodePcm16Wav}=await import('./speech-timing.js');
   const picture=async color=>{const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1280,720);ctx.fillStyle='#f0e8ce';ctx.fillRect(100,100,180,180);return await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));};
   const first='첫 장면의 실제 자막을 유지합니다.',second='두 번째 장면과 원본 음성을 보존합니다.',project=p.createProject({id:'tool-routing-main',title:'실제 도구 이동 검증',scenes:[p.createScene({id:'first',imageId:'image-one',duration:2,motion:'none',caption:first}),p.createScene({id:'second',imageId:'image-two',duration:2,motion:'none',caption:second})],captionMode:'srt',captions:[{start:0,end:2,text:first},{start:2,end:4,text:second}],audio:{narrationId:'voice',narrationEnd:4,bgmId:'music',bgmEnd:4},settings:{branding:false,transition:0},scriptDraft:{sourceText:'원본 연표와 참고 자료는 바꾸지 않습니다.',instructions:'내용을 지켜 주세요.',targetMinutes:1,charsPerMinute:330,narrationStyle:'standard',draftScript:first+'\n\n'+second,displayScript:first+'\n\n'+second,result:null}});
   const voice=Float32Array.from({length:4*24000},(_,index)=>Math.sin(index/24000*Math.PI*2*440)*.15),music=Float32Array.from({length:4*24000},(_,index)=>Math.sin(index/24000*Math.PI*2*110)*.04),assets=new Map([['image-one',{blob:await picture('#32646b'),name:'synthetic-one.png'}],['image-two',{blob:await picture('#715948'),name:'synthetic-two.png'}],['voice',{blob:encodePcm16Wav(voice,24000),name:'synthetic-voice.wav'}],['music',{blob:encodePcm16Wav(music,24000),name:'synthetic-music.wav'}]]);
   return(await p.exportProjectBackup(project,assets)).text();
  });
  await page.locator('#projectInput').setInputFiles({name:'tool-routing.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});const original=await waitProject(project=>project.id==='tool-routing-main'&&project.scenes.length===2);await ready();const media=await hashes(),catalog=await page.evaluate(async()=>(await import('./tool-navigation-data.js')).TOOL_CATALOG.map(({id,categoryId})=>({id,categoryId})));
  for(const tool of catalog){await choose(tool.id,tool.categoryId);await assertRoute(tool.id);assert.equal(await page.locator('#toolNavigationDialog').isVisible(),false,tool.id);assert.equal(await page.locator('dialog[open]').count()<=1,true,tool.id);}
  assert.deepEqual(await stored(),original);assert.deepEqual(await hashes(),media);assert.deepEqual(posts,[]);assert.deepEqual(external,[]);assert.deepEqual(filePickers,[]);console.log('PASS all38 real catalog routes reach the existing editor/dialog and correct feature without duplicate modals, paid generation, file picker, upload or data/media changes');

  await page.keyboard.press('Control+k');await page.locator('#toolNavigationDialog').waitFor({state:'visible'});await page.locator('#toolNavigationSearch').fill('예약 업로드');await page.locator('[data-tool-id="upload-video"]').click();await assertRoute('upload-video');assert.equal(await page.locator('#youtubeScheduleCard').count(),1);await choose('scene-layout','visual');assert.equal(await page.locator('#focusX').isVisible(),true);await choose('images-batch','visual');await oneDialog('scriptDialog');assert.equal(await page.locator('#sceneImageBatchDialog').isVisible(),false);assert.deepEqual(await stored(),original);assert.deepEqual(posts,[]);console.log('PASS keyword search opens actual scheduling controls, context editors remain reachable, and unconfirmed image timing opens review instead of generation');

  // Staged edits require their existing explicit Apply/Cancel before discovery can replace the modal.
  await choose('captions-edit','audio');const firstCaption=page.getByLabel('1번 자막 문구',{exact:true}),firstStart=page.getByLabel('1번 자막 시작 초',{exact:true});
  const expectDraftGuard=async(dialogId,errorId)=>{for(const shortcut of['Control+k','Meta+k']){await page.keyboard.press(shortcut);assert.equal(await page.locator('#toolNavigationDialog').isVisible(),false);assert.deepEqual(await page.locator('dialog[open]').evaluateAll(values=>values.map(value=>value.id)),[dialogId]);assert.match(await page.locator('#'+errorId).innerText(),/아직/);assert.equal(await page.evaluate(()=>document.activeElement.id),errorId);}};
  await firstCaption.fill('적용 전 자막 문구를 보존합니다.');await expectDraftGuard('captionEditorDialog','captionEditorError');assert.equal(await firstCaption.inputValue(),'적용 전 자막 문구를 보존합니다.');assert.deepEqual(await stored(),original);await page.locator('#cancelCaptionEditorBtn').click();
  await choose('captions-edit','audio');assert.equal(await firstCaption.inputValue(),original.captions[0].text);await firstStart.fill('');await expectDraftGuard('captionEditorDialog','captionEditorError');assert.equal(await firstStart.inputValue(),'');await firstStart.fill('0');await page.keyboard.press('Control+k');await page.locator('#toolNavigationDialog').waitFor({state:'visible'});await page.keyboard.press('Escape');await oneDialog('captionEditorDialog');
  await page.locator('#addCaptionCueBtn').click();await expectDraftGuard('captionEditorDialog','captionEditorError');await page.locator('#deleteCue2').click();await page.keyboard.press('Control+k');await page.locator('#toolNavigationDialog').waitFor({state:'visible'});await page.keyboard.press('Escape');await page.locator('#captionOffset').fill('.25');await page.locator('#shiftCaptionsBtn').click();await expectDraftGuard('captionEditorDialog','captionEditorError');assert.equal(await firstStart.inputValue(),'0.25');await page.locator('#cancelCaptionEditorBtn').click();assert.deepEqual(await stored(),original);
  await choose('captions-edit','audio');await firstCaption.fill('명시적으로 적용한 자막입니다.');await page.getByLabel('1번 자막 종료 초',{exact:true}).fill('1.75');await expectDraftGuard('captionEditorDialog','captionEditorError');await page.locator('#applyCaptionEditorBtn').click();await waitProject(project=>project.captions[0].text==='명시적으로 적용한 자막입니다.');await choose('scene-layout','visual');assert.equal((await stored()).captions[0].end,1.75);await page.locator('#undoBtn').click();await waitProject(project=>project.captions[0].text===original.captions[0].text);assert.deepEqual(await stored(),original);
  await choose('voice-generation','audio');const voiceText=page.locator('#voiceText'),voiceBaseline=await voiceText.inputValue();await voiceText.fill('합성 전 수정한 보이스 대본입니다.');await expectDraftGuard('voiceStudioDialog','voiceError');assert.equal(await voiceText.inputValue(),'합성 전 수정한 보이스 대본입니다.');assert.deepEqual(await stored(),original);await voiceText.fill(voiceBaseline);await choose('scene-layout','visual');await choose('voice-generation','audio');assert.equal(await voiceText.inputValue(),voiceBaseline);await voiceText.fill('닫기로 명시적으로 취소할 초안입니다.');await page.locator('#closeVoiceStudioBtn').click();await choose('scene-layout','visual');assert.deepEqual(await stored(),original);assert.deepEqual(await hashes(),media);assert.deepEqual(posts,[]);console.log('PASS Ctrl/Cmd+K preserves pending caption text, blank timing fields, cue additions/time shifts and unsynthesized voice text until explicit Apply/Cancel; clean/reverted drafts navigate and caption Apply remains undoable');

  await page.setViewportSize({width:375,height:812});for(const tool of[{id:'scene-layout',categoryId:'visual'},{id:'scene-effects',categoryId:'visual'},{id:'upload-video',categoryId:'delivery'},{id:'series',categoryId:'delivery'},{id:'api-settings',categoryId:'project'}]){await choose(tool.id,tool.categoryId);await assertRoute(tool.id);if(['scene-layout','scene-effects'].includes(tool.id))assert.equal(await page.locator('#mobileEditorTab-inspector').getAttribute('aria-selected'),'true');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const modal=page.locator('dialog[open]');if(await modal.count()){const bounds=await modal.boundingBox();assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=376);assert.ok(bounds.y>=-1&&bounds.y+bounds.height<=813);}}
  await page.screenshot({path:'/tmp/tool-routing-main-mobile.png',fullPage:true});assert.deepEqual(await stored(),original);assert.deepEqual(await hashes(),media);assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);assert.deepEqual(external,[]);assert.deepEqual(filePickers,[]);await fs.writeFile('/tmp/tool-routing-browser-result.json',JSON.stringify({passed:true,routeCount:catalog.length,realMainIntegration:true,desktop:true,mobile375:true,pendingCaptionProtection:true,pendingVoiceProtection:true,explicitApplyUndo:true,mediaUnchanged:true,projectUnchanged:true,providerPosts:0,googleConnects:0},null,2)+'\n');console.log('PASS mobile catalog routing reveals the actual inspector and nested upload/series/settings screens with single visible modal, stable source/media and no provider operations');
 }catch(cause){await page.screenshot({path:'/tmp/tool-routing-main-failure.png',fullPage:true}).catch(()=>{});console.error('Failed real route:',currentRoute,await page.locator('#toolNavigationError,#toastArea').allTextContents().catch(()=>[]));throw cause;}
 finally{await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
