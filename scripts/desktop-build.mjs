import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {copyFile,lstat,mkdir,mkdtemp,open,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {inflateRawSync} from 'node:zlib';
import {buildRelease} from './deploy-assets.mjs';

const require=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=require('../electron-builder.config.cjs');
const maxArchiveEntryBytes=64*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const safeEntry=name=>name.length>0&&!name.startsWith('/')&&!name.includes('\\')&&!name.split('/').includes('..')&&!/^[A-Za-z]:/u.test(name);

function argumentsFor(args){
 const result={target:'win',verifyOnly:false,sourceArchive:false,output:join(root,'.desktop-build')};
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(arg==='--win')result.target='win';else if(arg==='--linux-smoke')result.target='linux';
  else if(arg==='--verify-only')result.verifyOnly=true;
  else if(arg==='--source-archive')result.sourceArchive=true;
  else if(arg==='--output'){if(!args[++index])throw Error('--output 뒤에 폴더를 지정하세요.');result.output=resolve(args[index]);}
  else if(arg==='--help'){result.help=true;}else throw Error(`지원하지 않는 빌드 옵션: ${arg}`);
 }
 if(result.output===root||result.output===join(root,'dist')||result.output===join(root,'desktop'))throw Error('앱 소스 폴더를 빌드 출력 위치로 사용할 수 없어요.');
 return result;
}

export async function inspectPortableExecutable(path,{requireX64=false}={}){
 const handle=await open(path,'r');
 try{
  const header=Buffer.alloc(64);assert.equal((await handle.read(header,0,64,0)).bytesRead,64,'Truncated executable');assert.equal(header.subarray(0,2).toString(),'MZ','Missing DOS header');
  const offset=header.readUInt32LE(60);assert.ok(offset>=64&&offset<1024*1024,'Invalid PE offset');const pe=Buffer.alloc(26);assert.equal((await handle.read(pe,0,pe.length,offset)).bytesRead,pe.length);assert.equal(pe.subarray(0,4).toString('binary'),'PE\0\0');
  const machine=pe.readUInt16LE(4);assert.ok([0x14c,0x8664].includes(machine),'Unexpected Windows machine type');if(requireX64)assert.equal(machine,0x8664,'The app payload must be x64');
  return{machine:machine===0x8664?'x64':'x86-launcher',peOffset:offset};
 }finally{await handle.close();}
}

export async function inspectZip(path){
 const handle=await open(path,'r');
 try{
  const info=await handle.stat(),tailSize=Math.min(info.size,65557),tail=Buffer.alloc(tailSize);await handle.read(tail,0,tailSize,info.size-tailSize);let end=-1;
  for(let index=tail.length-22;index>=0;index--)if(tail.readUInt32LE(index)===0x06054b50&&index+22+tail.readUInt16LE(index+20)===tail.length){end=index;break;}
  assert.ok(end>=0,'Missing ZIP directory');assert.equal(tail.readUInt16LE(end+4),0);assert.equal(tail.readUInt16LE(end+6),0);
  const count=tail.readUInt16LE(end+10),size=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);assert.ok(count>0&&count<65535&&size<=10*1024*1024&&offset+size<=info.size,'Unsupported ZIP directory');
  const central=Buffer.alloc(size);assert.equal((await handle.read(central,0,size,offset)).bytesRead,size);let at=0;const entries=[];
  for(let index=0;index<count;index++){
   assert.equal(central.readUInt32LE(at),0x02014b50,'Malformed ZIP entry');const length=central.readUInt16LE(at+28),extra=central.readUInt16LE(at+30),comment=central.readUInt16LE(at+32),name=central.subarray(at+46,at+46+length).toString('utf8');assert.ok(safeEntry(name),'Unsafe ZIP path');assert.notEqual((central.readUInt32LE(at+38)>>>16)&0xf000,0xa000,'Symbolic links cannot be distributed');
   entries.push({name,method:central.readUInt16LE(at+10),compressedSize:central.readUInt32LE(at+20),size:central.readUInt32LE(at+24),offset:central.readUInt32LE(at+42)});at+=46+length+extra+comment;
  }
  assert.equal(at,central.length);return entries;
 }finally{await handle.close();}
}

