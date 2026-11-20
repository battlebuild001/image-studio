import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {RELEASE_API,MIN_INSTALLER_BYTES,MAX_RELEASE_BYTES,compareVersions,normalizeRelease,detectDistribution,verifyUpdateDirectory,createDesktopUpdater}=require('../desktop/updater.cjs');
const bytes=Buffer.alloc(MIN_INSTALLER_BYTES);bytes.write('MZ');bytes.writeUInt32LE(128,60);bytes.write('PE\0\0',128,'binary');bytes.writeUInt16LE(0x14c,132);
const digest=crypto.createHash('sha256').update(bytes).digest('hex');
const clone=value=>structuredClone(value);
function release(version='1.1.2'){
 const name=`Content-Studio-Setup-${version}-x64.exe`;
 return{id:123,draft:false,prerelease:false,tag_name:'desktop-v'+version,html_url:`https://github.com/battlebuild001/image-studio/releases/tag/desktop-v${version}`,assets:[{name,state:'uploaded',size:bytes.length,digest:'sha256:'+digest,browser_download_url:`https://github.com/battlebuild001/image-studio/releases/download/desktop-v${version}/${name}`}]};
}
async function temp(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'studio-update-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
function transport({metadata=release(),body=bytes,redirect='https://release-assets.githubusercontent.com/official-installer?signature=synthetic',headers={}}={}){
 const calls=[];const fetch=async(url,options)=>{calls.push({url,options});if(url===RELEASE_API)return new Response(JSON.stringify(metadata),{headers:{'Content-Type':'application/json'}});if(url.startsWith('https://github.com/'))return new Response(null,{status:302,headers:{location:redirect}});return new Response(body,{headers:{'Content-Length':String(body.length),...headers}});};return{fetch,calls};
}
function updater(directory,values={}){return createDesktopUpdater({currentVersion:'1.1.1',directory,platform:'win32',architecture:'x64',isPackaged:true,distribution:'installed',...values});}

test('stable desktop release versions compare numerically and reject malformed values',()=>{
 assert.equal(compareVersions('1.10.0','1.2.9'),1);assert.equal(compareVersions('1.1.1','1.1.1'),0);assert.equal(compareVersions('1.0.9','1.1.0'),-1);
 for(const value of ['v1.1.1','1.1','01.2.3','1.1.1-beta','1.2.3.4','1.1.1000001','1.2.3\n'])assert.throws(()=>compareVersions(value,'1.1.1'));
});

test('release metadata binds the exact repository, stable version, uploaded installer, size and GitHub SHA-256',()=>{
 const metadata=release(),valid=normalizeRelease(metadata,'1.1.1');assert.equal(valid.available,true);assert.equal(valid.sha256,digest);assert.equal(valid.bytes,bytes.length);assert.equal(normalizeRelease(release('1.1.1'),'1.1.1').available,false);assert.equal(normalizeRelease(release('1.0.0'),'1.1.1').available,false);
 const cases=[m=>m.draft=true,m=>m.prerelease=true,m=>m.tag_name='desktop-v1.1.2-beta',m=>m.html_url='https://github.com/attacker/app/releases/tag/desktop-v1.1.2',m=>m.assets[0].name='malicious.exe',m=>m.assets[0].browser_download_url='https://github.com/attacker/app/download.exe',m=>m.assets[0].digest=undefined,m=>m.assets[0].digest='sha256:not-a-digest',m=>m.assets[0].state='new',m=>m.assets[0].size=100,m=>m.assets[0].size=513*1024*1024,m=>m.assets.push(clone(m.assets[0]))];
 for(const change of cases){const next=clone(metadata);change(next);assert.throws(()=>normalizeRelease(next,'1.1.1'));}
});

test('distribution reports official portable markers and checks an installed uninstaller without exposing paths',()=>{
 assert.equal(detectDistribution({env:{PORTABLE_EXECUTABLE_FILE:'C:\\download\\Portable.exe'},isFile:()=>true}),'portable');
 assert.equal(detectDistribution({env:{},executable:'/installed/ContentStudio.exe',isFile:file=>file==='/installed/Uninstall Content Studio.exe'}),'installed');
 assert.equal(detectDistribution({env:{},isFile:()=>false}),'unpacked');assert.equal(detectDistribution({env:{},isPackaged:false,isFile:()=>true}),'unpacked');
});

test('construction, state reads and unsupported platforms never start network work',async t=>{
 let calls=0;const controller=updater(await temp(t),{fetchImpl:async()=>{calls++;throw Error('Not authorized');}});assert.equal(controller.getState().status,'idle');assert.equal(controller.cancel().cancelled,false);assert.equal(calls,0);
 const linux=updater(await temp(t),{platform:'linux',fetchImpl:async()=>{calls++;}});assert.equal(linux.getState().status,'unsupported');await assert.rejects(linux.check(),cause=>cause.code==='DESKTOP_UPDATE_UNSUPPORTED');assert.equal(calls,0);
});

test('latest and older versions perform just one public metadata request and never offer downgrade or execute files',async t=>{
 for(const version of ['1.1.1','1.0.0']){const network=transport({metadata:release(version)}),controller=updater(await temp(t),{fetchImpl:network.fetch});const result=await controller.check();assert.equal(result.status,'up-to-date');assert.equal(network.calls.length,1);assert.equal(network.calls[0].url,RELEASE_API);assert.equal(network.calls[0].options.credentials,'omit');assert.equal(network.calls[0].options.redirect,'manual');assert.equal('Authorization'in network.calls[0].options.headers,false);await assert.rejects(controller.download(),cause=>cause.code==='DESKTOP_UPDATE_NOT_CHECKED');}
});

test('bounded release responses and metadata redirects reject untrusted content before download',async t=>{
 for(const fetchImpl of [async()=>new Response('x'.repeat(MAX_RELEASE_BYTES+1)),async()=>new Response(null,{status:302,headers:{location:'https://evil.example/releases'}}),async()=>new Response('{"error":"untrusted secret raw body"}',{status:500})]){
  const controller=updater(await temp(t),{fetchImpl});await assert.rejects(controller.check());assert.equal(controller.getState().status,'failed');assert.equal(JSON.stringify(controller.getState()).includes('untrusted secret raw body'),false);
 }
});

test('official redirect download streams bounded verified bytes and installation uses only its private file and reviewed NSIS parameters',async t=>{
 const directory=await temp(t),network=transport(),progress=[],launched=[];let quit=0;
 const controller=updater(directory,{fetchImpl:network.fetch,onProgress:state=>progress.push(state),launch:async(file,args)=>{launched.push({file,args});assert.equal(await fs.readFile(file).then(data=>crypto.createHash('sha256').update(data).digest('hex')),digest);},quit:()=>quit++});
 assert.equal((await controller.check()).status,'available');assert.equal((await controller.download()).status,'ready');assert.equal(controller.getState().progress,1);assert.equal(controller.getState().downloadedBytes,bytes.length);assert.equal(JSON.stringify(controller.getState()).includes(directory),false);assert.equal(JSON.stringify(controller.getState()).includes('signature='),false);assert.ok(progress.some(state=>state.status==='downloading'));
 await controller.install();assert.equal(launched.length,1);assert.deepEqual(launched[0].args,['/S','--updated','--force-run','/currentuser']);assert.equal(path.dirname(path.dirname(launched[0].file)),directory);assert.equal(quit,1);
});

test('cross-origin redirects, wrong size, hash mismatch and invalid PE leave no ready executable or partial folder',async t=>{
 const bad=Buffer.from(bytes);bad[0]=0;
 const cases=[{redirect:'https://evil.example/file.exe'},{redirect:'https://github.com/attacker/other/releases/download/v1/installer.exe'},{redirect:'http://release-assets.githubusercontent.com/file.exe'},{redirect:'https://user:pass@release-assets.githubusercontent.com/file.exe'},{body:Buffer.alloc(10)},{body:bad}];
 for(const values of cases){const directory=await temp(t),network=transport(values),controller=updater(directory,{fetchImpl:network.fetch});await controller.check();await assert.rejects(controller.download());assert.equal(controller.getState().status,'failed');assert.deepEqual(await fs.readdir(directory),[]);await assert.rejects(controller.install(),cause=>cause.code==='DESKTOP_UPDATE_NOT_READY');}
 // A malicious publisher metadata digest for a non-PE file still cannot execute.
 const data=Buffer.alloc(bytes.length),metadata=release();metadata.assets[0].digest='sha256:'+crypto.createHash('sha256').update(data).digest('hex');const directory=await temp(t),controller=updater(directory,{fetchImpl:transport({metadata,body:data}).fetch});await controller.check();await assert.rejects(controller.download(),cause=>cause.code==='DESKTOP_UPDATE_FILE');assert.deepEqual(await fs.readdir(directory),[]);
});

test('cancelling an active download aborts its request, rejects concurrent work and removes its private partial',async t=>{
 const directory=await temp(t),network=transport();let entered;const started=new Promise(resolve=>entered=resolve);
 const fetchImpl=async(url,options)=>{if(url===RELEASE_API)return network.fetch(url,options);entered();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));};
 const controller=updater(directory,{fetchImpl});await controller.check();const pending=controller.download();await started;await assert.rejects(controller.check(),cause=>cause.code==='DESKTOP_UPDATE_BUSY');await assert.rejects(controller.download(),cause=>cause.code==='DESKTOP_UPDATE_BUSY');assert.equal(controller.cancel().cancelled,true);await assert.rejects(pending,cause=>cause.name==='AbortError');assert.equal(controller.getState().status,'cancelled');assert.deepEqual(await fs.readdir(directory),[]);
});

