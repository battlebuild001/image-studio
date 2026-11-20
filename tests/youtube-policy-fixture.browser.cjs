const assert=require('node:assert/strict');

/** Synthetic status transport for UI feature tests. Media always starts private;
 * the real PNG must arrive before any reviewed public/scheduled status update. */
function createYouTubePolicyFixture({videoId,channelId,headers}){
 const thumbnails=[],publications=[];let status={privacyStatus:'private'};
 async function handle(route){
  const request=route.request(),url=new URL(request.url());
  if(url.pathname==='/upload/youtube/v3/thumbnails/set'){
   assert.equal(request.method(),'POST');assert.equal(url.searchParams.get('videoId'),videoId);
   const bytes=request.postDataBuffer();assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
   thumbnails.push(bytes);await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({kind:'youtube#thumbnailSetResponse',items:[{default:{width:1280,height:720}}]})});return true;
  }
  if(url.pathname!=='/youtube/v3/videos')return false;
  if(request.method()==='GET'){
   assert.equal(url.searchParams.get('id'),videoId);await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({items:[{id:videoId,snippet:{channelId},status}]})});return true;
  }
  assert.equal(request.method(),'PUT');const value=request.postDataJSON();assert.equal(value.id,videoId);assert.ok(thumbnails.length,'A real PNG must be sent before publication');
  status=value.status;publications.push(value);await route.fulfill({headers,contentType:'application/json',body:JSON.stringify({id:videoId,snippet:{channelId},status})});return true;
 }
 return{handle,thumbnails,publications};
}
async function selectRequiredThumbnail(page){
 await page.locator('#youtubeThumbnailSelect').selectOption('0');
 await page.waitForFunction(()=>!document.querySelector('#youtubeThumbnailPreview').hidden&&!document.querySelector('#youtubeThumbnailSelect').disabled);
}
module.exports={createYouTubePolicyFixture,selectRequiredThumbnail};
