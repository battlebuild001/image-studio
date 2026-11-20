const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {launchDesktop,stopDesktop}=require('./desktop-app.browser.cjs');

// The production Electron net.request adapter downloads the actual public release.
// Only the comparison version/platform are injected to exercise an offered upgrade.
// The installer is hashed and inspected, but launch/quit are prohibited callbacks.
(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'content-studio-update-download-profile-'));
 const output=path.join(os.tmpdir(),'desktop-update-download-result.json');
 let runtime;
 try{
  runtime=await launchDesktop(profile);const {app}=runtime;
  const application=await app.evaluate(({app})=>({version:app.getVersion(),isPackaged:app.isPackaged,appPath:app.getAppPath()}));
  if(process.env.CONTENT_STUDIO_PACKAGED==='1')assert.equal(application.isPackaged,true);
  const result=await app.evaluate(async({app,net})=>{
   const req=process.mainModule.require.bind(process.mainModule),fs=req('node:fs/promises'),syncFs=req('node:fs'),path=req('node:path'),os=req('node:os'),crypto=req('node:crypto');
   const {createDesktopUpdater,RELEASE_API}=req(path.join(app.getAppPath(),'desktop','updater.cjs'));
   const {createElectronUpdateFetch}=req(path.join(app.getAppPath(),'desktop','update-transport.cjs'));
   const directory=await fs.mkdtemp(path.join(os.tmpdir(),'content-studio-verified-update-'));
   // Observe the OS alias without replacing the caller's original input path.
   const canonicalDirectory=await fs.realpath(directory),originalInfo=await fs.lstat(directory,{bigint:true}),canonicalInfo=await fs.lstat(canonicalDirectory,{bigint:true});
   const aliasChanged=directory!==canonicalDirectory,samePhysicalDirectory=originalInfo.dev===canonicalInfo.dev&&originalInfo.ino===canonicalInfo.ino;
   const allowed=new Set(['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
   const events=[],progress=[];let metadata,controller,launches=0,quits=0,report;
   const safeError=cause=>({name:String(cause?.name||'Error'),code:String(cause?.code||''),message:String(cause?.message||'').replace(/https?:\/\/[^\s'"<>]+/giu,'[URL]').slice(0,500)});
   const transport=createElectronUpdateFetch({request:options=>net.request(options)});
   const fetchImpl=async(url,options)=>{
    const parsed=new URL(url);if(!allowed.has(parsed.hostname)||parsed.protocol!=='https:')throw Error('Unexpected update transport host');
    if(options.credentials!=='omit'||options.redirect!=='manual'||Object.keys(options.headers||{}).some(name=>/authorization|cookie|api.key/iu.test(name)))throw Error('The updater must not forward credentials');
    const event={host:parsed.hostname};events.push(event);
    try{
     const response=await transport(url,options);event.status=response.status;
     const location=response.headers.get('location');if(location)event.redirectHost=new URL(location,url).hostname;
     if(url===RELEASE_API)metadata=await response.clone().json();
     return response;
    }catch(cause){event.error=safeError(cause);throw cause;}
   };
   try{
    controller=createDesktopUpdater({currentVersion:'1.1.1',directory,platform:'win32',architecture:'x64',isPackaged:true,distribution:'installed',fetchImpl,metadataTimeoutMs:45000,downloadTimeoutMs:240000,
     launch:async()=>{launches++;throw Error('This verification must never execute an installer');},quit:()=>{quits++;throw Error('This verification must never quit for installation');},
     onProgress:value=>{const last=progress.at(-1);if(!last||last.status!==value.status||value.progress>=last.progress+.1)progress.push({status:value.status,downloadedBytes:value.downloadedBytes||0,progress:value.progress||0});}});
    const offered=await controller.check();if(offered.status!=='available')throw Error('The real release must offer an upgrade from the injected comparison version');
    const completed=await controller.download();if(completed.status!=='ready'||completed.progress!==1||completed.downloadedBytes!==completed.bytes)throw Error('The production updater did not finish file verification');
    const name=`Content-Studio-Setup-${completed.version}-x64.exe`,asset=metadata?.assets?.find(value=>value.name===name);
    if(!asset||asset.state!=='uploaded'||asset.size!==completed.bytes||!/^sha256:[a-f0-9]{64}$/u.test(asset.digest||''))throw Error('The downloaded file is not the offered public release asset');
    const folders=await fs.readdir(directory,{withFileTypes:true}),privateFolders=folders.filter(value=>value.isDirectory()&&/^download-[A-Za-z0-9_-]+$/u.test(value.name));
    if(privateFolders.length!==1)throw Error('Expected exactly one privately downloaded installer');
    const file=path.join(directory,privateFolders[0].name,name),info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size!==asset.size)throw Error('The verified installer file changed');
    const hash=crypto.createHash('sha256');for await(const bytes of syncFs.createReadStream(file))hash.update(bytes);const sha256=hash.digest('hex');
    if(asset.digest!=='sha256:'+sha256)throw Error('Independent SHA-256 verification did not match GitHub');
    const handle=await fs.open(file,'r');const header=Buffer.alloc(1024);try{await handle.read(header,0,header.length,0);}finally{await handle.close();}
    const offset=header.readUInt32LE(60);if(header.subarray(0,2).toString()!=='MZ'||offset<64||offset>header.length-6||header.subarray(offset,offset+4).toString('binary')!=='PE\0\0'||![0x14c,0x8664].includes(header.readUInt16LE(offset+4)))throw Error('The real download is not a Windows PE installer');
    if(launches||quits)throw Error('An installer was unexpectedly executed');
    report={passed:true,transport:'electron-net-request',comparisonVersion:'1.1.1',offeredVersion:completed.version,bytes:info.size,sha256,realDownload:true,verifiedInstaller:true,independentSha256:true,windowsPeVerified:true,installerNotExecuted:true,installerLaunches:launches,installerQuitCalls:quits,metadataVersion:metadata.tag_name,requestEvents:events,progress};
   }catch(cause){report={passed:false,transport:'electron-net-request',error:safeError(cause),state:controller?.getState?.(),requestEvents:events,progress,installerNotExecuted:launches===0&&quits===0,installerLaunches:launches,installerQuitCalls:quits};}
   finally{controller?.dispose();await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
   return{...report,aliasChanged,samePhysicalDirectory};
  });
  const report={...result,hostPlatform:process.platform,windowsRuntimeExecuted:process.platform==='win32',actualElectron:true,application,realProviderRequests:0,realGoogleRequests:0};
  await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
  assert.equal(report.passed,true,'The real Electron update download must finish SHA-256 and PE verification');assert.equal(report.realDownload,true);assert.equal(report.verifiedInstaller,true);assert.equal(report.installerNotExecuted,true);
  assert.deepEqual(runtime.errors,[]);assert.deepEqual(runtime.external,[]);
  console.log('PASS the actual production Electron redirect transport downloads a complete public installer and independently verifies SHA-256/PE without executing it');
 }finally{await stopDesktop(runtime?.app);}
})().catch(cause=>{console.error(cause);process.exitCode=1;});