async function zipBytes(path,entry){
 assert.ok(entry&&entry.size<=maxArchiveEntryBytes&&entry.compressedSize<=maxArchiveEntryBytes,'ZIP entry is too large to inspect');const handle=await open(path,'r');
 try{const header=Buffer.alloc(30);await handle.read(header,0,30,entry.offset);assert.equal(header.readUInt32LE(0),0x04034b50);const start=entry.offset+30+header.readUInt16LE(26)+header.readUInt16LE(28),data=Buffer.alloc(entry.compressedSize);assert.equal((await handle.read(data,0,data.length,start)).bytesRead,data.length);const bytes=entry.method===0?data:entry.method===8?inflateRawSync(data,{maxOutputLength:maxArchiveEntryBytes}):null;assert.ok(bytes,'Unsupported ZIP compression');assert.equal(bytes.length,entry.size);return bytes;}finally{await handle.close();}
}

function asarTools(){try{return require('@electron/asar');}catch{const fromBuilder=createRequire(require.resolve('app-builder-lib/package.json'));return fromBuilder('@electron/asar');}}
async function verifyAsar(path){
 const asar=asarTools(),paths=asar.listPackage(path).filter(name=>!asar.statFile(path,name.replace(/^\//u,'')).files),names=paths.map(name=>name.replace(/^\//u,''));
 for(const name of names){assert.ok(safeEntry(name));assert.ok(name==='package.json'||name.startsWith('dist/')||/^desktop\/(?:[^/]+\.cjs|assets\/icon\.(?:png|ico))$/u.test(name),`Unexpected packaged source: ${name}`);assert.doesNotMatch(name,/(?:\.env(?:\.|$)|\.bth\.json$|\.pem$|\.key$|node_modules\/|test-results\/|credentials?\/)/iu);}
 const manifest=JSON.parse(asar.extractFile(path,'package.json').toString('utf8'));assert.equal(manifest.main,'desktop/main.cjs');assert.equal(manifest.productName??'Content Studio','Content Studio');
 for(const name of ['desktop/main.cjs','desktop/preload.cjs','dist/index.html','dist/main.js','dist/production-run-engine.js','dist/scene-image-replace.js'])assert.ok(names.includes(name),`Missing packaged file: ${name}`);
 for(const name of names){if(!name.startsWith('dist/')&&!name.endsWith('.cjs')&&!name.startsWith('desktop/assets/'))continue;const expected=await readFile(join(root,name));assert.deepEqual(asar.extractFile(path,name),expected,`Packaged bytes differ: ${name}`);}
 return{files:names.length,version:manifest.version,main:manifest.main,sha256:digest(await readFile(path))};
}

// The pinned builder already uses this exact reader on macOS. On Linux its
// default path unnecessarily executes the unsigned NSIS stub through Wine.
// Scope the adapter to this build's one known stub, restore it after the build,
// and keep every other Wine invocation on the upstream implementation.
function unsignedNsisReader(output,version){
 if(process.platform!=='linux')return()=>{};
 assert.equal(require('app-builder-lib/package.json').version,'26.18.0','Review the unsigned NSIS reader adapter before changing electron-builder');
 assert.equal(require('electron-builder/package.json').version,'26.18.0','Review the unsigned NSIS reader adapter before changing electron-builder');
 const {WineVmManager}=require('app-builder-lib/out/vm/WineVm.js'),{UninstallerReader}=require('app-builder-lib/out/targets/nsis/nsisUtil.js'),prototype=WineVmManager.prototype,original=prototype.exec;
 const expected=join(output,`Content-Studio-Setup-${version}-x64.exe`),uninstaller=join(output,`Content-Studio-Setup-${version}-x64.__uninstaller.exe`);
 let calls=0;
 prototype.exec=async function(file,args,options,isLogOutIfDebug){
  if(resolve(file)!==expected||!Array.isArray(args)||args.length)return original.call(this,file,args,options,isLogOutIfDebug);
  assert.equal(++calls,1,'Expected exactly one unsigned NSIS uninstaller extraction');
  await UninstallerReader.exec(expected,uninstaller);await inspectPortableExecutable(uninstaller);console.log('  • verified unsigned NSIS uninstaller extracted with electron-builder UninstallerReader');
 };
 const restore=()=>{prototype.exec=original;};restore.assertUsed=()=>assert.equal(calls,1,'The unsigned NSIS extraction adapter was not used');return restore;
}

function sevenZipMembers(output){
 const section=output.replaceAll('\r\n','\n').split('\n----------\n')[1];assert.ok(section,'Missing 7-Zip member directory');
 return section.trim().split(/\n\n+/u).map(block=>Object.fromEntries(block.split('\n').map(line=>{const at=line.indexOf(' = ');return at<0?null:[line.slice(0,at),line.slice(at+3)];}).filter(Boolean))).filter(item=>item.Path);
}
async function verifyNsisPayload(path,{asarSha256,executableSha256,installer}={}){
 const seven=await require('app-builder-lib/out/toolsets/7zip.js').getPath7za(),execute=promisify(execFile),run=async args=>(await execute(seven,args,{maxBuffer:4*1024*1024})).stdout;
 const listing=await run(['l','-slt',path]);assert.match(listing,/\bType = Nsis\b/u,'Executable must be a real NSIS archive');const entries=sevenZipMembers(listing),packageEntry=entries.find(entry=>/(?:^|[/\\])app-64\.7z$/u.test(entry.Path));assert.ok(packageEntry,'NSIS artifact is missing its x64 app payload');assert.ok(Number(packageEntry.Size)>32*1024*1024,'NSIS runtime payload is unexpectedly small');
 const uninstaller=entries.find(entry=>/(?:^|[/\\])Uninstall [^/\\]+\.exe$/iu.test(entry.Path));if(installer)assert.ok(uninstaller,'Installer must include its real uninstaller');
 const staging=await mkdtemp(join(tmpdir(),'content-studio-nsis-verify-'));
 try{
  await run(['t','-bd',path]);await run(['e','-y','-bd',path,packageEntry.Path,...(installer?[uninstaller.Path]:[]),`-o${staging}`]);const embedded=join(staging,'app-64.7z');await run(['t','-bd',embedded]);const payloadEntries=sevenZipMembers(await run(['l','-slt',embedded]));
  for(const name of ['ContentStudio.exe','resources/app.asar','ffmpeg.dll','icudtl.dat','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','locales/ko.pak','LICENSE.electron.txt','LICENSES.chromium.html'])assert.ok(payloadEntries.some(entry=>entry.Path.replaceAll('\\','/')===name),`NSIS payload missing runtime: ${name}`);
  const extracted=join(staging,'app');await mkdir(extracted);await run(['e','-y','-bd',embedded,'resources/app.asar','ContentStudio.exe',`-o${extracted}`]);assert.equal(digest(await readFile(join(extracted,'app.asar'))),asarSha256,'NSIS payload differs from the verified app');await inspectPortableExecutable(join(extracted,'ContentStudio.exe'),{requireX64:true});assert.equal(digest(await readFile(join(extracted,'ContentStudio.exe'))),executableSha256,'NSIS runtime differs from the verified x64 executable');
  if(installer)await inspectPortableExecutable(join(staging,uninstaller.Path.split(/[/\\]/u).at(-1)));
  return{archiveTested:true,runtimeFiles:payloadEntries.length,asarSha256,uninstallerIncluded:installer};
 }finally{await rm(staging,{recursive:true,force:true});}
}

export async function verifyDesktopBuild(output,{target='win'}={}){
 const folder=join(output,target==='win'?'win-unpacked':'linux-unpacked'),asarPath=join(folder,'resources','app.asar'),app=await verifyAsar(asarPath),artifacts=[];
 if(target==='win'){
  const payload=await inspectPortableExecutable(join(folder,'ContentStudio.exe'),{requireX64:true}),executableSha256=digest(await readFile(join(folder,'ContentStudio.exe')));
  const names=[`Content-Studio-Setup-${app.version}-x64.exe`,`Content-Studio-${app.version}-Windows-x64-Portable.exe`,`Content-Studio-${app.version}-Windows-x64.zip`].sort();
  for(const name of names){const path=join(output,name),bytes=await readFile(path);assert.ok(bytes.length>1024*1024,'Artifact is unexpectedly small');const item={file:name,bytes:bytes.length,sha256:digest(bytes)};
   if(name.endsWith('.exe')){assert.ok(bytes.length>32*1024*1024,'An installer stub is not a distributable app');item.executable=await inspectPortableExecutable(path);item.nsis=await verifyNsisPayload(path,{asarSha256:app.sha256,executableSha256,installer:name.includes('-Setup-')});}
   else{const entries=await inspectZip(path);for(const required of ['ContentStudio.exe','resources/app.asar','icudtl.dat','ffmpeg.dll','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','locales/ko.pak','LICENSE.electron.txt','LICENSES.chromium.html'])assert.ok(entries.some(entry=>entry.name===required),`Missing portable runtime: ${required}`);const packagedAsar=await zipBytes(path,entries.find(entry=>entry.name==='resources/app.asar'));assert.equal(digest(packagedAsar),app.sha256,'Portable ZIP must contain the verified app');item.entries=entries.length;item.selfContained=true;}
   artifacts.push(item);
  }
  return{app:'Content Studio',platform:'win32',architecture:'x64',version:app.version,packagedApp:app,payload,artifacts,unsigned:true,requiresNodeInstallation:false,requiresChromeInstallation:false};
 }
 assert.ok((await stat(join(folder,'ContentStudio'))).isFile(),'Missing Linux smoke-test executable');return{app:'Content Studio',platform:'linux',architecture:'x64',version:app.version,packagedApp:app,artifacts:[],runtimeSmokeTestRequired:true};
}

/** Keep the development handoff separate from the app and from every user-data directory. */
export async function createDesktopSourceArchive(output,{version}={}){
 version??=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;assert.match(version,/^[0-9A-Za-z.+-]+$/u);
 await mkdir(output,{recursive:true});const staging=await mkdtemp(join(tmpdir(),'content-studio-source-')),sources=[];
 const allowedDirectories={dist:new Set(['.html','.css','.js','.mjs','.json','.svg','.png','.jpg','.jpeg','.webp','.gif','.avif','.ico','.woff','.woff2','.ttf','.otf','.webmanifest','.txt','.xml','.wasm']),desktop:new Set(['.cjs','.svg','.png','.ico']),scripts:new Set(['.mjs']),tests:new Set(['.mjs','.cjs'])};
 const fixed=['package.json','package-lock.json','electron-builder.config.cjs','README.md','docs/DESKTOP.md','tests/fixtures/reference-test.txt','tests/fixtures/reference-test.pdf','tests/fixtures/reference-test.docx','tests/fixtures/narration-test.wav','tests/fixtures/image-test-2.png','tests/fixtures/image-test-1.png','tests/fixtures/exact-timing.srt','tests/fixtures/bgm-test.wav'];
 let totalBytes=0;
 async function add(name){
  assert.ok(safeEntry(name));assert.doesNotMatch(name,/(?:^|\/)(?:\.[^/]*|node_modules|test-results|credentials?|secrets?)(?:\/|$)|\.(?:bth\.json|pem|key|p12|pfx)$/iu);
  const source=join(root,name),info=await lstat(source);assert.ok(info.isFile()&&!info.isSymbolicLink(),`Source must be a regular file: ${name}`);totalBytes+=info.size;assert.ok(sources.length<1000&&totalBytes<=32*1024*1024,'Source archive exceeds its bounded allowlist');
  const destination=join(staging,name);await mkdir(dirname(destination),{recursive:true});await copyFile(source,destination);sources.push(name);
 }
 async function visit(directory,relative,extensions){
  for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   if(entry.name.startsWith('.')||['node_modules','test-results','fixtures'].includes(entry.name))continue;
   assert.ok(!entry.isSymbolicLink(),'Source archives cannot follow symbolic links');const name=`${relative}/${entry.name}`;
   if(entry.isDirectory())await visit(join(directory,entry.name),name,extensions);else if(entry.isFile()&&extensions.has(extname(entry.name)))await add(name);
  }
 }
 try{
  for(const name of fixed)await add(name);for(const [directory,extensions]of Object.entries(allowedDirectories))await visit(join(root,directory),directory,extensions);
  const file=`Content-Studio-Source-${version}.zip`,path=join(output,file),{archive}=require('app-builder-lib/out/targets/archive.js');await archive('zip',path,staging,{withoutDir:true,compression:'normal',preserveSymlinks:false});
  const entries=(await inspectZip(path)).filter(entry=>!entry.name.endsWith('/'));assert.deepEqual(entries.map(entry=>entry.name).sort(),[...sources].sort(),'Source archive must match the explicit source allowlist');
  for(const entry of entries)assert.deepEqual(await zipBytes(path,entry),await readFile(join(root,entry.name)),`Archived source changed: ${entry.name}`);
  const bytes=await readFile(path);return{file,bytes:bytes.length,sha256:digest(bytes),files:entries.length,excludesUserData:true};
 }finally{await rm(staging,{recursive:true,force:true});}
}

export async function runDesktopBuild(args=process.argv.slice(2)){
 const settings=argumentsFor(args);if(settings.help){console.log('node scripts/desktop-build.mjs [--win | --linux-smoke] [--verify-only] [--source-archive] [--output <folder>]');return;}
 await mkdir(settings.output,{recursive:true});const release=await buildRelease(join(root,'dist'));
 if(!settings.verifyOnly){
  for(const file of ['desktop/main.cjs','desktop/preload.cjs','desktop/assets/icon.ico','desktop/assets/icon.png'])await stat(join(root,file));
  const {build,Platform,Arch}=await import('electron-builder');
  console.log(`Content Studio ${settings.target==='win'?'Windows 10/11 x64':'Linux runtime smoke-test'} 패키지를 만들고 있어요.`);
  const version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,restore=settings.target==='win'?unsignedNsisReader(settings.output,version):()=>{};
  try{await build({targets:settings.target==='win'?Platform.WINDOWS.createTarget(['nsis','portable','zip'],Arch.x64):Platform.LINUX.createTarget(['dir'],Arch.x64),publish:'never',config:{...config,directories:{...config.directories,output:settings.output}}});restore.assertUsed?.();}finally{restore();}
 }
 const verified=await verifyDesktopBuild(settings.output,{target:settings.target}),sourceArchive=settings.sourceArchive?await createDesktopSourceArchive(settings.output,{version:verified.version}):undefined,result={...verified,...(sourceArchive?{sourceArchive}:{}),webSourceRevision:release.revision,verifiedAt:new Date().toISOString(),windowsRuntimeExecuted:false};
 const output=join(settings.output,settings.target==='win'?'desktop-release.json':'desktop-linux-smoke-build.json');await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({verified:true,platform:result.platform,version:result.version,artifacts:result.artifacts,manifest:output}));return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runDesktopBuild().catch(cause=>{console.error('데스크톱 빌드 실패:',cause?.message||'빌드 결과를 확인해 주세요.');process.exitCode=1;});
