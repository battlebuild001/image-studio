const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {promisify}=require('node:util');
const execFile=promisify(require('node:child_process').execFile);
const {chromium}=require('playwright');

// This suite owns a native-export lease. Run it serially with every other native
// rendering suite. All inputs are synthetic and every external request is denied.
function wave(hz,seconds=2.4){const rate=24000,count=Math.round(rate*seconds),data=Buffer.alloc(44+count*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)data.writeInt16LE(Math.round(Math.sin(2*Math.PI*hz*i/rate)*.22*32767),44+i*2);return data;}
(async()=>{
 const base=process.env.STUDIO_URL||'http://127.0.0.1:4173/',browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true}),page=await context.newPage();page.setDefaultTimeout(30000);
 const errors=[],paid=[],external=[],pictures=await Promise.all(['image-test-1.png','image-test-2.png'].map(name=>fs.readFile(path.join(__dirname,'fixtures',name)).then(data=>data.toString('base64'))));
 page.on('pageerror',error=>errors.push(error.message));await context.route('https://**/*',route=>{external.push(route.request().url());return route.abort();});await context.route('**/api/**',route=>{if(route.request().method()==='POST')paid.push(route.request().url());return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:false})});});
 await context.addInitScript(()=>{const Native=window.MediaRecorder;window.__nativeStats={active:0,max:0,starts:0};window.MediaRecorder=class extends Native{start(...args){const stats=window.__nativeStats;stats.active++;stats.starts++;stats.max=Math.max(stats.max,stats.active);let done=false;const finish=()=>{if(!done){done=true;stats.active--;}};this.addEventListener('stop',finish,{once:true});this.addEventListener('error',finish,{once:true});try{return super.start(...args);}catch(error){finish();throw error;}}};});
 const stored=()=>page.evaluate(async()=>(await(await import('./bulk-video-store.js')).createBulkVideoStore().loadAll()).map(job=>({id:job.id,status:job.status,project:job.project,assets:[...job.assets].map(([id,value])=>({id,name:value.name,type:value.blob.type,bytes:value.blob.size})),video:job.video?{bytes:job.video.blob.size,extension:job.video.extension,digest:job.video.digest}:null})));
 try{
  await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#multiVideoBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);
  const original=await page.evaluate(async()=>(await(await import('./project.js')).loadProject()).project);
  await page.evaluate(async({pictures,voices})=>{
   const p=await import('./project.js'),{createBulkVideoStore}=await import('./bulk-video-store.js'),{prepareSimpleScriptProject}=await import('./simple-script-project.js'),store=createBulkVideoStore();
   const blob=(value,type)=>new Blob([Uint8Array.from(atob(value),c=>c.charCodeAt(0))],{type});
   for(let n=0;n<2;n++){
    const id='multi-native-'+n,assets=new Map([['voice',{blob:blob(voices[n],'audio/wav'),name:'native-'+(n?880:440)+'.wav',duration:2.4}],['image-a',{blob:blob(pictures[n],'image/png'),name:'첫 장면.png'}],['image-b',{blob:blob(pictures[1-n],'image/png'),name:'둘째 장면.png'}]]);
    const project=p.createProject({id,title:'동시 제작 '+(n+1),audio:{narrationId:'voice'},settings:{branding:false,transition:0,fontSize:48,bgmVolume:.2,ducking:false}});
    const planned=prepareSimpleScriptProject(project,assets,{text:(n?'둘째 영상은 우주 관측소를 설명합니다.':'첫 영상은 미니어처 전장을 설명합니다.')+'\n\n서로 다른 장면과 음성이 보존됩니다.',intervalSeconds:1.2}).project;planned.scenes[0].imageId='image-a';planned.scenes[1].imageId='image-b';
    const now=new Date().toISOString();await store.save({version:1,id,project:planned,assets,status:'pending',error:'',createdAt:now,updatedAt:now});
   }
  },{pictures,voices:[wave(440).toString('base64'),wave(880).toString('base64')]});
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#multiVideoBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);await page.locator('#multiVideoBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});
  await page.locator('#multiVideoConcurrency').selectOption('2');await page.locator('#multiVideoVoice').uncheck();await page.locator('#multiVideoPlanImages').uncheck();await page.locator('#multiVideoImages').uncheck();await page.locator('#multiVideoBgm').check();await page.locator('#multiVideoLocalReview').check();await page.locator('#multiVideoFormat').selectOption('mp4');await page.locator('#multiVideoResolution').selectOption('720');
  await page.locator('#multiVideoPrepareBtn').click();await page.waitForFunction(()=>!document.querySelector('#multiVideoConfirm').disabled);assert.equal(paid.length,0);await page.evaluate(()=>{window.__nativeStats={active:0,max:0,starts:0};});await page.locator('#multiVideoConfirm').check();await page.locator('#multiVideoStartBtn').click();
  await page.waitForFunction(()=>{const items=[...document.querySelectorAll('[data-multi-job]')];return items.length===2&&items.every(item=>item.dataset.status==='completed');},undefined,{timeout:90000});await page.waitForFunction(()=>!document.querySelector('#multiVideoCloseBtn').disabled);
  const stats=await page.evaluate(()=>window.__nativeStats);assert.equal(stats.max,1,'Only one real MediaRecorder is active at a time');assert.equal(stats.starts,2);assert.equal(stats.active,0);
  const values=await stored();assert.equal(values.length,2);for(const value of values){assert.ok(value.project.audio.bgmId);assert.ok(value.assets.some(asset=>asset.id===value.project.audio.bgmId&&asset.type==='audio/wav'));assert.ok(value.video?.bytes>10000);assert.equal(value.video.extension,'mp4');}
  const outputs=[];
  for(let n=0;n<2;n++){
   const data=await page.evaluate(async id=>{const job=await(await import('./bulk-video-store.js')).createBulkVideoStore().get(id),bytes=new Uint8Array(await job.video.blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);},'multi-native-'+n),file=`/tmp/multi-video-native-${n}.mp4`;await fs.writeFile(file,Buffer.from(data,'base64'));
   const probe=JSON.parse((await execFile('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file],{maxBuffer:4*1024*1024})).stdout),video=probe.streams.find(stream=>stream.codec_type==='video'),audio=probe.streams.find(stream=>stream.codec_type==='audio');assert.ok(video&&audio);assert.equal(video.width,1280);assert.equal(video.height,720);assert.ok(Number(probe.format.duration)>2.2&&Number(probe.format.duration)<3.2);
   const raw=(await execFile('ffmpeg',['-v','error','-i',file,'-vn','-ac','1','-ar','24000','-f','f32le','pipe:1'],{encoding:null,maxBuffer:4*1024*1024})).stdout,samples=new Float32Array(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength));
   const energy=hz=>{let re=0,im=0;const slice=samples.slice(24000*.3,24000*1.1);for(let i=0;i<slice.length;i++){re+=slice[i]*Math.cos(2*Math.PI*hz*i/24000);im+=slice[i]*Math.sin(2*Math.PI*hz*i/24000);}return(re*re+im*im)/slice.length**2;};const own=energy(n?880:440),other=energy(n?440:880);assert.ok(own>.002&&own>other*20,'Narration must belong to this video: '+JSON.stringify({own,other}));
   const verification=await page.evaluate(async id=>{
    const job=await(await import('./bulk-video-store.js')).createBulkVideoStore().get(id),engine=await import('./engine.js');await engine.prepareAssets(job.assets);
    const asset=job.assets.get(job.project.audio.bgmId),window=engine.getAudioWindow(job.project,job.assets,'bgm'),source=asset.audioBuffer.getChannelData(0),music=new Float32Array(Math.round(24000*2.4));
    for(let i=0;i<music.length;i++){const t=i/24000,pos=(window.start+t%window.duration)*asset.audioBuffer.sampleRate,lo=Math.floor(pos),f=pos-lo;music[i]=((source[lo]||0)*(1-f)+(source[Math.min(lo+1,source.length-1)]||0)*f)*engine.getAudioGain(job.project,job.assets,'bgm',t);}
    let binary='';const bytes=new Uint8Array(music.buffer);for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
    const media=document.createElement('video');media.muted=true;media.src=URL.createObjectURL(job.video.blob);document.body.append(media);await new Promise((resolve,reject)=>{media.onloadedmetadata=resolve;media.onerror=reject;});
    const a=document.createElement('canvas'),b=document.createElement('canvas');a.width=b.width=1280;a.height=b.height=720;const ca=a.getContext('2d',{willReadFrequently:true}),cb=b.getContext('2d',{willReadFrequently:true}),frames=[];
    function diff(x,y){let sum=0,count=0;for(let row=440;row<715;row+=3)for(let column=40;column<1240;column+=3){const at=(row*1280+column)*4;for(let c=0;c<3;c++)sum+=Math.abs(x[at+c]-y[at+c]);count+=3;}return sum/count;}
    for(const t of[.65,1.65]){await new Promise(resolve=>{media.onseeked=resolve;media.currentTime=t;});ca.drawImage(media,0,0,1280,720);const actual=ca.getImageData(0,0,1280,720).data;engine.renderFrame(cb,job.project,job.assets,t);const yes=cb.getImageData(0,0,1280,720).data;engine.renderFrame(cb,{...job.project,settings:{...job.project.settings,subtitles:false}},job.assets,t);const no=cb.getImageData(0,0,1280,720).data;frames.push({t,captionError:diff(actual,yes),missingCaptionError:diff(actual,no)});}
    URL.revokeObjectURL(media.src);media.remove();for(const value of job.assets.values()){if(value.url)URL.revokeObjectURL(value.url);value.image?.close?.();}return{music:btoa(binary),frames};
   },'multi-native-'+n);
   for(const frame of verification.frames){assert.ok(frame.captionError<12,JSON.stringify(frame));assert.ok(frame.captionError+.5<frame.missingCaptionError,JSON.stringify(frame));}
   const musicBytes=Buffer.from(verification.music,'base64'),music=new Float32Array(musicBytes.buffer.slice(musicBytes.byteOffset,musicBytes.byteOffset+musicBytes.byteLength)),hz=n?880:440,start=Math.round(.5*24000),length=Math.round(.8*24000);
   function withoutTone(values){const out=new Float32Array(values);let sin=0,cos=0;for(let i=0;i<out.length;i++){sin+=out[i]*Math.sin(2*Math.PI*hz*i/24000);cos+=out[i]*Math.cos(2*Math.PI*hz*i/24000);}sin*=2/out.length;cos*=2/out.length;for(let i=0;i<out.length;i++)out[i]-=sin*Math.sin(2*Math.PI*hz*i/24000)+cos*Math.cos(2*Math.PI*hz*i/24000);return out;}
   const expected=withoutTone(music.slice(start,start+length));let ep=0;for(const value of expected)ep+=value*value;assert.ok(Math.sqrt(ep/length)>.0005);let correlation=-1;
   for(let offset=-6000;offset<=6000;offset+=12){const at=start+offset;if(at<0||at+length>samples.length)continue;const actual=withoutTone(samples.slice(at,at+length));let dot=0,power=0;for(let i=0;i<length;i++){dot+=actual[i]*expected[i];power+=actual[i]*actual[i];}correlation=Math.max(correlation,dot/Math.sqrt(ep*power));}
   assert.ok(correlation>.7,'Generated music must really be audible in the exported mix: '+correlation);
   outputs.push({file,duration:Number(probe.format.duration),width:video.width,height:video.height,voiceHz:n?880:440,voiceEnergy:own,bgmCorrelation:correlation,frames:verification.frames});
  }
  await page.locator('[data-multi-edit="multi-native-0"]').click();await page.locator('#multiVideoEditorBanner').waitFor({state:'visible'});await page.locator('#multiVideoReturnBtn').click();await page.locator('#multiVideoDialog').waitFor({state:'visible'});assert.equal((await stored()).every(job=>job.video?.bytes>10000),true,'Opening a completed job and saving must preserve both cached native videos');
  await page.locator('#multiVideoCloseBtn').click();assert.deepEqual(await page.evaluate(async()=>(await(await import('./project.js')).loadProject()).project),original);await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#multiVideoBtn')&&!document.querySelector('#addWorkspaceBtn').disabled);assert.deepEqual((await stored()).map(job=>job.video.digest),values.map(job=>job.video.digest));assert.equal(paid.length,0);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  const result={passed:true,nativeStats:stats,outputs,generatedBgm:true,completedEditorRoundTrip:true,reload:true,providerRequests:0};await fs.writeFile('/tmp/multi-video-native-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