test('busy and unsaved work block installation before spawning, including a race during final verification',async t=>{
 const directory=await temp(t),network=transport();let activity={busy:false,unsaved:false},launches=0;
 const controller=updater(directory,{fetchImpl:network.fetch,getActivity:()=>activity,launch:async()=>launches++});await controller.check();await controller.download();
 for(const next of [{busy:true,unsaved:false},{busy:false,unsaved:true}]){activity=next;await assert.rejects(controller.install(),cause=>['DESKTOP_UPDATE_WORK_ACTIVE','DESKTOP_UPDATE_UNSAVED'].includes(cause.code));assert.equal(controller.getState().status,'ready');}
 let checks=0;const another=updater(await temp(t),{fetchImpl:network.fetch,getActivity:()=>({busy:++checks>=2,unsaved:false}),launch:async()=>launches++});await another.check();await another.download();await assert.rejects(another.install(),cause=>cause.code==='DESKTOP_UPDATE_WORK_ACTIVE');assert.equal(launches,0);
});

test('replaced, truncated, missing or symlinked downloaded installers are rejected before launch',async t=>{
 for(const mode of ['same-size-corruption','truncated','removed','symlink']){
  const directory=await temp(t),network=transport();let launches=0;const controller=updater(directory,{fetchImpl:network.fetch,launch:async()=>launches++});await controller.check();await controller.download();const sub=(await fs.readdir(directory))[0],file=path.join(directory,sub,release().assets[0].name);
  if(mode==='same-size-corruption'){const handle=await fs.open(file,'r+');await handle.write(Buffer.from('BAD!'),0,4,0);await handle.close();}else if(mode==='truncated')await fs.truncate(file,100);else if(mode==='removed')await fs.unlink(file);else{await fs.unlink(file);const outside=path.join(await temp(t),'outside.exe');await fs.writeFile(outside,bytes);await fs.symlink(outside,file);}
  await assert.rejects(controller.install(),cause=>cause.code==='DESKTOP_UPDATE_FILE');assert.equal(launches,0);assert.equal(controller.getState().status,'failed');assert.deepEqual(await fs.readdir(directory),[]);
 }
});

