import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createProject,createScene,exportProjectBackup,importProjectBackup} from '../dist/project.js';
const require=createRequire(import.meta.url);
const {createVault,createSettingsStore,validateSettingsPatch}=require('../desktop/vault.cjs');
const {createProjectFileStore}=require('../desktop/files.cjs');
const {isTrustedAppUrl,isSafeExternalUrl,createProtocolHandler}=require('../desktop/protocol.cjs');
const {safeNormalizeServerBase}=require('../desktop/network.cjs');
const OPENAI='sk-synthetic-desktop-host-test-only',TYPECAST='synthetic-typecast-host-test-only';
async function temp(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'content-studio-host-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
function encryptedStorage(){
  const key=crypto.randomBytes(32);
  return{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'gnome_libsecret',encryptString(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},decryptString(value){const decipher=crypto.createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');}};
}
const openai=(options={})=>({enabled:true,apiKey:OPENAI,rememberInBrowser:true,rememberForTab:false,scriptModel:'gpt-5-mini',imageModel:'gpt-image-2',transcribeModel:'whisper-1',...options});

test('OS vault encrypts provider keys, preserves namespaces and survives process-store reconstruction',async t=>{
  const directory=await temp(t),storage=encryptedStorage(),vault=createVault({directory,safeStorage:storage,platform:'win32'});
  vault.writeSync('settings',{openai:openai()});await vault.write('youtube.oauth',{clientId:'synthetic-client-id',clientSecret:'synthetic-oauth-secret'});
  const disk=await fs.readFile(path.join(directory,'secure-settings-v1.bin'),'utf8');
  assert.equal(disk.includes(OPENAI),false);assert.equal(disk.includes('synthetic-oauth-secret'),false);
  const restarted=createVault({directory,safeStorage:storage,platform:'win32'});
  assert.deepEqual(restarted.readSync('settings'),{openai:openai()});await restarted.delete('settings');
  assert.equal((await restarted.read('youtube.oauth')).clientId,'synthetic-client-id');assert.equal(restarted.readSync('settings'),null);
  await restarted.delete('youtube.oauth');assert.equal((await fs.readdir(directory)).length,0);
});

test('unavailable or basic-text keyring refuses persistent secrets while tab-only retention stays volatile',async t=>{
  const directory=await temp(t),storage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text',encryptString(){throw Error('must not encrypt');}},vault=createVault({directory,safeStorage:storage,platform:'linux'}),settings=createSettingsStore(vault);
  assert.equal(settings.load().available,false);
  assert.throws(()=>settings.save({openai:openai()}),cause=>cause.code==='DESKTOP_SECURE_STORAGE_UNAVAILABLE');assert.deepEqual(settings.load().settings,{});
  settings.save({openai:openai({rememberInBrowser:false,rememberForTab:true})});assert.equal(settings.load().settings.openai.apiKey,OPENAI);
  assert.equal(createSettingsStore(vault).load().settings.openai,undefined);assert.deepEqual(await fs.readdir(directory),[]);
});

test('native settings merge patches and retention changes atomically without deleting sibling providers or OAuth',async t=>{
  const directory=await temp(t),vault=createVault({directory,safeStorage:encryptedStorage()}),settings=createSettingsStore(vault,{normalizeServerBase:safeNormalizeServerBase});
  await vault.write('youtube.oauth',{clientId:'synthetic-client',clientSecret:'synthetic-oauth'});
  settings.save({openai:openai()});settings.save({typecast:{enabled:true,apiKey:TYPECAST,rememberForTab:true,rememberInBrowser:false,model:'ssfm-v31'}});
  settings.save({server:{baseUrl:'https://server.example/prefix/',accessToken:'synthetic-access-token'}});
  assert.equal(settings.load().settings.server.baseUrl,'https://server.example/prefix');
  assert.equal(settings.load().settings.typecast.apiKey,TYPECAST);assert.equal(vault.readSync('settings').typecast,undefined);
  settings.save({openai:openai({rememberInBrowser:false,rememberForTab:true})});assert.equal(vault.readSync('settings').openai,undefined);
  settings.save({openai:openai({rememberInBrowser:false,rememberForTab:false})});assert.equal(settings.load().settings.openai,undefined);
  settings.save({typecast:null});assert.equal(settings.load().settings.typecast,undefined);assert.ok(settings.load().settings.server);
  const before=settings.load();assert.throws(()=>settings.save({server:{baseUrl:'https://api.openai.com',accessToken:'synthetic'},openai:openai()}));assert.deepEqual(settings.load(),before);
  settings.clear();assert.deepEqual(settings.load().settings,{});assert.ok(await vault.read('youtube.oauth'));
});

test('settings boundary rejects arbitrary namespaces, nested data, controls and oversized input before any write',()=>{
  for(const patch of [{youtube:{token:'synthetic'}},{openai:{apiKey:{secret:OPENAI}}},{server:{baseUrl:'https://example.com',accessToken:'a\nb'}},{typecast:{apiKey:'x'.repeat(2049)}},{openai:{rememberForTab:true,rememberInBrowser:true}},{openai:{arbitraryPath:'/tmp/file'}}])assert.throws(()=>validateSettingsPatch(patch),cause=>cause.code==='DESKTOP_SETTINGS_INPUT');
});

test('corrupt encrypted settings require explicit quarantine recovery and never erase unrelated data automatically',async t=>{
  const directory=await temp(t),filename=path.join(directory,'secure-settings-v1.bin'),vault=createVault({directory,safeStorage:encryptedStorage()});
  await fs.writeFile(filename,'malformed encrypted envelope');
  assert.throws(()=>vault.readSync('settings'),cause=>cause.code==='DESKTOP_VAULT_READ_FAILED');assert.throws(()=>vault.deleteSync('settings'),cause=>cause.code==='DESKTOP_VAULT_READ_FAILED');
  assert.equal(await fs.readFile(filename,'utf8'),'malformed encrypted envelope');vault.resetSync();
  const files=await fs.readdir(directory);assert.equal(files.length,1);assert.match(files[0],/^secure-settings-v1\.bin\.reset-/u);assert.deepEqual(createSettingsStore(vault).load().settings,{});
  vault.writeSync('settings',{openai:openai()});assert.equal(vault.readSync('settings').openai.apiKey,OPENAI);
});

test('stable app protocol serves only bounded registered assets with secure CSP and excludes symlink escapes',async t=>{
  const directory=await temp(t),root=path.join(directory,'dist');await fs.mkdir(root);await fs.writeFile(path.join(root,'index.html'),'<html>local</html>');await fs.writeFile(path.join(root,'worker.js'),'export {};');await fs.writeFile(path.join(directory,'outside.js'),'secret');await fs.symlink(path.join(directory,'outside.js'),path.join(root,'escape.js'));
  const handler=createProtocolHandler({root,fetchFile:async url=>new Response(await fs.readFile(fileURLToPath(url)))});
  for(const url of ['studio://app/','studio://app/index.html#editor'])assert.equal(isTrustedAppUrl(url),true);
  for(const url of ['studio://app/worker.js','https://app/','studio://evil/','studio://user@app/','file:///etc/passwd','studio://app:80/'])assert.equal(isTrustedAppUrl(url),false);
  const page=await handler({url:'studio://app/',method:'GET'});assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/worker-src 'self' blob:/u);assert.equal(page.headers.get('x-content-type-options'),'nosniff');assert.match(await page.text(),/local/u);
  assert.equal((await handler({url:'studio://app/worker.js',method:'GET'})).status,200);
  for(const url of ['studio://app/escape.js','studio://app/.env','studio://app/%2e%2e/outside.js','studio://app/%2fetc/passwd','studio://app/private.bin','studio://evil/index.html','file:///etc/passwd'])assert.equal((await handler({url,method:'GET'})).status,404);
  assert.equal((await handler({url:'studio://app/',method:'POST'})).status,405);
  for(const url of ['https://example.com/help','http://localhost:1234/'])assert.equal(isSafeExternalUrl(url),true);
  for(const url of ['javascript:alert(1)','file:///etc/passwd','https://user:secret@example.com','https://example.com/\n'])assert.equal(isSafeExternalUrl(url),false);
});

async function fixture(type='image/png'){
  const project=createProject({title:'실제 프로젝트 파일',scenes:[createScene({imageId:'image-a',caption:'테스트 장면',duration:2})]});project.audio.narrationId='audio-a';
  const assets=new Map([['image-a',{name:'그림',blob:new Blob([new Uint8Array([1,2,3,4])],{type})}],['audio-a',{name:'녹음',blob:new Blob(['RIFFreal-media-data'],{type:'audio/x-custom-format'})}]]);
  return{project,assets,backupText:await(await exportProjectBackup(project,assets)).text()};
}
function dialogs(directory){return{showOpenDialog:async()=>({canceled:false,filePaths:[directory]}),showSaveDialog:async()=>({canceled:false,filePath:path.join(directory,'export.mp4')}),showMessageBox:async()=>({response:0})};}

test('native project folder round-trip stores real image/audio bytes with hashes and opaque grants',async t=>{
  const directory=await temp(t),data=await fixture('image/avif'),nativeDialog=dialogs(directory),files=createProjectFileStore({dialog:nativeDialog,defaultDirectory:directory});
  const result=await files.saveProjectBundle({suggestedName:data.project.title,backupText:data.backupText});assert.equal(result.cancelled,false);assert.match(result.folderToken,/^[a-f0-9]{48}$/u);assert.equal(result.name,path.basename(directory));assert.equal(JSON.stringify(result).includes(directory),false);
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'project.json'),'utf8'));assert.equal(manifest.kind,'content-studio-folder');assert.equal(manifest.assets.length,2);assert.match(manifest.assets[0].file,/\.avif$/u);assert.match(manifest.assets[1].file,/\.bin$/u);assert.equal(manifest.assets.some(asset=>Object.hasOwn(asset,'data')),false);
  for(const asset of manifest.assets){const bytes=await fs.readFile(path.join(directory,asset.file));assert.equal(bytes.length,asset.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),asset.sha256);}
  nativeDialog.showOpenDialog=async()=>({canceled:false,filePaths:[path.join(directory,'project.json')]});const opened=await files.openProjectBundle(),restored=await importProjectBackup(opened.backupText);
  assert.equal(restored.project.title,data.project.title);assert.deepEqual(new Uint8Array(await restored.assets.get('image-a').blob.arrayBuffer()),new Uint8Array([1,2,3,4]));assert.equal(await restored.assets.get('audio-a').blob.text(),'RIFFreal-media-data');
  files.clearGrants();await assert.rejects(files.saveProjectBundle({backupText:data.backupText,folderToken:result.folderToken}),cause=>cause.code==='DESKTOP_PROJECT_PERMISSION');
});

