const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {promisify}=require('node:util');
const run=promisify(require('node:child_process').execFile);
const {output,wait,exists,launchDesktop,installDialogMocks,stored,stopDesktop}=require('./desktop-app.browser.cjs');

function wave(voice=false){
 const rate=24000,count=rate*2.5,bytes=Buffer.alloc(44+count*2);
 bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(count*2,40);
 for(let index=0;index<count;index++){const at=index/rate,frequency=voice?(at>=.2&&at<1.2?440:at>=1.4&&at<2.4?880:0):110,amplitude=voice?.35:.035;bytes.writeInt16LE(frequency?Math.round(Math.sin(2*Math.PI*frequency*at)*amplitude*32767):0,44+index*2);}
 return bytes;
}

async function backupForExport(page){
 const files={};for(const name of['image-test-1.png','image-test-2.png'])files[name]=(await fs.readFile(path.join(__dirname,'fixtures',name))).toString('base64');files.voice=wave(true).toString('base64');files.bgm=wave().toString('base64');
 return page.evaluate(async files=>{
  const p=await import('./project.js'),blob=(name,type)=>new Blob([Uint8Array.from(atob(files[name]),value=>value.charCodeAt(0))],{type});
  const project=p.createProject({id:'desktop-export-fixture',title:'데스크톱 실제 영상과 자막 싱크',scenes:[p.createScene({id:'intro',imageId:'intro',duration:.5,motion:'none'}),p.createScene({id:'one',imageId:'one',duration:1,motion:'none',caption:'첫 번째 발화입니다.'}),p.createScene({id:'two',imageId:'two',duration:1,motion:'none',caption:'두 번째 발화입니다.'}),p.createScene({id:'outro',imageId:'outro',duration:.5,motion:'none'})],audio:{narrationId:'voice',narrationOffset:.5,bgmId:'bgm'},settings:{branding:false,transition:0,fontSize:54,aiImageNotice:true,aiImageNoticePosition:'bottom-right',bgmVolume:.12,ducking:false},captionMode:'speech',captions:[{start:.2,end:1.2,text:'첫 번째 발화입니다.'},{start:1.4,end:2.4,text:'두 번째 발화입니다.'}],captionAnalysis:{narrationId:'voice',sourceStart:0,sourceEnd:2.5,language:'ko',model:'whisper-1',granularity:'word',createdAt:'2026-11-04T10:00:00.000Z'}});
  const first=blob('image-test-1.png','image/png'),second=blob('image-test-2.png','image/png'),assets=new Map([['intro',{blob:first,name:'인트로.png'}],['one',{blob:first,name:'첫 장면.png'}],['two',{blob:second,name:'다음 장면.png'}],['outro',{blob:second,name:'아웃트로.png'}],['voice',{blob:blob('voice','audio/wav'),name:'시점 검증 음성.wav'}],['bgm',{blob:blob('bgm','audio/wav'),name:'시점 검증 배경음악.wav'}]]);
  return(await p.exportProjectBackup(project,assets)).text();
 },files);
}

async function decodedFrames(page){
 return page.evaluate(async()=>{
  const p=await import('./project.js'),engine=await import('./engine.js'),loaded=await p.loadProject();await engine.prepareAssets(loaded.assets);
  const media=document.createElement('video');media.muted=true;media.src=document.querySelector('#downloadVideoLink').href;
  await new Promise((resolve,reject)=>{media.onloadedmetadata=resolve;media.onerror=()=>reject(new Error('The exported video cannot be decoded by the desktop runtime.'));});
  const samples=[];
  for(const at of[.25,.9,2.1,3.25]){
   await new Promise(resolve=>{media.onseeked=resolve;media.currentTime=at;});
   const actual=document.createElement('canvas'),expected=document.createElement('canvas');actual.width=expected.width=1280;actual.height=expected.height=720;
   actual.getContext('2d').drawImage(media,0,0);engine.renderFrame(expected.getContext('2d'),loaded.project,loaded.assets,at,1280,720);
   const a=actual.getContext('2d').getImageData(0,0,1280,720).data,b=expected.getContext('2d').getImageData(0,0,1280,720).data;let difference=0;
   for(let index=0;index<a.length;index+=4)difference+=Math.abs(a[index]-b[index])+Math.abs(a[index+1]-b[index+1])+Math.abs(a[index+2]-b[index+2]);
   samples.push({at,meanPixelDifference:difference/(1280*720*3),caption:p.getCaptions(loaded.project).find(cue=>cue.start<=at&&cue.end>at)?.text||'',png:actual.toDataURL('image/png').split(',')[1]});
  }
  const duration=media.duration;media.removeAttribute('src');media.load();return{duration,samples};
 });
}