test('a replaced cache directory cannot execute an installer or remove another directory during failure cleanup',async t=>{
 const directory=await temp(t),outside=await temp(t),network=transport(),controller=updater(directory,{fetchImpl:network.fetch,launch:async()=>assert.fail('Untrusted cache must not execute')});await controller.check();await controller.download();
 const staging=(await fs.readdir(directory))[0];await fs.writeFile(path.join(outside,'keep.txt'),'unrelated user data');await fs.rm(path.join(directory,staging),{recursive:true});await fs.symlink(outside,path.join(directory,staging),'dir');await assert.rejects(controller.install(),cause=>cause.code==='DESKTOP_UPDATE_STORAGE');assert.equal(controller.getState().status,'failed');assert.equal(await fs.readFile(path.join(outside,'keep.txt'),'utf8'),'unrelated user data');
});

test('cache symlinks are rejected without writing through them and portable conversion needs explicit intent',async t=>{
 const directory=await temp(t),outside=await temp(t),link=path.join(directory,'redirect');await fs.symlink(outside,link,'dir');const controller=updater(path.join(link,'updates'),{fetchImpl:transport().fetch});await controller.check();await assert.rejects(controller.download(),cause=>cause.code==='DESKTOP_UPDATE_STORAGE');assert.deepEqual(await fs.readdir(outside),[]);
 const conversion=updater(await temp(t),{distribution:'portable',fetchImpl:transport().fetch,launch:async()=>{}});await conversion.check();await conversion.download();await assert.rejects(conversion.install(),cause=>cause.code==='DESKTOP_UPDATE_CONVERSION');await conversion.install({convertToInstalled:true});assert.equal(conversion.getState().status,'installing');
});

