const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {launchDesktop,stopDesktop,syntheticBackup,stored,mediaHashes}=require('./desktop-app.browser.cjs');

// The complete isolated Electron application is real. Opening either music
// screen must be readonly: no catalog/provider request, playback or media apply.
(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'content-studio-bgm-choice-'));
 let runtime;const errors=[],external=[];
 const collect=()=>{errors.push(...runtime.errors);external.push(...runtime.external);};
 const read=page=>page.evaluate(async()=>(await(await import('./project.js')).loadProject()).project);
 const ready=page=>page.waitForFunction(()=>document.querySelector('#simpleBgmChooseBtn')&&!document.querySelector('#addWorkspaceBtn')?.disabled&&!document.body.classList.contains('busy'));
 const scriptStep=async page=>{await ready(page);await page.locator('#threeStepScriptTab').click();await page.locator('#simpleBgmChooseBtn').waitFor({state:'visible'});};
 try{
  runtime=await launchDesktop(profile);let {app,page}=runtime;
  const application=await app.evaluate(({app})=>({version:app.getVersion(),isPackaged:app.isPackaged,appPath:app.getAppPath()}));
  if(process.env.CONTENT_STUDIO_PACKAGED==='1')assert.equal(application.isPackaged,true);
  assert.match(page.url(),/^studio:\/\/app\//u);
  const source=await syntheticBackup(page,{id:'desktop-bgm-choice-original'});
  const backup=await page.evaluate(async text=>{
   const p=await import('./project.js'),{normalizeMusicState}=await import('./media-search-protocol.js'),loaded=await p.importProjectBackup(text);
   const candidate={id:'commons-91001',kind:'audio',title:'이전에 선택한 합성 배경음악',description:'실제 외부 파일을 요청하지 않는 로컬 회귀 자료입니다.',mediaUrl:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Previous_bgm_fixture.wav',originalUrl:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Previous_bgm_fixture.wav',previewUrl:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Previous_bgm_fixture.wav',sourceUrl:'https://commons.wikimedia.org/?curid=91001',mimeType:'audio/wav',size:loaded.assets.get('desktop-bgm').blob.size,duration:6,artist:'합성 자료',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',attribution:'회귀검사용 합성 출처'};
   loaded.project.production={version:1,...loaded.project.production,music:normalizeMusicState({query:'ambient instrumental',recommendations:[{title:'기존 차분한 음악 방향',mood:'차분한',style:'ambient instrumental',instruments:['피아노'],tempoBpm:70,searchQuery:'ambient instrumental',reason:'기존에 검토한 음악 방향을 유지합니다.'}],candidates:[candidate],selectedId:candidate.id,searchedAt:'2026-11-20T00:00:00.000Z',suggestedAt:'2026-11-20T00:00:00.000Z',appliedCandidate:candidate})};
   return(await p.exportProjectBackup(loaded.project,loaded.assets)).text();
  },source);
  await page.locator('#projectInput').setInputFiles({name:'music-choice-original.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  const original=await stored(page,value=>value.id==='desktop-bgm-choice-original');await scriptStep(page);const hashes=await mediaHashes(page);
  assert.equal(original.audio.bgmId,'desktop-bgm');assert.equal(await page.locator('#simpleBgmChooseBtn').isVisible(),true);assert.equal(await page.locator('#simpleBgmChooseBtn').textContent(),'배경음악 고르기');
  assert.equal(await page.locator('#simpleBgmGenerateBtn').isVisible(),false);assert.equal(await page.locator('#simpleBgmUploadBtn').isVisible(),true);
  await page.locator('#simpleBgmChooseBtn').click();await page.locator('#musicRecommendationsDialog').waitFor({state:'visible'});
  for(const id of ['musicSearchQuery','recommendMusicBtn','searchMusicBtn'])assert.equal(await page.locator('#'+id).isVisible(),true);
  assert.equal(await page.locator('#musicSearchQuery').inputValue(),original.production.music.query);assert.equal(await page.locator('#musicStyleSuggestions article').count(),1);assert.equal(await page.locator('#musicSearchResults article').count(),1);
  assert.equal(await page.locator('#musicSearchResults [data-music-action=preview]').isVisible(),true);assert.equal(await page.locator('#musicSearchResults [data-music-action=apply]').isVisible(),true);assert.match(await page.locator('#musicAppliedCredit').textContent(),/이전에 선택한 합성 배경음악/);
  assert.equal(await page.locator('#musicPreviewAudio').getAttribute('src'),null);assert.equal(await page.locator('#bgmGeneratorDialog').isVisible(),false);assert.deepEqual(await read(page),original);assert.deepEqual(await mediaHashes(page),hashes);
  await page.screenshot({path:path.join(os.tmpdir(),'desktop-bgm-selection.png'),fullPage:true});await page.locator('#closeMusicRecommendationsBtn').click();
  assert.deepEqual(await read(page),original);assert.deepEqual(await mediaHashes(page),hashes);assert.equal(await page.locator('#simpleBgmChooseBtn').evaluate(control=>document.activeElement===control),true);
  console.log('PASS the primary native music chooser restores recommendation, search, preview and apply controls without replacing the selected BGM, source attribution, draft, scene timing or any media bytes');

  await page.locator('#threeStepAdvancedSummary').click();await page.locator('#simpleBgmGenerateBtn').waitFor({state:'visible'});assert.equal(await page.locator('#simpleBgmGenerateBtn').textContent(),'내장 음악 만들기');assert.equal(await page.locator('#simpleBgmGenerateBtn').evaluate(control=>Boolean(control.closest('#threeStepAdvancedBody'))),true);
  await page.locator('#simpleBgmGenerateBtn').click();await page.locator('#bgmGeneratorDialog').waitFor({state:'visible'});assert.equal(await page.locator('#musicRecommendationsDialog').isVisible(),false);assert.deepEqual(await read(page),original);assert.deepEqual(await mediaHashes(page),hashes);
  await page.locator('#bgmGeneratorHeaderClose').click();await page.locator('#bgmGeneratorDialog').waitFor({state:'hidden'});await page.locator('#threeStepAdvancedSummary').click();assert.deepEqual(await read(page),original);
  console.log('PASS the existing built-in local music generator remains reachable from advanced tools and opening it also preserves the original selected music');

  await page.reload();await scriptStep(page);assert.deepEqual(await read(page),original);assert.deepEqual(await mediaHashes(page),hashes);await page.locator('#simpleBgmChooseBtn').click();await page.locator('#musicRecommendationsDialog').waitFor({state:'visible'});assert.equal(await page.locator('#musicSearchQuery').inputValue(),original.production.music.query);assert.match(await page.locator('#musicAppliedCredit').textContent(),/이전에 선택한 합성 배경음악/);await page.locator('#closeMusicRecommendationsBtn').click();collect();await stopDesktop(app);runtime=null;
  runtime=await launchDesktop(profile);page=runtime.page;await scriptStep(page);assert.deepEqual(await read(page),original);assert.deepEqual(await mediaHashes(page),hashes);await page.locator('#simpleBgmChooseBtn').click();await page.locator('#musicRecommendationsDialog').waitFor({state:'visible'});assert.equal(await page.locator('#musicSearchQuery').inputValue(),original.production.music.query);await page.locator('#closeMusicRecommendationsBtn').click();collect();assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS reload and a complete native process restart restore the chosen music, attribution and every original project/media byte with no catalog, provider or Google request');
  const result={passed:true,groups:3,hostPlatform:process.platform,windowsRuntimeExecuted:process.platform==='win32',actualElectron:true,application,nativeChooserRestored:true,originalBgmPreserved:true,originalMusicStatePreserved:true,originalProjectAndMediaPreserved:true,builtinAdvancedPreserved:true,explicitPlaybackAndApply:true,reload:true,processRestart:true,realRequests:0,realProviderRequests:0,realGoogleRequests:0,realCatalogRequests:0};await fs.writeFile(path.join(os.tmpdir(),'desktop-bgm-selection-result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }catch(cause){await runtime?.page?.screenshot({path:path.join(os.tmpdir(),'desktop-bgm-selection-failure.png'),fullPage:true}).catch(()=>{});if(runtime)console.error('Native music UI:',await runtime.page.locator('#musicRecommendationError,#bgmGeneratorError,#toastArea').allTextContents().catch(()=>[]));throw cause;}
 finally{await stopDesktop(runtime?.app);}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