test('project save cancellation, malformed existing manifest, and forged directory capability preserve files',async t=>{
  const directory=await temp(t),data=await fixture(),nativeDialog=dialogs(directory),files=createProjectFileStore({dialog:nativeDialog,defaultDirectory:directory});
  nativeDialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});assert.deepEqual(await files.saveProjectBundle({backupText:data.backupText}),{cancelled:true});assert.deepEqual(await fs.readdir(directory),[]);
  await assert.rejects(files.saveProjectBundle({backupText:data.backupText,folderToken:directory}),cause=>cause.code==='DESKTOP_PROJECT_PERMISSION');assert.deepEqual(await fs.readdir(directory),[]);
  nativeDialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});await fs.writeFile(path.join(directory,'project.json'),'unrelated malformed JSON');let prompts=0;nativeDialog.showMessageBox=async()=>{prompts++;return{response:0};};
  assert.deepEqual(await files.saveProjectBundle({backupText:data.backupText}),{cancelled:true});assert.equal(prompts,1);assert.equal(await fs.readFile(path.join(directory,'project.json'),'utf8'),'unrelated malformed JSON');
  const real=path.join(directory,'real.json');await fs.writeFile(real,'keep');await fs.unlink(path.join(directory,'project.json'));await fs.symlink(real,path.join(directory,'project.json'));
  await assert.rejects(files.saveProjectBundle({backupText:data.backupText}),cause=>cause.code==='DESKTOP_PROJECT_INVALID');assert.equal(await fs.readFile(real,'utf8'),'keep');
});

