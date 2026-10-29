const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('playwright');

(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[],posts=[];page.setDefaultTimeout(15000);
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(request.method()==='POST')posts.push(request.url());});
 // Reproduce the stale/missing optional stylesheet case. The empty-state
 // correctness must not depend on workflow.css covering painted canvas text.
 await page.route('**/workflow.css*',route=>route.fulfill({contentType:'text/css',body:'/* Simulated older workflow stylesheet. */'}));
 await page.addInitScript(()=>{
  window.__previewTextPaints=[];window.__previewImagePaints=0;
  const text=CanvasRenderingContext2D.prototype.fillText,image=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.fillText=function(value,...args){if(this.canvas.id==='previewCanvas')window.__previewTextPaints.push(String(value));return text.call(this,value,...args);};
  CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.canvas.id==='previewCanvas')window.__previewImagePaints++;return image.apply(this,args);};
 });
 const ready=()=>page.waitForFunction(()=>document.querySelector('#addWorkspaceBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
 const count=number=>page.waitForFunction(number=>document.querySelector('#sceneCount').textContent===String(number),number);
 async function emptyState(){
  const state=await page.evaluate(()=>{
   const canvas=document.querySelector('#previewCanvas'),guide=document.querySelector('#emptyPreview'),badge=document.querySelector('#viewerBadge');
   const {data}=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);
   let cleared=true;for(let index=0;index<data.length;index+=4){if(data[index]||data[index+1]||data[index+2]){cleared=false;break;}}
   return {canvasHidden:canvas.hidden,canvasDisplay:getComputedStyle(canvas).display,canvasAria:canvas.getAttribute('aria-hidden'),guideHidden:guide.hidden,guideDisplay:getComputedStyle(guide).display,badgeHidden:badge.hidden,badgeText:badge.textContent,cleared};
  });
  assert.equal(state.canvasHidden,true);assert.equal(state.canvasDisplay,'none');assert.equal(state.canvasAria,'true');assert.equal(state.guideHidden,false);assert.notEqual(state.guideDisplay,'none');assert.equal(state.badgeHidden,true);assert.equal(state.badgeText,'');assert.equal(state.cleared,true);
 }
 async function sceneState(){
  assert.equal(await page.locator('#previewCanvas').isVisible(),true);
  assert.equal(await page.locator('#previewCanvas').getAttribute('aria-hidden'),'false');
  assert.equal(await page.locator('#emptyPreview').isHidden(),true);
  assert.equal(await page.locator('#viewerBadge').isVisible(),true);
 }
 async function select(name){
  await page.locator('#workspaceTabList').getByRole('tab',{name,exact:true}).click();
  await page.waitForFunction(name=>document.querySelector('#workspaceTabList [aria-selected=true]')?.textContent===name,name);await ready();
 }
 try{
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:4173/',{waitUntil:'networkidle'});await ready();await count(0);await emptyState();
  assert.deepEqual(await page.evaluate(()=>window.__previewTextPaints),[]);
  await page.locator('#emptyPreview').evaluate(element=>{element.style.background='transparent';});
  await emptyState();
  console.log('PASS empty preview has one HTML guide and no painted canvas text, even with missing workflow CSS and a transparent overlay');

  await page.locator('#addSceneBtn').click();await count(1);await sceneState();
  assert.ok((await page.evaluate(()=>window.__previewTextPaints)).some(text=>text.includes('이미지')),'An actual scene without an image still needs its canvas placeholder.');
  await page.locator('#imageInput').setInputFiles(path.join(__dirname,'fixtures','image-test-1.png'));
  await page.waitForFunction(()=>document.querySelectorAll('.scene-thumb img').length===1);await ready();await sceneState();
  assert.ok(await page.evaluate(()=>window.__previewImagePaints>0));
  console.log('PASS blank-scene placeholder remains available and importing an image restores the real preview');

  await select('사만');await count(0);await emptyState();
  await select('블랙아웃');await count(1);await sceneState();
  await page.evaluate(()=>{window.__previewTextPaints=[];});
  await page.locator('#deleteSceneBtn').click();await count(0);await emptyState();
  assert.deepEqual(await page.evaluate(()=>window.__previewTextPaints),[]);
  await page.locator('#undoBtn').click();await count(1);await sceneState();
  await page.locator('#redoBtn').click();await count(0);await emptyState();
  console.log('PASS workspace changes and delete/undo/redo switch cleanly between the canvas and empty guide');

  await select('사만');await page.setViewportSize({width:390,height:844});
  await page.locator('#aspectSelect').selectOption('9:16');await emptyState();
  await page.locator('#viewerShell').scrollIntoViewIfNeeded();
  const layout=await page.evaluate(()=>{
   const guide=document.querySelector('#emptyPreview'),frame=document.querySelector('#viewerShell');
   const heading=guide.querySelector('h1').getBoundingClientRect(),description=guide.querySelector('p').getBoundingClientRect(),actions=guide.lastElementChild.getBoundingClientRect(),box=frame.getBoundingClientRect();
   return {documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,headingBottom:heading.bottom,descriptionTop:description.top,descriptionBottom:description.bottom,actionsTop:actions.top,actionsLeft:actions.left,actionsRight:actions.right,frameLeft:box.left,frameRight:box.right};
  });
  assert.ok(layout.documentWidth<=layout.viewport+1);assert.ok(layout.headingBottom<=layout.descriptionTop+1);assert.ok(layout.descriptionBottom<=layout.actionsTop+1);assert.ok(layout.actionsLeft>=layout.frameLeft&&layout.actionsRight<=layout.frameRight);
  await page.screenshot({path:'/tmp/preview-empty-after-mobile.png',fullPage:true});
  await page.locator('#emptyScriptBtn').click();await page.locator('#scriptStudioDialog').waitFor({state:'visible'});await page.locator('#generatedScript').waitFor({state:'visible'});await page.locator('#closeScriptStudioBtn').click();
  await page.locator('#aspectSelect').selectOption('16:9');await page.setViewportSize({width:1440,height:1000});await emptyState();
  await page.screenshot({path:'/tmp/preview-empty-after-desktop.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);
  console.log('PASS mobile portrait empty-state layout, working draft CTA, no provider requests and no browser errors');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
