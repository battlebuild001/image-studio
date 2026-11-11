'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');

const MAX_BACKUP_BYTES = 250 * 1024 * 1024, MAX_MEDIA_BYTES = 180 * 1024 * 1024, MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,180}$/u;
const EXTENSIONS = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/svg+xml':'svg','image/gif':'gif','image/avif':'avif','image/bmp':'bmp','audio/wav':'wav','audio/x-wav':'wav','audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'m4a','audio/aac':'aac','audio/ogg':'ogg','audio/flac':'flac','audio/webm':'webm','video/mp4':'mp4','video/webm':'webm'};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code,message) => Object.assign(new Error(message),{code});
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function extension(type) {if(typeof type!=='string'||type.length>100||/[\u0000-\u001f\u007f]/u.test(type))return null;return EXTENSIONS[type.toLowerCase()]||(/^audio\//iu.test(type)||type===''||type==='application/octet-stream'?'bin':null);}
function safeName(value,fallback='콘텐츠 프로젝트') {return String(value || fallback).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu,'_').replace(/[. ]+$/u,'').slice(0,120)||fallback;}
async function atomicWrite(filename,data) {
  const staged = filename + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  let handle;
  try {handle = await fs.open(staged,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle = null;await fs.rename(staged,filename);}
  finally {await handle?.close().catch(()=>{});await fs.unlink(staged).catch(()=>{});}
}
async function regularFile(filename,maximum) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw error('DESKTOP_PROJECT_INVALID','프로젝트 파일의 형식이나 크기를 확인해 주세요.');
  return stat;
}
async function validateBackup(backupText) {
  if (typeof backupText !== 'string' || Buffer.byteLength(backupText) > MAX_BACKUP_BYTES) throw error('DESKTOP_PROJECT_TOO_LARGE','프로젝트 파일은 250MB 이하로 저장해 주세요.');
  let envelope;
  try {envelope=JSON.parse(backupText);} catch {throw error('DESKTOP_PROJECT_INVALID','프로젝트 JSON 파일을 읽지 못했어요.');}
  const projectModule = await import(pathToFileURL(path.join(__dirname,'../dist/project.js')).href);
  // Share the app's exact schema, media and credential exclusions rather than
  // accepting a second looser native project format.
  const checked = await projectModule.importProjectBackup(backupText);
  return {project:checked.project,assets:envelope.assets.filter(asset=>checked.assets.has(asset.id)),exportedAt:envelope.exportedAt||new Date().toISOString()};
}
function createProjectFileStore({dialog,getWindow=()=>undefined,defaultDirectory,validate=validateBackup}={}) {
  const grants = new Map();
  async function grant(directory) {
    const real = await fs.realpath(directory), stat = await fs.stat(real);
    if (!stat.isDirectory()) throw error('DESKTOP_PROJECT_FOLDER','저장할 폴더를 다시 선택해 주세요.');
    const token = crypto.randomBytes(24).toString('hex');grants.set(token,{path:real,dev:stat.dev,ino:stat.ino});
    return {folderToken:token,name:path.basename(real)};
  }
  async function granted(token) {
    const selected = typeof token === 'string' ? grants.get(token) : null;
    if (!selected) throw error('DESKTOP_PROJECT_PERMISSION','프로젝트 폴더를 먼저 선택해 주세요.');
    const real = await fs.realpath(selected.path), stat = await fs.stat(real);
    if (real !== selected.path || !stat.isDirectory() || stat.dev !== selected.dev || stat.ino !== selected.ino) throw error('DESKTOP_PROJECT_PERMISSION','선택한 폴더가 바뀌었어요. 폴더를 다시 선택해 주세요.');
    return real;
  }
  async function chooseProjectFolder() {
    const result = await dialog.showOpenDialog(getWindow(),{title:'프로젝트와 미디어를 저장할 폴더 선택',defaultPath:defaultDirectory,properties:['openDirectory','createDirectory']});
    if (result.canceled || !result.filePaths?.[0]) return {cancelled:true};
    return {cancelled:false,...await grant(result.filePaths[0])};
  }
  async function saveProjectBundle(input) {
    if (!plain(input) || Object.keys(input).some(key=>!['suggestedName','backupText','folderToken'].includes(key))) throw error('DESKTOP_PROJECT_INPUT','저장할 프로젝트를 확인해 주세요.');
    const data = await validate(input.backupText);
    const choice = input.folderToken ? {cancelled:false,folderToken:input.folderToken} : await chooseProjectFolder();
    if (choice.cancelled) return choice;
    const directory = await granted(choice.folderToken), manifestFile = path.join(directory,'project.json'), assetDirectory = path.join(directory,'assets');
    let previous,exists=false;
    try {await regularFile(manifestFile,MAX_MANIFEST_BYTES);exists=true;try{previous=JSON.parse(await fs.readFile(manifestFile,'utf8'));}catch(cause){if(!(cause instanceof SyntaxError))throw cause;}} catch(cause) {if(cause.code!=='ENOENT')throw cause;}
    if (exists && (!plain(previous)||previous.kind!=='content-studio-folder'||previous.version!==1||previous.project?.id!==data.project.id)) {
      const result=await dialog.showMessageBox(getWindow(),{type:'warning',title:'다른 프로젝트가 있는 폴더',message:'이 폴더에 다른 프로젝트 파일이 있어요.',detail:'현재 프로젝트로 project.json을 바꿀까요? 기존 미디어 파일은 지우지 않습니다.',buttons:['취소','이 프로젝트로 저장'],defaultId:0,cancelId:0,noLink:true});
      if(result.response!==1)return{cancelled:true};
    }
    try {const stat=await fs.lstat(assetDirectory);if(!stat.isDirectory()||stat.isSymbolicLink())throw error('DESKTOP_PROJECT_PERMISSION','미디어 저장 폴더를 다시 선택해 주세요.');}catch(cause){if(cause.code==='ENOENT')await fs.mkdir(assetDirectory,{mode:0o700});else throw cause;}
    const records=[];let total=0;
    for(const asset of data.assets) {
      const ext=extension(asset.type);
      if(!ID.test(asset.id)||typeof asset.data!=='string'||!ext)throw error('DESKTOP_PROJECT_INVALID','지원하는 이미지·음성 미디어만 저장할 수 있어요.');
      const bytes=Buffer.from(asset.data,'base64');total+=bytes.length;if(total>MAX_MEDIA_BYTES)throw error('DESKTOP_PROJECT_TOO_LARGE','프로젝트 미디어 합계는 180MB 이하여야 해요.');
      const digest=hash(bytes),file=`assets/${asset.id}-${digest.slice(0,16)}.${ext}`;
      const target=path.join(directory,...file.split('/'));
      // Content-addressed files keep the previous complete manifest valid even
      // if saving the next revision is interrupted before its atomic rename.
      await atomicWrite(target,bytes);
      records.push({id:asset.id,name:asset.name,type:asset.type,file,bytes:bytes.length,sha256:digest});
    }
    const manifest={kind:'content-studio-folder',version:1,savedAt:new Date().toISOString(),project:data.project,assets:records};
    await atomicWrite(manifestFile,JSON.stringify(manifest,null,2)+'\n');
    return {cancelled:false,folderToken:choice.folderToken,name:path.basename(directory)};
  }
  async function openProjectBundle() {
    const result=await dialog.showOpenDialog(getWindow(),{title:'Content Studio 프로젝트 열기',defaultPath:defaultDirectory,properties:['openFile'],filters:[{name:'Content Studio 프로젝트',extensions:['json']}]});
    if(result.canceled||!result.filePaths?.[0])return{cancelled:true};
    const selected=await fs.realpath(result.filePaths[0]);await regularFile(selected,MAX_BACKUP_BYTES);
    const text=await fs.readFile(selected,'utf8');let manifest;try{manifest=JSON.parse(text);}catch{throw error('DESKTOP_PROJECT_INVALID','프로젝트 JSON을 읽지 못했어요.');}
    if(manifest?.kind==='bth-image-studio') {await validate(text);return{cancelled:false,backupText:text,name:path.basename(selected),folderToken:null};}
    if(!plain(manifest)||manifest.kind!=='content-studio-folder'||manifest.version!==1||!Array.isArray(manifest.assets)||manifest.assets.length>207)throw error('DESKTOP_PROJECT_INVALID','Content Studio 폴더의 project.json이나 프로젝트 백업 파일을 선택해 주세요.');
    const directory=path.dirname(selected),records=[];let total=0;
    for(const asset of manifest.assets) {
      const ext=extension(asset?.type);
      if(!plain(asset)||!ID.test(asset.id)||!ext||typeof asset.file!=='string'||!new RegExp(`^assets/${asset.id}-[a-f0-9]{16}\\.${ext}$`,'u').test(asset.file)||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(asset.sha256)||!Number.isInteger(asset.bytes)||asset.bytes<0)throw error('DESKTOP_PROJECT_INVALID','프로젝트 미디어 경로와 목록을 확인해 주세요.');
      const target=path.resolve(directory,...asset.file.split('/'));await regularFile(target,MAX_MEDIA_BYTES);const real=await fs.realpath(target);
      if(!real.startsWith(directory+path.sep))throw error('DESKTOP_PROJECT_PERMISSION','프로젝트 폴더 밖의 파일은 불러올 수 없어요.');
      const bytes=await fs.readFile(target);total+=bytes.length;
      if(total>MAX_MEDIA_BYTES||bytes.length!==asset.bytes||hash(bytes)!==asset.sha256)throw error('DESKTOP_PROJECT_INVALID','프로젝트 미디어가 손상되었거나 다른 파일로 바뀌었어요.');
      records.push({id:asset.id,name:asset.name,type:asset.type,data:bytes.toString('base64')});
    }
    const backupText=JSON.stringify({kind:'bth-image-studio',version:1,exportedAt:manifest.savedAt,project:manifest.project,assets:records});await validate(backupText);
    return{cancelled:false,backupText,name:path.basename(directory),...await grant(directory)};
  }
  async function saveExport(input) {
    if(!plain(input)||Object.keys(input).some(key=>!['suggestedName','bytes'].includes(key))||!(input.bytes instanceof ArrayBuffer)||input.bytes.byteLength>512*1024*1024)throw error('DESKTOP_EXPORT_INPUT','저장할 파일의 형식과 크기를 확인해 주세요.');
    const name=safeName(input.suggestedName,'내보낸 파일'),result=await dialog.showSaveDialog(getWindow(),{title:'파일 저장',defaultPath:path.join(defaultDirectory||'',name),showOverwriteConfirmation:true});
    if(result.canceled||!result.filePath)return{cancelled:true};await atomicWrite(result.filePath,Buffer.from(input.bytes));return{cancelled:false,name:path.basename(result.filePath),bytes:input.bytes.byteLength};
  }
  return{chooseProjectFolder,saveProjectBundle,openProjectBundle,saveExport,clearGrants:()=>grants.clear()};
}
module.exports={createProjectFileStore,validateBackup,atomicWrite,safeName,MAX_BACKUP_BYTES,MAX_MEDIA_BYTES};
