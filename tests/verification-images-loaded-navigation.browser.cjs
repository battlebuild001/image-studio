const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');

// Old saved projects can have complete manual images/cues without scenePlan.
// Merely opening them or changing work areas must never rebuild their timeline.
(async()=>{
 const base=process.env.STUDIO_URL||'http://127.0.0.1:4173/';
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[],posts=[];
 page.setDefaultTimeout(20000);page.on('pageerror',cause=>errors.push(cause.message));
 await page.route('https://**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 await page.route('**/api/**',route=>{if(route.request().method()==='POST')posts.push(route.request().url());return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:false})});});
 const fixture=await Promise.all(['image-test-1.png','image-test-2.png','narration-test.wav'].map(name=>fs.readFile(path.join(__dirname,'fixtures',name)).then(value=>value.toString('base64'))));
 const stored=()=>page.evaluate(async()=>(await(await import('./project.js')).loadProject()).project);
 try{
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>document.querySelector('#addWorkspaceBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
  const backup=await page.evaluate(async fixture=>{
   const p=await import('./project.js'),blob=(data,type)=>new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type});
   const text=['첫 장면은 도시에서 시작합니다.','둘째 장면은 항구에서 탐사합니다.','마지막 장면은 관측소에서 끝납니다.'];
   const project=p.createProject({id:'saved-manual-navigation-fixture',title:'기존 수동 편집본',scenes:text.map((caption,index)=>p.createScene({id:'manual-'+index,imageId:'picture-'+index,caption,duration:[2.25,3.5,2.75][index]})),audio:{narrationId:'voice',narrationStart:1,narrationEnd:5},scriptDraft:{draftScript:text.join('\n'),displayScript:text.join('\n')},captionMode:'srt',captions:[{start:.4,end:1.5,text:'보존할 첫 자막'},{start:2.5,end:4.2,text:'보존할 둘째 자막'},{start:6.4,end:8,text:'보존할 마지막 자막'}]});
   const images=fixture.slice(0,2).map(value=>blob(value,'image/png')),assets=new Map(text.map((_,index)=>['picture-'+index,{blob:images[index%2],name:`picture-${index}.png`}]));
   assets.set('voice',{blob:blob(fixture[2],'audio/wav'),name:'saved-voice.wav'});
   return(await p.exportProjectBackup(project,assets)).text();
  },fixture);
  await page.locator('#projectInput').setInputFiles({name:'manual-edit.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});
  await page.waitForFunction(async()=>(await(await import('./project.js')).loadProject())?.project?.id==='saved-manual-navigation-fixture');
  await page.waitForFunction(()=>!document.querySelector('#threeStepDeliveryTab').disabled);
  const original=await stored();
  assert.equal(await page.locator('#threeStepDeliveryPanel').isVisible(),true,'Opening a complete saved edit should restore its actual editor after the import busy state');
  for(const id of ['threeStepScriptTab','threeStepDeliveryTab','threeStepImagesTab','threeStepDeliveryTab']){
   await page.locator('#'+id).click();await page.waitForTimeout(180);
   assert.deepEqual(await stored(),original,'Changing work areas must retain original scene timing, images, captions and narration');
  }
  assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);
  console.log('PASS imported complete manual edit restores delivery; unchanged stage navigation preserves exact scenes/SRT/audio and issues no paid calls');
 }finally{await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
