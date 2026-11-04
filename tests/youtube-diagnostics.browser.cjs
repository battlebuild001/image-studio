const assert=require('node:assert/strict');
const {chromium}=require('playwright');

// Real editor + OAuth client + upload form. Every Google response is intercepted;
// the synthetic file is never rendered, sent to Google or published.
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),context=await browser.newContext({viewport:{width:1400,height:1050}}),page=await context.newPage();
 const token='synthetic-diagnostics-token-not-a-real-credential',clientId='123456789012-diagnostics.apps.googleusercontent.com',channelId='UC'+'d'.repeat(22),calls=[],errors=[],unexpected=[];
 let channelReason='SERVICE_DISABLED',uploadReason='quotaExceeded';
 page.setDefaultTimeout(18000);page.on('pageerror',cause=>errors.push(cause.message));
 await context.addInitScript(({token})=>{window.__oauthDiagnosticError='';window.__oauthDiagnosticCalls=0;window.google={accounts:{oauth2:{initTokenClient(config){return{requestAccessToken(){window.__oauthDiagnosticCalls++;queueMicrotask(()=>config.callback(window.__oauthDiagnosticError?{error:window.__oauthDiagnosticError,error_description:token}:{access_token:token,expires_in:3600,scope:config.scope}));}};},revoke(_token,done){done?.();}}}};},{token});
 await context.route('https://**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.hostname!=='www.googleapis.com'){unexpected.push(request.url());return route.abort();}
  calls.push({method:request.method(),path:url.pathname});const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS'};
  if(request.method()==='OPTIONS')return route.fulfill({status:204,headers});
  if(url.pathname==='/youtube/v3/channels')return route.fulfill({status:channelReason?403:200,headers,contentType:'application/json',body:JSON.stringify(channelReason?{error:{message:token,details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:channelReason,metadata:{credential:token}}]}}:{items:[{id:channelId,snippet:{title:'모의 진단 채널'}}]})});
  assert.equal(url.pathname,'/upload/youtube/v3/videos');assert.equal(request.method(),'POST');
  return route.fulfill({status:403,headers,contentType:'application/json',body:JSON.stringify({error:{message:token,errors:[{reason:uploadReason,message:token}]}})});
 });
 const connect=()=>page.locator('#connectYouTubeBtn').click();
 const waitError=reason=>page.waitForFunction(reason=>document.querySelector('#youtubeUploadError').textContent.includes(reason)&&!document.querySelector('#connectYouTubeBtn').disabled,reason);
 try{
  await page.goto(process.env.STUDIO_URL||'http://127.0.0.1:4173/',{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#videoUploadBtn')&&!document.querySelector('#videoUploadBtn').disabled);
  await page.locator('#videoUploadBtn').click();await page.locator('#uploadTab-youtube').click();await page.locator('#youtubeClientId').fill(clientId);await page.locator('#saveYouTubeClientBtn').click();
  await page.locator('#youtubeTitle').fill('수동 제목 보존');await page.locator('#youtubeDescription').fill('오류가 나도 보존할 설명');
  await connect();await page.waitForFunction(()=>document.querySelector('#youtubeUploadStatus').textContent.includes('아직 채널에 연결되지 않았'));assert.equal(calls.length,0);assert.equal(await page.evaluate(()=>window.__oauthDiagnosticCalls),0);
  await connect();await waitError('SERVICE_DISABLED');assert.match(await page.locator('#youtubeUploadError').innerText(),/채널 확인 중.*같은 Google Cloud 프로젝트/u);assert.equal(await page.locator('#youtubeUploadStatus').innerText(),'');assert.equal(await page.evaluate(()=>document.querySelector('#youtubeUploadError').parentElement.contains(document.querySelector('#connectYouTubeBtn'))),true);assert.equal(calls.filter(item=>item.method==='GET').length,1);assert.equal(calls.filter(item=>item.method==='POST').length,0);
  channelReason='ACCESS_TOKEN_SCOPE_INSUFFICIENT';await connect();await waitError('ACCESS_TOKEN_SCOPE_INSUFFICIENT');assert.match(await page.locator('#youtubeUploadError').innerText(),/모두 허용/u);
  await page.evaluate(()=>window.__oauthDiagnosticError='access_denied');const before=calls.length;await connect();await waitError('access_denied');assert.match(await page.locator('#youtubeUploadError').innerText(),/테스트 상태라면.*테스트 사용자/u);assert.equal(calls.length,before);
  assert.equal(await page.locator('#youtubeTitle').inputValue(),'수동 제목 보존');assert.equal(await page.locator('#youtubeDescription').inputValue(),'오류가 나도 보존할 설명');assert.equal((await page.locator('#videoUploadDialog').innerText()).includes(token),false);
  console.log('PASS SDK readiness is explicitly separate from channel connection; actual channel/OAuth failures show distinct safe actions beside the connection controls and clear stale success while preserving drafts');

  await page.evaluate(()=>window.__oauthDiagnosticError='');channelReason='';await connect();await page.waitForFunction(()=>document.querySelector('#youtubeChannelStatus').textContent.includes('모의 진단 채널')&&!document.querySelector('#disconnectYouTubeBtn').disabled);
  await page.locator('#youtubeVideoSource').selectOption('file');await page.locator('#youtubeVideoInput').setInputFiles({name:'synthetic-diagnostic.webm',mimeType:'video/webm',buffer:Buffer.alloc(32,19)});await page.locator('#uploadYouTubeBtn').click();await page.waitForFunction(()=>document.querySelector('#youtubeUploadError').textContent.includes('quotaExceeded')&&!document.querySelector('#uploadYouTubeBtn').disabled);
  assert.match(await page.locator('#youtubeUploadError').innerText(),/업로드 요청 중.*할당량/u);assert.equal(await page.locator('#youtubeUploadStatus').innerText(),'');assert.equal(calls.filter(item=>item.method==='POST').length,1);assert.equal(calls.filter(item=>item.method==='PUT').length,0);
  uploadReason='unrecognized-provider-reason-'+token;await page.locator('#uploadYouTubeBtn').click();await page.waitForFunction(()=>document.querySelector('#youtubeUploadError').textContent.includes('원인인지 확정할 수 없어요')&&!document.querySelector('#uploadYouTubeBtn').disabled);assert.equal(calls.filter(item=>item.method==='POST').length,2);assert.equal((await page.locator('#videoUploadDialog').innerText()).includes(token),false);
  await page.setViewportSize({width:390,height:844});await page.locator('#youtubeUploadError').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'/tmp/youtube-diagnostics-mobile.png',fullPage:true});assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  console.log('PASS actual upload form distinguishes quota from unknown403, never retries or sends media after refused initialization, redacts provider text and fits mobile; no live Google calls or video export');
 }catch(cause){await page.screenshot({path:'/tmp/youtube-diagnostics-failure.png',fullPage:true}).catch(()=>{});console.error(await page.locator('#youtubeUploadError,#youtubeUploadStatus').allTextContents().catch(()=>[]));throw cause;}
 finally{await browser.close();}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