function windowsAliasDirectory({differentTarget=false,changedParent=false}={}){
 const win=path.win32,canonical='C:\\Users\\Runner Administrator\\AppData\\Local\\Temp\\updates',alias='c:\\users\\RUNNER~1\\AppData\\Local\\Temp\\updates';
 const segments=['C:\\','C:\\Users','C:\\Users\\Runner Administrator','C:\\Users\\Runner Administrator\\AppData','C:\\Users\\Runner Administrator\\AppData\\Local','C:\\Users\\Runner Administrator\\AppData\\Local\\Temp',canonical];
 const map=new Map(segments.map((name,index)=>[name.toLowerCase(),(2n**62n)+BigInt(index+1)]));
 const foreign=win.join(win.dirname(canonical),'foreign');map.set(foreign.toLowerCase(),(2n**62n)+8n);
 let resolved=false;const calls=[];
 const physical=value=>win.resolve(value).toLowerCase().replace('c:\\users\\runner~1','c:\\users\\runner administrator');
 const io={async lstat(value,options){assert.equal(options.bigint,true);calls.push(value);const key=physical(value),ino=map.get(key);if(!ino)throw Object.assign(new Error('Missing synthetic Windows directory'),{code:'ENOENT'});return{dev:99n,ino:ino+(changedParent&&resolved&&key===win.dirname(canonical).toLowerCase()?100n:0n),isDirectory:()=>true,isSymbolicLink:()=>false};},async realpath(){resolved=true;return differentTarget?foreign:canonical;},async mkdir(){assert.fail('Existing aliases must not create new directories');}};
 return{alias,canonical,io,calls,pathImpl:win};
}

test('Windows case and 8.3 aliases grant the same BigInt physical directory and return its canonical path',async()=>{
 const fixture=windowsAliasDirectory(),grant=await verifyUpdateDirectory(fixture.alias,{create:false,io:fixture.io,pathImpl:fixture.pathImpl});
 assert.equal(grant.path,fixture.canonical);assert.equal(grant.dev,'99');assert.equal(grant.ino,String((2n**62n)+7n));assert.equal(grant.parent.ino,String((2n**62n)+6n));assert.ok(fixture.calls.some(value=>value.includes('RUNNER~1')));assert.ok(fixture.calls.some(value=>value.includes('Runner Administrator')));
});

