const assert=require('node:assert/strict');

/** Inspect an existing real exported file; this does not create another video. */
async function inspectSeriesExport(page,{videoBase64,mimeType,imageBase64,caption}){
 const result=await page.evaluate(async input=>{
  const {createProject,createScene}=await import('./project.js'),{renderFrame}=await import('./engine.js');
  const decode=value=>Uint8Array.from(atob(value),character=>character.charCodeAt(0)),imageBlob=new Blob([decode(input.imageBase64)],{type:'image/png'}),image=await createImageBitmap(imageBlob),assets=new Map([['frame',{blob:imageBlob,image}]]);
  const project=createProject({aspect:'9:16',title:'원본 시리즈',scenes:[createScene({imageId:'frame',caption:input.caption,duration:2,motion:'none',fit:'cover'})],captionMode:'srt',captions:[{start:0,end:2,text:input.caption}],settings:{branding:false,subtitles:true,aiImageNotice:true,aiImageNoticePosition:'bottom-right',transition:0,bgmVolume:.12}});
  const blob=new Blob([decode(input.videoBase64)],{type:input.mimeType}),url=URL.createObjectURL(blob),video=document.createElement('video');video.muted=true;video.preload='auto';video.src=url;document.body.append(video);
  try{
   await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(new Error('내보낸 시리즈 영상을 재생하지 못했어요.'));});
   video.currentTime=.7;await new Promise((resolve,reject)=>{video.onseeked=resolve;video.onerror=()=>reject(new Error('시리즈 프레임을 찾지 못했어요.'));});
   const canvas=document.createElement('canvas');canvas.width=720;canvas.height=1280;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(video,0,0,720,1280);const actual=ctx.getImageData(0,0,720,1280).data;
   renderFrame(ctx,project,assets,.7,720,1280);const expected=ctx.getImageData(0,0,720,1280).data;
   function maskError(changed){renderFrame(ctx,changed,assets,.7,720,1280);const other=ctx.getImageData(0,0,720,1280).data;let pixels=0,on=0,off=0;for(let index=0;index<actual.length;index+=4){const delta=Math.abs(expected[index]-other[index])+Math.abs(expected[index+1]-other[index+1])+Math.abs(expected[index+2]-other[index+2]);if(delta<30)continue;pixels++;for(let channel=0;channel<3;channel++){on+=Math.abs(actual[index+channel]-expected[index+channel]);off+=Math.abs(actual[index+channel]-other[index+channel]);}}return{pixels,onError:on/(pixels*3),offError:off/(pixels*3)};}
   const noCaption=structuredClone(project);noCaption.settings.subtitles=false;const noNotice=structuredClone(project);noNotice.settings.aiImageNotice=false;const noImage=structuredClone(project);noImage.scenes[0].imageId=null;
   const context=new OfflineAudioContext(1,1,24000),audio=await context.decodeAudioData(await blob.arrayBuffer()),samples=audio.getChannelData(0);let sum=0;for(let i=0;i<samples.length;i++)sum+=samples[i]*samples[i];
   return{width:video.videoWidth,height:video.videoHeight,duration:video.duration,frameTime:video.currentTime,captions:maskError(noCaption),notice:maskError(noNotice),images:maskError(noImage),audioSeconds:audio.duration,rms:Math.sqrt(sum/samples.length)};
  }finally{video.pause();video.remove();URL.revokeObjectURL(url);image.close();}
 },{videoBase64,mimeType,imageBase64,caption});
 assert.equal(result.width,720);assert.equal(result.height,1280);assert.ok(result.duration>1.7&&result.duration<3);assert.ok(result.audioSeconds>1.7&&result.audioSeconds<3);assert.ok(result.rms>.005,JSON.stringify(result));
 for(const name of['captions','notice','images']){assert.ok(result[name].pixels>500,JSON.stringify(result));assert.ok(result[name].onError<result[name].offError*.65,`${name} decoded frame must match actual composition: `+JSON.stringify(result));}
 return result;
}
module.exports={inspectSeriesExport};
