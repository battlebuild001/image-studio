const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {chromium}=require('playwright');

// Actual decoded reference pixels, narration PCM, locally synthesized WAV,
// caption repair, quality scanning and thumbnail Canvas; provider replies are synthetic.
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],external=[];
 page.on('pageerror',cause=>errors.push(cause.message));await page.route('https://**/*',route=>{external.push(route.request().url());return route.abort();});
 const base=process.env.STUDIO_URL||'http://127.0.0.1:4173/';
 await page.route('**/multi-video-feature-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"></head><body><main>여러 영상 추가 제작 검증</main></body></html>'}));
 try{
  const files={};for(const name of ['image-test-1.png','narration-test.wav'])files[name]=(await fs.readFile(new URL(`fixtures/${name}`,`file://${__dirname}/`))).toString('base64');
  await page.goto(new URL('multi-video-feature-harness',base).href);
  const result=await page.evaluate(async(files)=>{
   const [{createProject,validateProject,exportProjectBackup,importProjectBackup},{prepareSimpleScriptProject},{createMultiVideoFeatureRunner,prepareExtraWork}]=await Promise.all([import('./project.js'),import('./simple-script-project.js'),import('./multi-video-features.js')]);
   const bytes=value=>Uint8Array.from(atob(value),char=>char.charCodeAt(0)),png=new Blob([bytes(files['image-test-1.png'])],{type:'image/png'}),voice=new Blob([bytes(files['narration-test.wav'])],{type:'audio/wav'});
   let project=createProject({id:'multi-feature-browser',title:'워해머 엄폐 설명',audio:{narrationId:'voice'},settings:{branding:false,subtitles:true}}),assets=new Map([['voice',{blob:voice,name:'narration.wav',duration:6}]]);
   project=prepareSimpleScriptProject(project,assets,{text:'워해머 40,000의 미니어처와 지형을 확인합니다. 엄폐 규칙을 같은 전장의 위치로 설명합니다.',intervalSeconds:3}).project;
   for(const scene of project.scenes){const id=`image-${scene.id}`;scene.imageId=id;assets.set(id,{blob:png,name:'scene.png'});}
   const calls=[],steps=[],api={getProject:()=>project,getAssets:()=>assets,getWorkspaceId:()=> 'job-browser',mutate(action){const next=structuredClone(project);action(next);project=validateProject(next);},async persist(){steps.push('saved');},async apiFetch(path,options){calls.push(path);const input=JSON.parse(options.body);
    if(path==='/api/research/collect')return Response.json({topic:input.topic,title:'엄폐 자료',summary:'실제 미니어처와 지형의 위치를 살펴보는 합성 조사 결과입니다.',sections:[{heading:'엄폐',text:'가상의 이미지 카탈로그를 사용해 실제 PNG를 내려받고 레퍼런스와 출처가 저장되는지 확인합니다.',sourceUrls:['https://example.org/fixture']}],visualBrief:'테이블의 실제 미니어처와 지형',searchTerms:['miniature game'],notes:['Synthetic fixture'],sources:[{title:'합성 출처',url:'https://example.org/fixture'}],searchedAt:'2026-11-20T00:00:00.000Z',webSearchUsed:true});
    if(path==='/api/production/assist')return Response.json({titles:['엄폐 규칙 핵심 정리'],description:'실제 전장의 미니어처와 지형을 기준으로 엄폐를 설명합니다.',chapters:[],tags:[],thumbnailConcepts:[{headline:'엄폐의 핵심',prompt:'이 영상의 실제 장면 이미지를 사용합니다.',sceneId:input.context.scenes[0].id}],notes:[],model:'synthetic-test',createdAt:new Date().toISOString()});
    throw new Error('Unexpected provider route '+path);
   }};
   const candidate={id:'commons-1',kind:'image',title:'Miniature game fixture',description:'Synthetic metadata for actual pixels',mediaUrl:'https://upload.wikimedia.org/wikipedia/commons/a/a0/test.png',originalUrl:'https://upload.wikimedia.org/wikipedia/commons/a/a0/test.png',previewUrl:'https://upload.wikimedia.org/wikipedia/commons/a/a0/test.png',sourceUrl:'https://commons.wikimedia.org/?curid=1',mimeType:'image/png',size:png.size,width:320,height:180,duration:0,artist:'Synthetic fixture',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',attribution:'Synthetic fixture',source:'wikimedia-commons'};
   const runner=createMultiVideoFeatureRunner({client:{async search(){steps.push('search');return[candidate];},async download(){steps.push('download');return new File([png],'reference.png',{type:'image/png'});}}});
   const review=prepareExtraWork(project,assets,{referenceResearch:true,bgm:true,sync:'local',localReview:true,packaging:true});
   if(review.blockers.length)throw new Error(review.blockers.join('\n'));
   const narrationId=project.audio.narrationId,sceneIds=project.scenes.map(scene=>scene.id);
   await runner.runExtraWork(api,review,{phase:'before-voice'});await runner.runExtraWork(api,review,{phase:'after-voice'});
   const packaging=await runner.runExtraWork(api,review,{phase:'after-images'}),music=assets.get(project.audio.bgmId),decoder=new OfflineAudioContext(1,1,22050),audio=await decoder.decodeAudioData(await music.blob.arrayBuffer()),bitmap=await createImageBitmap(packaging.thumbnail.blob);const dimensions=[bitmap.width,bitmap.height];bitmap.close();
   const backup=await exportProjectBackup(project,assets),restored=await importProjectBackup(await backup.text());
   return{calls,steps,bgm:{duration:audio.duration,sampleRate:audio.sampleRate,bytes:music.blob.size,peak:Math.max(...audio.getChannelData(0).subarray(20000,40000).map(Math.abs))},captionMode:project.captionMode,captionCount:project.captions.length,narrationPreserved:narrationId===project.audio.narrationId,scenesPreserved:JSON.stringify(sceneIds)===JSON.stringify(project.scenes.map(scene=>scene.id)),referenceSaved:project.imageStudio.references.length===1&&project.production.referenceMedia.imports.length===1,quality:project.production.run.report,thumbnail:{dimensions,bytes:packaging.thumbnail.blob.size,title:packaging.title},restoredMusic:restored.assets.get(project.audio.bgmId).blob.size===music.blob.size,restoredReference:restored.project.production.referenceMedia.imports[0].sourceUrl};
  },files);
  assert.deepEqual(result.calls,['/api/research/collect','/api/production/assist']);assert.equal(result.referenceSaved,true);assert.equal(result.narrationPreserved,true);assert.equal(result.scenesPreserved,true);assert.equal(result.captionMode,'srt');assert.ok(result.captionCount>0);assert.equal(result.bgm.sampleRate,22050);assert.ok(Math.abs(result.bgm.duration-6)<.001);assert.ok(result.bgm.peak>.01);assert.deepEqual(result.thumbnail.dimensions,[1280,720]);assert.ok(result.thumbnail.bytes>1000);assert.equal(result.thumbnail.title,'엄폐 규칙 핵심 정리');assert.match(result.quality.summary,/검수 결과/);assert.equal(result.restoredMusic,true);assert.match(result.restoredReference,/commons/);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('PASS: real multi-video reference/BGM/caption/quality/thumbnail pipeline, durable backup; provider replies synthetic.');
 }finally{await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