test('canonical resolution cannot switch to another inode or a parent changed during alias verification',async()=>{
 for(const options of[{differentTarget:true},{changedParent:true}]){const fixture=windowsAliasDirectory(options);await assert.rejects(verifyUpdateDirectory(fixture.alias,{create:false,io:fixture.io,pathImpl:fixture.pathImpl}),cause=>cause.code==='DESKTOP_UPDATE_STORAGE');}
});

test('real platform aliases use the canonical grant for download, final verification and installer launch',async t=>{
 const directory=await temp(t),spelling=process.platform==='win32'?directory.toUpperCase():path.join(directory,'.'),canonical=await fs.realpath(directory),physical=await fs.lstat(canonical,{bigint:true});
 const grant=await verifyUpdateDirectory(spelling,{create:false});assert.equal(grant.path,canonical);assert.equal(grant.dev,String(physical.dev));assert.equal(grant.ino,String(physical.ino));
 let launched;const controller=updater(spelling,{fetchImpl:transport().fetch,launch:async file=>launched=file});await controller.check();await controller.download();await controller.install();assert.equal(path.dirname(path.dirname(launched)),canonical);assert.equal((await fs.stat(launched)).size,bytes.length);
});

test('prepared alias grants clean their own canonical staging directory when no update is needed',async t=>{
 const directory=await temp(t),spelling=process.platform==='win32'?directory.toUpperCase():path.join(directory,'.'),metadata=release(),network=transport({metadata}),controller=updater(spelling,{fetchImpl:network.fetch});await controller.check();await controller.download();assert.equal((await fs.readdir(directory)).length,1);
 Object.assign(metadata,release('1.1.1'));assert.equal((await controller.check()).status,'up-to-date');assert.deepEqual(await fs.readdir(directory),[]);
});

test('a replacement regular cache directory cannot regain the old grant or have its foreign contents removed',async t=>{
 const parent=await temp(t),directory=path.join(parent,'updates'),retained=path.join(parent,'original-cache'),controller=updater(directory,{fetchImpl:transport().fetch,launch:async()=>assert.fail('Replaced cache must not execute')});await controller.check();await controller.download();const staging=(await fs.readdir(directory))[0];await fs.rename(directory,retained);await fs.mkdir(path.join(directory,staging),{recursive:true});const foreign=path.join(directory,staging,'keep.txt');await fs.writeFile(foreign,'foreign directory contents');
 await assert.rejects(controller.install(),cause=>cause.code==='DESKTOP_UPDATE_STORAGE');assert.equal(await fs.readFile(foreign,'utf8'),'foreign directory contents');assert.equal((await fs.stat(path.join(retained,staging,release().assets[0].name))).size,bytes.length);
});

test('a different ordinary directory substituted for the staged inode is never executed or deleted as owned cache',async t=>{
 const parent=await temp(t),directory=path.join(parent,'updates'),retained=path.join(parent,'retained-installer'),controller=updater(directory,{fetchImpl:transport().fetch,launch:async()=>assert.fail('Replaced staging must not execute')});await controller.check();await controller.download();const staging=path.join(directory,(await fs.readdir(directory))[0]);await fs.rename(staging,retained);await fs.mkdir(staging);const foreign=path.join(staging,'keep.txt');await fs.writeFile(foreign,'not the granted staged directory');
 await assert.rejects(controller.install(),cause=>cause.code==='DESKTOP_UPDATE_STORAGE');assert.equal(await fs.readFile(foreign,'utf8'),'not the granted staged directory');assert.equal((await fs.stat(path.join(retained,release().assets[0].name))).size,bytes.length);
});

test('a removed cache or staging directory invalidates its grant instead of leaving a stale ready installer',async t=>{
 for(const mode of['cache','staging']){
  const directory=await temp(t),controller=updater(directory,{fetchImpl:transport().fetch,launch:async()=>assert.fail('Removed directories must not execute')});await controller.check();await controller.download();const staging=path.join(directory,(await fs.readdir(directory))[0]);await fs.rm(mode==='cache'?directory:staging,{recursive:true});await assert.rejects(controller.install(),cause=>cause.code==='DESKTOP_UPDATE_STORAGE');assert.equal(controller.getState().status,'failed');
 }
});