function audioSegment(raw,start,end){
 const values=[];for(let index=Math.floor(start*24000);index<Math.floor(end*24000)&&index*4+4<=raw.length;index++)values.push(raw.readFloatLE(index*4));
 const rms=Math.sqrt(values.reduce((sum,value)=>sum+value*value,0)/values.length),power=frequency=>{let real=0,imaginary=0;for(let index=0;index<values.length;index++){const phase=2*Math.PI*frequency*index/24000;real+=values[index]*Math.cos(phase);imaginary+=values[index]*Math.sin(phase);}return(real*real+imaginary*imaginary)/(values.length*values.length);};
 return{start,end,rms,p440:power(440),p880:power(880)};
}

(async()=>{
 await fs.mkdir(output,{recursive:true});const profile=await fs.mkdtemp(path.join(os.tmpdir(),'content-studio-export-'));let runtime;
 try{
  runtime=await launchDesktop(profile);const{app,page}=runtime,backup=await backupForExport(page);
  await page.locator('#projectInput').setInputFiles({name:'데스크톱 싱크 검증.bth.json',mimeType:'application/json',buffer:Buffer.from(backup)});await stored(page,value=>value.id==='desktop-export-fixture');
  await page.locator('#productionRunBtn').click();await page.locator('#productionRunFreeBtn').click();await page.locator('#productionRunSync').selectOption('local');await page.waitForFunction(()=>document.querySelector('#productionRunConfirm')&&!document.querySelector('#productionRunConfirm').disabled);await page.locator('#productionRunConfirm').check();await page.waitForFunction(()=>!document.querySelector('#startProductionRunBtn').disabled);await page.locator('#startProductionRunBtn').click();
  const repaired=await stored(page,value=>value.production?.run?.status==='completed','completed desktop local production pipeline');assert.deepEqual(repaired.scenes.map(scene=>scene.duration),[.5,1.25,1.25,.5]);assert.deepEqual(repaired.captions,JSON.parse(backup).project.captions);await page.locator('#closeProductionRunBtn').click();
  console.log('PASS the real desktop one-run local workflow synchronizes protected title cards, original speech captions and original voice without contacting providers');

  await page.locator('#exportBtn').click();await page.waitForFunction(()=>!document.querySelector('#startExportBtn').disabled);
  const capabilities=await page.evaluate(()=>(import('./engine.js')).then(engine=>engine.getExportCapabilities()));
  const requested=process.env.CONTENT_STUDIO_DESKTOP_TEST_FORMAT||'mp4',format=requested==='auto'?(capabilities.mp4?'mp4':'webm'):requested;
  assert.ok(capabilities[format],`The actual Electron runtime cannot export ${format.toUpperCase()}: ${capabilities.reason||'no encoder'}`);
  const file=path.join(output,'desktop-native-synchronized-3.5s.'+format);await fs.rm(file,{force:true});await installDialogMocks(app,{savePath:file});
  await page.locator('#exportFormat').selectOption(format);await page.locator('#exportResolution').selectOption('720');
  console.log('EXPORT START actual Electron native '+format.toUpperCase()+' with decoded-frame and decoded-audio checks');
  await page.locator('#startExportBtn').click();await page.locator('#exportComplete').waitFor({state:'visible',timeout:90000});await page.locator('#downloadVideoLink').click();
  for(let attempt=0;attempt<600;attempt++){if(await exists(file)&&((await fs.stat(file)).size>10000))break;await wait(50);}
  assert.equal(await exists(file),true,'The native Save dialog must write the finished video to disk');
  const nativeTrace=await app.evaluate(()=>globalThis.__desktopDialogControl);assert.equal(nativeTrace.saved.length,1);
  const probe=JSON.parse((await run('ffprobe',['-v','error','-show_streams','-show_packets','-of','json',file],{maxBuffer:8*1024*1024})).stdout),video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');
  assert.equal(video.width,1280);assert.equal(video.height,720);assert.ok(audio);const ends=probe.streams.map(stream=>Math.max(...probe.packets.filter(packet=>packet.stream_index===stream.index).map(packet=>Number(packet.pts_time||0)+Number(packet.duration_time||0))));assert.ok(ends.every(at=>at>3.3&&at<3.8),JSON.stringify(ends));
  console.log('PASS the native Save dialog writes an actual 720p '+format.toUpperCase()+' file with complete synchronized video and audio streams');

  const decoded=await decodedFrames(page);for(const sample of decoded.samples){assert.ok(sample.meanPixelDifference<12,JSON.stringify({at:sample.at,error:sample.meanPixelDifference}));await fs.writeFile(path.join(output,'desktop-native-frame-'+sample.at+'.png'),Buffer.from(sample.png,'base64'));}assert.deepEqual(decoded.samples.map(sample=>Boolean(sample.caption)),[false,true,true,false]);
  const pcm=path.join(output,'desktop-native-audio.f32');await run('ffmpeg',['-y','-v','error','-i',file,'-vn','-ac','1','-ar','24000','-f','f32le',pcm]);const raw=await fs.readFile(pcm),first=audioSegment(raw,.95,1.2),second=audioSegment(raw,2.05,2.3),quiet=audioSegment(raw,1.76,1.84);
  assert.ok(first.rms>.08&&second.rms>.08);assert.ok(quiet.rms<first.rms*.2);assert.ok(first.p440>first.p880*20);assert.ok(second.p880>second.p440*20);assert.deepEqual(runtime.errors,[]);assert.deepEqual(runtime.external,[]);
  const result={passed:true,groups:3,actualElectron:true,hostPlatform:process.platform,windowsRuntimeExecuted:process.platform==='win32',nativeSaveDialog:true,format,videoCodec:video.codec_name,audioCodec:audio.codec_name,width:video.width,height:video.height,ends,nativeDuration:decoded.duration,sceneDurations:repaired.scenes.map(scene=>scene.duration),visibleCues:[{start:.7,end:1.7},{start:1.9,end:2.9}],frames:decoded.samples.map(({png,...rest})=>rest),audio:{first,second,quiet},oneRunCompleted:true,realProviderRequests:0,realGoogleRequests:0,file};await fs.writeFile(path.join(os.tmpdir(),'desktop-native-export-result.json'),JSON.stringify(result,null,2)+'\n');
  console.log('PASS actual desktop export pixels contain the expected images and timed subtitles; decoded 440/880 Hz voice pulses match their corresponding caption windows and preserve the silent pause');console.log('EXPORT END actual Electron native '+format.toUpperCase());
 }catch(cause){await runtime?.page?.screenshot({path:path.join(output,'desktop-export-failure.png'),fullPage:true}).catch(()=>{});if(runtime)console.error('Desktop export UI:',await runtime.page.locator('#syncError,#exportProgressText,#exportWarning,#toastArea').allTextContents().catch(()=>[]));throw cause;}
 finally{await stopDesktop(runtime?.app);}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
