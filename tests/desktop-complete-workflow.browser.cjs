const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const Module=require('node:module');
const {launchDesktop,stopDesktop}=require('./desktop-app.browser.cjs');

// Exercise the exact complete editor/queue suites inside a real, isolated
// Electron process. This does not substitute a browser bridge or an HTTP host.
// --native owns the shared native-export lease and renders two real MP4 files.
const native=process.argv.includes('--native');
const basename=native?'multi-video-native.browser.cjs':'multi-video-workflow.browser.cjs';
const filename=path.join(__dirname,basename);
process.env.STUDIO_URL='studio://app/';
let source=fs.readFileSync(filename,'utf8');
const original="const {chromium}=require('playwright');";
assert.ok(source.includes(original),'Review the shared suite launch contract');
globalThis.__launchContentStudioDesktopVerification=async()=>{
 const profile=await fsp.mkdtemp(path.join(os.tmpdir(),'content-studio-complete-'));
 const runtime=await launchDesktop(profile),{app,page,context}=runtime;
 const application=await app.evaluate(({app})=>({version:app.getVersion(),isPackaged:app.isPackaged,appPath:app.getAppPath()}));
 return{
  async newContext(options){
   if(options?.viewport)await page.setViewportSize(options.viewport);
   return{newPage:async()=>page,route:(...args)=>context.route(...args),addInitScript:(...args)=>context.addInitScript(...args)};
  },
  async close(){
   try{
    assert.deepEqual(runtime.errors,[]);assert.deepEqual(runtime.external,[]);
    const resultPath=native?'/tmp/desktop-multi-video-native-result.json':'/tmp/desktop-multi-video-workflow-result.json';
    try{
     const result=JSON.parse(await fsp.readFile(resultPath,'utf8'));
     await fsp.writeFile(resultPath,JSON.stringify({...result,actualElectron:true,application,hostPlatform:process.platform,windowsRuntimeExecuted:process.platform==='win32',secureAppOrigin:'studio://app',realProviderRequests:0,realGoogleUploads:0},null,2));
    }catch(error){if(error.code!=='ENOENT')throw error;}
   }finally{await stopDesktop(app);}
  },
 };
};
source=source.replace(original,"const chromium={launch:()=>globalThis.__launchContentStudioDesktopVerification()};");
source=source.replaceAll('/tmp/multi-video-','/tmp/desktop-multi-video-');
const suite=new Module(filename,module);suite.filename=filename;suite.paths=Module._nodeModulePaths(__dirname);suite._compile(source,filename);
