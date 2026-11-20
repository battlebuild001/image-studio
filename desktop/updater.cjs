'use strict';
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

const REPOSITORY='battlebuild001/image-studio';
const RELEASE_API=`https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const MAX_RELEASE_BYTES=1024*1024,MIN_INSTALLER_BYTES=32*1024*1024,MAX_INSTALLER_BYTES=512*1024*1024;
const DOWNLOAD_HOSTS=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com']);
const failure=(code,message)=>Object.assign(new Error(message),{code});
const invalidRelease=()=>failure('DESKTOP_UPDATE_RELEASE','공식 업데이트 정보를 확인하지 못했어요. 잠시 뒤 다시 확인해 주세요.');
const cancelled=()=>Object.assign(failure('DESKTOP_UPDATE_CANCELLED','업데이트 다운로드를 취소했어요.'),{name:'AbortError'});
const clone=value=>JSON.parse(JSON.stringify(value));
function downloadFailure(cause,stage){
 if(cause.code?.startsWith('DESKTOP_'))return cause;
 if(stage==='folder')return failure('DESKTOP_UPDATE_FOLDER','업데이트 저장 폴더를 준비하지 못했어요. 저장 공간과 폴더 쓰기 권한을 확인해 주세요.');
 if(stage==='write')return failure('DESKTOP_UPDATE_WRITE','업데이트 파일을 저장하지 못했어요. 저장 공간과 쓰기 권한을 확인해 주세요.');
 return failure('DESKTOP_UPDATE_CONNECT',stage==='stream'?'업데이트 파일 전송을 마치지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.':'업데이트 서버에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
}

function versionParts(value){
 if(typeof value!=='string'||!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(value))throw invalidRelease();
 const result=value.split('.').map(Number);if(result.some(value=>!Number.isSafeInteger(value)||value>1000000))throw invalidRelease();return result;
}
function compareVersions(left,right){const a=versionParts(left),b=versionParts(right);for(let index=0;index<3;index++)if(a[index]!==b[index])return a[index]>b[index]?1:-1;return 0;}
function trustedUrl(value,{api=false}={}){
 let url;try{url=new URL(value);}catch{throw invalidRelease();}
 if(typeof value!=='string'||value.length>16384||/[\u0000-\u0020\u007f\\]/u.test(value)||url.protocol!=='https:'||url.username||url.password||url.port||url.hash||(api?url.href!==RELEASE_API:!DOWNLOAD_HOSTS.has(url.hostname)))throw invalidRelease();
 return url;
}
function normalizeRelease(input,currentVersion){
 versionParts(currentVersion);
 if(!input||typeof input!=='object'||input.draft!==false||input.prerelease!==false||typeof input.tag_name!=='string'||!input.tag_name.startsWith('desktop-v'))throw invalidRelease();
 const version=input.tag_name.slice('desktop-v'.length);versionParts(version);
 const page=`https://github.com/${REPOSITORY}/releases/tag/desktop-v${version}`;
 if(input.html_url!==page||!Number.isSafeInteger(input.id)||input.id<=0||!Array.isArray(input.assets)||input.assets.length>50)throw invalidRelease();
 if(compareVersions(version,currentVersion)<=0)return{available:false,version};
 const name=`Content-Studio-Setup-${version}-x64.exe`,matches=input.assets.filter(item=>item?.name===name);
 if(matches.length!==1)throw invalidRelease();const asset=matches[0];
 const url=`https://github.com/${REPOSITORY}/releases/download/desktop-v${version}/${name}`;
 if(asset.state!=='uploaded'||asset.browser_download_url!==url||!Number.isSafeInteger(asset.size)||asset.size<MIN_INSTALLER_BYTES||asset.size>MAX_INSTALLER_BYTES||!/^sha256:[a-f0-9]{64}$/u.test(asset.digest||''))throw invalidRelease();
 trustedUrl(url);
 return{available:true,version,name,url,bytes:asset.size,sha256:asset.digest.slice(7)};
}
function detectDistribution({env=process.env,executable=process.execPath,isPackaged=true,isFile=file=>{try{const value=syncFs.lstatSync(file);return value.isFile()&&!value.isSymbolicLink();}catch{return false;}}}={}){
 if(env.PORTABLE_EXECUTABLE_FILE||env.PORTABLE_EXECUTABLE_DIR)return'portable';
 return isPackaged&&isFile(path.join(path.dirname(executable),'Uninstall Content Studio.exe'))?'installed':'unpacked';
}
async function secureDirectory(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw failure('DESKTOP_UPDATE_STORAGE','업데이트 저장 위치를 확인하지 못했어요.');
 const resolved=path.resolve(directory),root=path.parse(resolved).root;
 let current=root;
 for(const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)){
  current=path.join(current,segment);let info;
  try{info=await fs.lstat(current);}catch(cause){if(cause.code!=='ENOENT')throw cause;try{await fs.mkdir(current,{mode:0o700});}catch(cause){if(cause.code!=='EEXIST')throw cause;}info=await fs.lstat(current);}
  if(!info.isDirectory()||info.isSymbolicLink())throw failure('DESKTOP_UPDATE_STORAGE','업데이트 저장 폴더가 안전한 일반 폴더인지 확인해 주세요.');
 }
 directory=resolved;
 if(await fs.realpath(directory)!==path.resolve(directory))throw failure('DESKTOP_UPDATE_STORAGE','업데이트 저장 폴더의 경로를 확인해 주세요.');
}
async function verifyInstaller(file,candidate,expected){
 const flags=syncFs.constants.O_RDONLY|(syncFs.constants.O_NOFOLLOW||0);let handle;
 try{handle=await fs.open(file,flags);
  const info=await handle.stat(),link=await fs.lstat(file);
  if(!info.isFile()||link.isSymbolicLink()||!link.isFile()||info.nlink!==1||info.size!==candidate.bytes||info.dev!==link.dev||info.ino!==link.ino||(expected&&(expected.dev!==info.dev||expected.ino!==info.ino||expected.size!==info.size)))throw failure('DESKTOP_UPDATE_FILE','업데이트 파일이 변경됐어요. 다시 다운로드해 주세요.');
  const hash=crypto.createHash('sha256'),header=Buffer.alloc(1024);let at=0;
  for await(const chunk of handle.createReadStream({autoClose:false})){if(at<header.length)chunk.copy(header,at,0,Math.min(chunk.length,header.length-at));at+=chunk.length;if(at>candidate.bytes)throw failure('DESKTOP_UPDATE_FILE','업데이트 파일 크기가 달라요. 다시 다운로드해 주세요.');hash.update(chunk);}
  const after=await handle.stat();
  if(at!==candidate.bytes||hash.digest('hex')!==candidate.sha256||info.mtimeMs!==after.mtimeMs||info.size!==after.size||header.subarray(0,2).toString()!=='MZ')throw failure('DESKTOP_UPDATE_FILE','업데이트 파일 검증에 실패했어요. 다시 다운로드해 주세요.');
  const pe=header.readUInt32LE(60);if(pe<64||pe>header.length-6||header.subarray(pe,pe+4).toString('binary')!=='PE\0\0'||![0x14c,0x8664].includes(header.readUInt16LE(pe+4)))throw failure('DESKTOP_UPDATE_FILE','올바른 Windows 업데이트 파일이 아니에요.');
  const latest=await fs.lstat(file);if(latest.isSymbolicLink()||latest.ino!==info.ino||latest.dev!==info.dev||latest.size!==info.size||latest.mtimeMs!==info.mtimeMs)throw failure('DESKTOP_UPDATE_FILE','업데이트 파일이 변경됐어요. 다시 다운로드해 주세요.');
  return{handle,stat:{dev:info.dev,ino:info.ino,size:info.size}};
 }catch(cause){await handle?.close().catch(()=>{});throw cause.code?.startsWith('DESKTOP_')?cause:failure('DESKTOP_UPDATE_FILE','업데이트 파일을 확인하지 못했어요. 다시 다운로드해 주세요.');}
}
function launchInstaller(file,args){
 const env={...process.env};for(const key of['PORTABLE_EXECUTABLE_FILE','PORTABLE_EXECUTABLE_DIR','PORTABLE_EXECUTABLE_APP_FILENAME'])delete env[key];
 return new Promise((resolve,reject)=>{const child=spawn(file,args,{detached:true,stdio:'ignore',windowsHide:true,shell:false,env});child.once('error',()=>reject(failure('DESKTOP_UPDATE_INSTALL','업데이트 설치 프로그램을 시작하지 못했어요. 다시 시도해 주세요.')));child.once('spawn',()=>{child.unref();resolve();});});
}
function createDesktopUpdater({currentVersion,directory,fetchImpl=globalThis.fetch,platform=process.platform,architecture=process.arch,isPackaged=true,distribution=detectDistribution({isPackaged}),getActivity=()=>({busy:false,unsaved:false}),launch=launchInstaller,quit=()=>{},onProgress=()=>{},metadataTimeoutMs=20000,downloadTimeoutMs=15*60*1000}={}){
 versionParts(currentVersion);
 if(!['installed','portable','unpacked'].includes(distribution))throw new TypeError('Invalid updater distribution');
 const supported=platform==='win32'&&architecture==='x64'&&isPackaged;
 let state={status:supported?'idle':'unsupported',currentVersion,distribution,message:supported?'업데이트 버튼으로 새 버전을 확인할 수 있어요.':'Windows 64비트 배포 프로그램에서 업데이트할 수 있어요.'},candidate=null,prepared=null,active=null,disposed=false;
 const getState=()=>clone(state),emit=patch=>{state={...state,...patch};try{onProgress(getState());}catch{}return getState();};
 const assertSupported=()=>{if(disposed)throw failure('DESKTOP_UPDATE_DISPOSED','업데이트 창을 다시 열어 주세요.');if(!supported)throw failure('DESKTOP_UPDATE_UNSUPPORTED','Windows 64비트 배포 프로그램에서 업데이트할 수 있어요.');};
 const assertIdle=()=>{assertSupported();if(active||state.status==='installing')throw failure('DESKTOP_UPDATE_BUSY','진행 중인 업데이트 작업을 마친 뒤 다시 시도해 주세요.');};
 const assertCanInstall=()=>{const activity=getActivity()||{};if(activity.busy)throw failure('DESKTOP_UPDATE_WORK_ACTIVE','제작·인코딩·업로드 작업이 끝난 뒤 업데이트해 주세요.');if(activity.unsaved)throw failure('DESKTOP_UPDATE_UNSAVED','변경한 프로젝트와 제목을 먼저 저장한 뒤 업데이트해 주세요.');};
 async function removeOwned(folder){
  try{if(path.dirname(folder)!==path.resolve(directory)||!/^download-[A-Za-z0-9_-]+$/u.test(path.basename(folder)))return;const parent=await fs.lstat(directory);if(!parent.isDirectory()||parent.isSymbolicLink()||await fs.realpath(directory)!==path.resolve(directory))return;const info=await fs.lstat(folder);if(info.isSymbolicLink())await fs.unlink(folder);else if(info.isDirectory()&&await fs.realpath(folder)===path.resolve(folder))await fs.rm(folder,{recursive:true,force:true});}catch{}
 }
 async function cleanupPrepared(){const previous=prepared;prepared=null;if(previous)await removeOwned(previous.directory);}
 async function responseFor(url,{signal,metadata=false}={}){
  let selected=trustedUrl(url,{api:metadata});
  for(let count=0;count<=4;count++){
   let response;try{response=await fetchImpl(selected.href,{method:'GET',headers:{Accept:metadata?'application/vnd.github+json':'application/octet-stream','User-Agent':`Content-Studio/${currentVersion}`},credentials:'omit',cache:'no-store',redirect:'manual',signal});}catch(cause){if(signal.aborted)throw cancelled();throw downloadFailure(cause,'connect');}
   if(signal.aborted)throw cancelled();
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');await response.body?.cancel?.().catch?.(()=>{});
    if(metadata||!location||count===4)throw invalidRelease();selected=trustedUrl(new URL(location,selected).href);if(selected.hostname==='github.com'&&selected.href!==url)throw invalidRelease();continue;
   }
   if(!response.ok)throw failure('DESKTOP_UPDATE_NETWORK',response.status===403||response.status===429?'업데이트 서버의 요청 제한에 도달했어요. 잠시 뒤 다시 확인해 주세요.':'업데이트 서버에 연결하지 못했어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.');
   if(!response.body)throw failure('DESKTOP_UPDATE_NETWORK','업데이트 서버의 응답을 읽지 못했어요.');return response;
  }
  throw invalidRelease();
 }
 async function check(){
  assertIdle();const controller=new AbortController();active=controller;let timeout,timedOut=false;emit({status:'checking',message:'새 버전을 확인하고 있어요.',error:'',errorCode:''});
  try{
   timeout=setTimeout(()=>{timedOut=true;controller.abort();},metadataTimeoutMs);const response=await responseFor(RELEASE_API,{signal:controller.signal,metadata:true});const chunks=[];let bytes=0;
   for await(const value of response.body){if(controller.signal.aborted)throw cancelled();const chunk=Buffer.from(value);bytes+=chunk.length;if(bytes>MAX_RELEASE_BYTES)throw invalidRelease();chunks.push(chunk);}
   const release=normalizeRelease(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),currentVersion);
   if(controller.signal.aborted)throw cancelled();
   if(!release.available){candidate=null;await cleanupPrepared();return emit({status:'up-to-date',version:release.version,message:'현재 최신 버전을 사용하고 있어요.',bytes:0,downloadedBytes:0,progress:0,error:'',errorCode:''});}
   const same=prepared&&candidate?.sha256===release.sha256&&candidate?.version===release.version;candidate=release;if(!same)await cleanupPrepared();
   return emit({status:same?'ready':'available',version:release.version,bytes:release.bytes,downloadedBytes:same?release.bytes:0,progress:same?1:0,message:same?'검증된 업데이트를 설치할 수 있어요.':'새 버전을 다운로드하고 업데이트할 수 있어요.',error:'',errorCode:''});
  }catch(cause){if(controller.signal.aborted&&!timedOut){emit({status:'cancelled',message:'업데이트 확인을 취소했어요.',error:'',errorCode:''});throw cancelled();}const safe=timedOut?failure('DESKTOP_UPDATE_TIMEOUT','업데이트 서버의 응답 시간이 초과됐어요. 잠시 뒤 다시 확인해 주세요.'):cause.code?.startsWith('DESKTOP_')?cause:invalidRelease();emit({status:'failed',message:'업데이트를 확인하지 못했어요.',error:safe.message,errorCode:safe.code});throw safe;}
  finally{clearTimeout(timeout);if(active===controller)active=null;}
 }
 async function download(){
  assertIdle();if(!candidate)throw failure('DESKTOP_UPDATE_NOT_CHECKED','먼저 업데이트 확인을 눌러 새 버전을 확인해 주세요.');if(prepared)return getState();
  const selected={...candidate},controller=new AbortController();active=controller;let staging,handle,timeout,timedOut=false,stage='folder';
  emit({status:'downloading',version:selected.version,bytes:selected.bytes,downloadedBytes:0,progress:0,message:'업데이트 파일을 다운로드하고 있어요.',error:'',errorCode:''});
  try{
   timeout=setTimeout(()=>{timedOut=true;controller.abort();},downloadTimeoutMs);await secureDirectory(directory);if(controller.signal.aborted)throw cancelled();staging=await fs.mkdtemp(path.join(directory,'download-'));await fs.chmod(staging,0o700);const partial=path.join(staging,selected.name+'.partial'),destination=path.join(staging,selected.name);
   stage='write';handle=await fs.open(partial,syncFs.constants.O_CREAT|syncFs.constants.O_EXCL|syncFs.constants.O_WRONLY|(syncFs.constants.O_NOFOLLOW||0),0o600);
   stage='connect';const response=await responseFor(selected.url,{signal:controller.signal});const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/u.test(length)||Number(length)!==selected.bytes))throw failure('DESKTOP_UPDATE_FILE','업데이트 파일 크기가 달라요. 다시 다운로드해 주세요.');
   stage='stream';let bytes=0,lastProgress=0;const hash=crypto.createHash('sha256');
   for await(const value of response.body){if(controller.signal.aborted)throw cancelled();const chunk=Buffer.from(value);bytes+=chunk.length;if(bytes>selected.bytes||bytes>MAX_INSTALLER_BYTES)throw failure('DESKTOP_UPDATE_FILE','업데이트 파일 크기가 달라요. 다시 다운로드해 주세요.');hash.update(chunk);let offset=0;while(offset<chunk.length){stage='write';const written=await handle.write(chunk,offset,chunk.length-offset);if(!written.bytesWritten)throw failure('DESKTOP_UPDATE_STORAGE','업데이트 파일을 저장하지 못했어요.');offset+=written.bytesWritten;}stage='stream';const progress=bytes/selected.bytes;if(progress-lastProgress>=.01||bytes===selected.bytes){lastProgress=progress;emit({downloadedBytes:bytes,progress});}}
   if(bytes!==selected.bytes||hash.digest('hex')!==selected.sha256)throw failure('DESKTOP_UPDATE_FILE','업데이트 파일 검증에 실패했어요. 다시 다운로드해 주세요.');
   stage='write';await handle.sync();await handle.close();handle=null;await fs.rename(partial,destination);const verified=await verifyInstaller(destination,selected);await verified.handle.close();if(controller.signal.aborted)throw cancelled();
   prepared={directory:staging,file:destination,stat:verified.stat};staging=null;return emit({status:'ready',downloadedBytes:bytes,progress:1,message:'다운로드와 파일 검증을 마쳤어요. 저장한 작업을 유지하며 업데이트할 수 있어요.',error:'',errorCode:''});
  }catch(cause){if(controller.signal.aborted&&!timedOut){emit({status:'cancelled',message:'업데이트 다운로드를 취소했어요.',error:'',errorCode:''});throw cancelled();}const safe=timedOut?failure('DESKTOP_UPDATE_TIMEOUT','업데이트 다운로드 시간이 초과됐어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'):downloadFailure(cause,stage);emit({status:'failed',message:'업데이트 파일을 준비하지 못했어요.',error:safe.message,errorCode:safe.code});throw safe;}
  finally{clearTimeout(timeout);await handle?.close().catch(()=>{});if(staging)await removeOwned(staging);if(active===controller)active=null;}
 }
 async function install(input){
  assertIdle();if(input!==undefined&&(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='convertToInstalled')||typeof input.convertToInstalled!=='boolean'))throw failure('DESKTOP_UPDATE_INPUT','업데이트 설치 옵션을 확인해 주세요.');
  if(distribution!=='installed'&&input?.convertToInstalled!==true)throw failure('DESKTOP_UPDATE_CONVERSION','무설치·압축형은 설치형으로 전환해 업데이트합니다. 설치형 전환 버튼으로 진행해 주세요.');
  assertCanInstall();if(!prepared||!candidate||state.status!=='ready')throw failure('DESKTOP_UPDATE_NOT_READY','먼저 새 버전을 다운로드하고 파일 검증을 마쳐 주세요.');
  const controller=new AbortController();active=controller;emit({status:'installing',message:'업데이트 설치를 시작하고 있어요.',error:'',errorCode:''});let verified;
  try{
   await secureDirectory(prepared.directory);verified=await verifyInstaller(prepared.file,candidate,prepared.stat);assertCanInstall();if(controller.signal.aborted)throw cancelled();
   await launch(prepared.file,['/S','--updated','--force-run','/currentuser']);await verified.handle.close();verified=null;quit();return getState();
  }catch(cause){const safe=cause.code?.startsWith('DESKTOP_')?cause:failure('DESKTOP_UPDATE_INSTALL','업데이트 설치를 시작하지 못했어요. 다시 시도해 주세요.');emit({status:['DESKTOP_UPDATE_FILE','DESKTOP_UPDATE_STORAGE'].includes(safe.code)?'failed':'ready',message:'설치를 시작하지 못했어요. 현재 프로그램과 프로젝트는 유지됩니다.',error:safe.message,errorCode:safe.code});if(['DESKTOP_UPDATE_FILE','DESKTOP_UPDATE_STORAGE'].includes(safe.code))await cleanupPrepared();throw safe;}
  finally{await verified?.handle.close().catch(()=>{});if(active===controller)active=null;}
 }
 return{check,download,install,getState,cancel(){if(active&&state.status!=='installing'){active.abort();return{cancelled:true};}return{cancelled:false};},isBusy:()=>Boolean(active)||state.status==='installing',dispose(){disposed=true;active?.abort();if(state.status!=='installing')cleanupPrepared().catch(()=>{});}};
}
module.exports={REPOSITORY,RELEASE_API,MAX_RELEASE_BYTES,MIN_INSTALLER_BYTES,MAX_INSTALLER_BYTES,compareVersions,normalizeRelease,detectDistribution,createDesktopUpdater};