test('folder import refuses tampered media and path traversal while legacy backups still open',async t=>{
  const directory=await temp(t),data=await fixture(),nativeDialog=dialogs(directory),files=createProjectFileStore({dialog:nativeDialog,defaultDirectory:directory});await files.saveProjectBundle({backupText:data.backupText});
  const manifestFile=path.join(directory,'project.json'),manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));nativeDialog.showOpenDialog=async()=>({canceled:false,filePaths:[manifestFile]});
  const media=path.join(directory,manifest.assets[0].file);await fs.writeFile(media,'tampered');await assert.rejects(files.openProjectBundle(),cause=>cause.code==='DESKTOP_PROJECT_INVALID');
  manifest.assets[0].file='../outside.png';await fs.writeFile(manifestFile,JSON.stringify(manifest));await assert.rejects(files.openProjectBundle(),cause=>cause.code==='DESKTOP_PROJECT_INVALID');
  const legacy=path.join(directory,'legacy.bth.json');await fs.writeFile(legacy,data.backupText);nativeDialog.showOpenDialog=async()=>({canceled:false,filePaths:[legacy]});const loaded=await files.openProjectBundle();assert.equal(loaded.folderToken,null);assert.equal((await importProjectBackup(loaded.backupText)).project.id,data.project.id);
});

test('native export writes exact bytes only to an explicitly selected save destination',async t=>{
  const directory=await temp(t),nativeDialog=dialogs(directory),files=createProjectFileStore({dialog:nativeDialog,defaultDirectory:directory}),bytes=new Uint8Array([0,1,128,255]).buffer;
  const result=await files.saveExport({suggestedName:'export.mp4',bytes});assert.equal(result.name,'export.mp4');assert.equal(result.bytes,4);assert.deepEqual(await fs.readFile(path.join(directory,'export.mp4')),Buffer.from(bytes));
  nativeDialog.showSaveDialog=async()=>({canceled:true});assert.deepEqual(await files.saveExport({suggestedName:'export.mp4',bytes}),{cancelled:true});await assert.rejects(files.saveExport({filename:'/tmp/arbitrary',bytes}),cause=>cause.code==='DESKTOP_EXPORT_INPUT');
});
