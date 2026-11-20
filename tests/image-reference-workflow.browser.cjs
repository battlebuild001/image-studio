const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');

// Synthetic research/catalog and real local PNG decoding. No paid provider calls.
(async()=>{
  const base=new URL(process.env.STUDIO_URL||'http://127.0.0.1:4173/');
  const png=await fs.readFile(path.join(__dirname,'fixtures/image-test-1.png'));
  const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
  const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[],external=[];
  page.on('pageerror',cause=>errors.push(cause.message));
  await page.route('https://api.openai.com/**',route=>{external.push(route.request().url());return route.abort();});
  await page.route('https://upload.wikimedia.org/**',route=>route.fulfill({contentType:'image/png',body:png}));
  await page.route('**/reference-workflow-harness',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><head><link rel="stylesheet" href="/style.css"></head><body><main id="host" style="padding:20px;max-width:950px"></main></body></html>'}));
  try{
    await page.goto(new URL('/reference-workflow-harness',base).href);
    await page.evaluate(async data=>{
      const {setupImageReferenceWorkflow}=await import('/image-reference-workflow.js');
      const {normalizeReferenceMediaState}=await import('/media-search-protocol.js');
      const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0)),blob=new Blob([bytes],{type:'image/png'});
      window.referenceProject={id:'project-one',title:'워해머 엄폐 룰',scriptDraft:{draftScript:'워해머 40k에서 엄폐를 설명합니다. 미니어처와 지형의 위치를 실제 게임처럼 보여 줍니다.'},imageStudio:{references:[{assetId:'original',label:'기존 레퍼런스',role:'concept',enabled:true}]}};
      window.referenceAssets=new Map([['original',{blob,name:'old.png'}]]);window.referenceTrace=[];window.referenceWorkspace='one';window.holdResearch=false;window.blockReference=false;
      const candidates=[1,2,3].map(id=>({id:`commons-${id}`,kind:'image',title:`Warhammer miniature ${id}`,description:'실제 파일을 대신하는 합성 카탈로그 메타데이터',mediaUrl:`https://upload.wikimedia.org/wikipedia/commons/a/a0/image-${id}.png`,originalUrl:`https://upload.wikimedia.org/wikipedia/commons/a/a0/image-${id}.png`,previewUrl:`https://upload.wikimedia.org/wikipedia/commons/a/a0/image-${id}.png`,sourceUrl:`https://commons.wikimedia.org/?curid=${id}`,mimeType:'image/png',size:bytes.length,width:320,height:180,duration:0,artist:'Synthetic fixture author',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',attribution:'Synthetic fixture',source:'wikimedia-commons'}));
      const api={getProject:()=>window.referenceProject,getAssets:()=>window.referenceAssets,getWorkspaceId:()=>window.referenceWorkspace,canUseSceneImages:()=>!window.blockReference,
        mutateProductionMetadata(action){action(window.referenceProject);window.referenceUi?.render();},async persist(){window.referenceTrace.push('persist');},
        async replaceImageReference(file,meta){assertGuard(meta.guard());const bitmap=await createImageBitmap(file);bitmap.close();assertGuard(meta.guard());const id=`selected-${window.referenceTrace.filter(x=>x==='replace').length}`;window.referenceAssets.set(id,{blob:file,name:file.name});window.referenceProject.imageStudio.references=[{assetId:id,label:meta.candidate?.title||file.name,role:'concept',enabled:true}];if(meta.candidate){window.referenceProject.production||={version:1};const state=normalizeReferenceMediaState(window.referenceProject.production.referenceMedia||{});state.imports=[...new Map([...state.imports,meta.candidate].map(item=>[item.id,item])).values()];window.referenceProject.production.referenceMedia=normalizeReferenceMediaState(state);}window.referenceTrace.push('replace');window.referenceUi.render();return true;}};
      function assertGuard(value){if(!value)throw new DOMException('stale','AbortError');}
      window.referenceUi=setupImageReferenceWorkflow(api,{container:document.getElementById('host'),client:{async search(query){window.referenceTrace.push(['search',query]);return candidates;},async download(candidate){window.referenceTrace.push(['download',candidate.id]);return new File([blob],`${candidate.title}.png`,{type:'image/png'});}},fetchImpl:async(url,options)=>{window.referenceTrace.push(['research',url]);if(window.holdResearch)await new Promise(resolve=>{window.releaseResearch=resolve;});const input=JSON.parse(options.body),source={title:'합성 공식 자료 출처',url:'https://example.org/reference-fixture'};return new Response(JSON.stringify({topic:input.topic,title:'엄폐 참고 자료',summary:'미니어처와 지형의 위치를 중심으로 게임의 엄폐 규칙을 살펴보는 합성 조사 결과입니다.',sections:[{heading:'엄폐와 지형',text:'이 테스트는 가상 조사 응답이며 실제 게임의 지형과 미니어처를 구분해서 참고하는 동작을 검증합니다.',sourceUrls:[source.url]}],visualBrief:'실제 테이블의 미니어처와 지형을 보여 주는 구도로 구성합니다.',searchTerms:['Warhammer miniatures'],notes:['Synthetic fixture only'],sources:[source],searchedAt:'2026-11-20T00:00:00.000Z',webSearchUsed:true}),{status:200,headers:{'content-type':'application/json'}});}});
    },png.toString('base64'));
    const trace=()=>page.evaluate(()=>structuredClone(window.referenceTrace));
    const idle=()=>page.waitForFunction(()=>!window.referenceUi.isBusy());
    assert.deepEqual(await trace(),[]);assert.equal(await page.locator('#imageReferencePreviewImage').count(),1);
    assert.match(await page.locator('#imageReferenceCurrent').innerText(),/기존 레퍼런스/);
    await page.locator('#findScriptImageReferenceBtn').click();await idle();
    assert.equal((await trace()).filter(x=>Array.isArray(x)&&x[0]==='research').length,1);
    assert.equal((await trace()).filter(x=>Array.isArray(x)&&x[0]==='search').length,1);
    const beforeOther=await trace();
    for(let index=0;index<5;index++){const previous=await page.locator('#imageReferencePreviewImage').getAttribute('src');await page.locator('#nextImageReferenceBtn').click();assert.notEqual(await page.locator('#imageReferencePreviewImage').getAttribute('src'),previous);}
    assert.deepEqual(await trace(),beforeOther);assert.equal(await page.locator('#imageReferencePreviewImage').count(),1);
    await page.locator('#useImageReferenceBtn').click();await idle();
    assert.equal(await page.evaluate(()=>window.referenceProject.imageStudio.references.length),1);
    assert.equal(await page.evaluate(()=>window.referenceProject.production.referenceMedia.imports.length),1);
    assert.equal((await trace()).filter(x=>Array.isArray(x)&&x[0]==='download').length,1);
    const selected=await page.evaluate(()=>window.referenceProject.imageStudio.references[0].assetId);
    await page.locator('#imageReferenceFile').setInputFiles({name:'my-reference.png',mimeType:'image/png',buffer:png});await idle();
    assert.equal(await page.evaluate(()=>window.referenceProject.imageStudio.references[0].assetId),selected);
    await page.locator('#useImageReferenceBtn').click();await idle();
    assert.equal(await page.evaluate(()=>window.referenceProject.imageStudio.references[0].label),'my-reference.png');
    await page.evaluate(()=>window.holdResearch=true);await page.locator('#findScriptImageReferenceBtn').click();await page.waitForFunction(()=>Boolean(window.releaseResearch));
    await page.locator('#cancelImageReferenceSearchBtn').click();await page.evaluate(()=>window.releaseResearch());await idle();
    assert.equal(await page.evaluate(()=>window.referenceProject.imageStudio.references[0].label),'my-reference.png');
    assert.match(await page.locator('#imageReferenceStatus').innerText(),/취소/);
    await page.evaluate(()=>{window.releaseResearch=null;window.holdResearch=true;});await page.locator('#findScriptImageReferenceBtn').click();await page.waitForFunction(()=>Boolean(window.releaseResearch));
    await page.evaluate(()=>{window.referenceWorkspace='two';window.referenceProject={...window.referenceProject,id:'project-two'};window.referenceUi.render();window.releaseResearch();});await idle();
    assert.equal(await page.locator('#imageReferenceError').innerText(),'');
    assert.equal((await trace()).filter(x=>x==='replace').length,2);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.referenceUi.render());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    console.log('PASS reference reuse, explicit research, one random preview, cached rotation, source credits, real PNG import, cancellation/stale guards and mobile width; no paid calls');
  }finally{await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
