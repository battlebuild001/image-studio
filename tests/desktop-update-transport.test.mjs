import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createElectronUpdateFetch}=require('../desktop/update-transport.cjs');
const {createDesktopUpdater,RELEASE_API,MIN_INSTALLER_BYTES}=require('../desktop/updater.cjs');
const options=signal=>({method:'GET',redirect:'manual',credentials:'omit',headers:{Accept:'application/octet-stream','User-Agent':'Content-Studio/test'},...(signal?{signal}:{})});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const entry='https://github.com/battlebuild001/image-studio/releases/download/desktop-v1.1.2/Content-Studio-Setup-1.1.2-x64.exe';
const target='https://release-assets.githubusercontent.com/official-installer?signature=synthetic';
function native(scenario){
 const calls=[];
 const request=configuration=>{
  const client=new EventEmitter();client.configuration=configuration;client.headers={};client.aborts=0;
  client.setHeader=(name,value)=>client.headers[name]=value;
  client.abort=()=>{client.aborts++;queueMicrotask(()=>{client.emit('error',new Error('Redirect was cancelled'));client.emit('abort');});};
  client.end=()=>{client.ended=true;queueMicrotask(()=>scenario(client));};calls.push(client);return client;
 };
 return{calls,fetch:createElectronUpdateFetch({request})};
}
function response(client,body,{status=200,headers={}}={}){const incoming=Readable.from(body instanceof Readable?body:[body]);incoming.statusCode=status;incoming.headers=headers;client.emit('response',incoming);return incoming;}
async function temp(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'studio-update-transport-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
function release(){return{id:123,draft:false,prerelease:false,tag_name:'desktop-v1.1.2',html_url:'https://github.com/battlebuild001/image-studio/releases/tag/desktop-v1.1.2',assets:[{name:'Content-Studio-Setup-1.1.2-x64.exe',state:'uploaded',size:MIN_INSTALLER_BYTES,digest:'sha256:'+'a'.repeat(64),browser_download_url:entry}]};}
function controller(directory,fetchImpl,extra={}){return createDesktopUpdater({directory,fetchImpl,currentVersion:'1.1.1',platform:'win32',architecture:'x64',isPackaged:true,distribution:'installed',...extra});}

test('Electron manual redirect becomes a bounded HTTP response even when abort subsequently emits Redirect was cancelled',async()=>{
 const transport=native(client=>client.emit('redirect',302,'GET',target,{location:[target],'content-type':['text/html']}));
 const result=await transport.fetch(entry,options());await tick();assert.equal(result.status,302);assert.equal(result.headers.get('location'),target);assert.equal(result.body,null);assert.equal(transport.calls.length,1);assert.equal(transport.calls[0].aborts,1);assert.equal(transport.calls[0].configuration.redirect,'manual');assert.equal(transport.calls[0].configuration.credentials,'omit');assert.equal(transport.calls[0].configuration.useSessionCookies,false);assert.equal(transport.calls[0].followRedirect,undefined);
});

test('response status, headers and binary bytes survive native IncomingMessage conversion without automatic redirects',async()=>{
 const bytes=Buffer.from([0,1,255,13,10]),transport=native(client=>response(client,bytes,{headers:{'content-type':['application/octet-stream'],'content-length':[String(bytes.length)],'x-test':['a','b']}}));
 const result=await transport.fetch(target,options());assert.equal(result.status,200);assert.equal(result.headers.get('content-type'),'application/octet-stream');assert.equal(result.headers.get('x-test'),'a, b');assert.deepEqual(Buffer.from(await result.arrayBuffer()),bytes);assert.equal(transport.calls[0].headers.Accept,'application/octet-stream');assert.equal(transport.calls[0].aborts,0);
});

test('stream backpressure counts bytes so a response does not eagerly buffer the complete native download',async()=>{
 let produced=0;const chunks=256,size=32*1024,stream=new Readable({highWaterMark:size,read(){if(produced===chunks){this.push(null);return;}produced++;this.push(Buffer.alloc(size,produced%256));}});
 const transport=native(client=>{stream.statusCode=200;stream.headers={'content-length':[String(chunks*size)]};client.emit('response',stream);});
 const result=await transport.fetch(target,options());await tick();assert.ok(produced<12,`Read ${produced} chunks before consumption`);let bytes=0;for await(const chunk of result.body)bytes+=chunk.byteLength;assert.equal(bytes,chunks*size);assert.equal(produced,chunks);
});

test('aborted signals reject before opening a native request or interrupt an active request once',async()=>{
 const pre=new AbortController();pre.abort();const transport=native(()=>{});await assert.rejects(transport.fetch(target,options(pre.signal)),cause=>cause.name==='AbortError');assert.equal(transport.calls.length,0);
 const signal=new AbortController(),pending=transport.fetch(target,options(signal.signal));signal.abort();await assert.rejects(pending,cause=>cause.name==='AbortError');await tick();assert.equal(transport.calls[0].aborts,1);
});

test('cancellation after headers errors the streamed response and aborts native transfer instead of leaving a hanging body',async()=>{
 const incoming=new Readable({read(){}}),transport=native(client=>{incoming.statusCode=200;incoming.headers={};client.emit('response',incoming);});
 const signal=new AbortController(),result=await transport.fetch(target,options(signal.signal));signal.abort();await assert.rejects(result.arrayBuffer(),cause=>cause.name==='AbortError');await tick();assert.equal(incoming.destroyed,true);assert.equal(transport.calls[0].aborts,1);
});

test('a native request or interrupted native body rejects with no unresolved download promise',async()=>{
 const before=native(client=>client.emit('error',new Error('native transport failed')));await assert.rejects(before.fetch(target,options()),/native transport failed/u);
 const incoming=new Readable({read(){}}),during=native(client=>{incoming.statusCode=200;incoming.headers={};client.emit('response',incoming);});const result=await during.fetch(target,options());incoming.emit('aborted');await assert.rejects(result.arrayBuffer(),/전송이 중단/u);assert.equal(incoming.destroyed,true);
});

test('late native errors on a bodyless HTTP response are consumed rather than becoming an uncaught app exception',async()=>{
 const incoming=new Readable({read(){}}),transport=native(client=>{incoming.statusCode=204;incoming.headers={};client.emit('response',incoming);queueMicrotask(()=>client.emit('error',new Error('late native failure')));});
 const result=await transport.fetch(target,options());assert.equal(result.status,204);assert.equal(result.body,null);await tick();assert.equal(incoming.destroyed,true);
});

test('read-only update adapter refuses other protocols, hosts, credentials, request bodies and secret headers',async()=>{
 const transport=native(()=>{});
 for(const url of ['http://github.com/file.exe','https://evil.example/file.exe','file:///tmp/file.exe','https://user:password@github.com/file.exe','https://github.com:444/file.exe'])await assert.rejects(transport.fetch(url,options()));
 for(const value of [{...options(),method:'POST'},{...options(),redirect:'follow'},{...options(),credentials:'include'},{...options(),body:'secret'},{...options(),headers:{Authorization:'Bearer synthetic'}},{...options(),headers:{Cookie:'synthetic'}},{...options(),headers:{Accept:'bad\r\nvalue'}}])await assert.rejects(transport.fetch(target,value));
 assert.equal(transport.calls.filter(client=>client.ended).length,0);
});

test('native redirect response preserves the updater controller allowlist instead of following an untrusted location',async t=>{
 const transport=native(client=>{if(client.configuration.url===RELEASE_API)response(client,Buffer.from(JSON.stringify(release())));else client.emit('redirect',302,'GET','https://evil.example/installer.exe',{location:['https://evil.example/installer.exe']});});
 const updater=controller(await temp(t),transport.fetch);await updater.check();await assert.rejects(updater.download(),cause=>cause.code==='DESKTOP_UPDATE_RELEASE');assert.equal(transport.calls.length,2);assert.equal(transport.calls.some(client=>client.configuration.url.includes('evil.example')),false);
});

test('metadata and download timeouts are failed states with their own safe code, separate from user cancellation',async t=>{
 const stalled=(_url,options)=>new Promise((_resolve,reject)=>{const abort=()=>reject(new DOMException('abort','AbortError'));if(options.signal.aborted){abort();return;}options.signal.addEventListener('abort',abort,{once:true});});
 const metadata=controller(await temp(t),stalled,{metadataTimeoutMs:5});await assert.rejects(metadata.check(),cause=>cause.code==='DESKTOP_UPDATE_TIMEOUT');assert.equal(metadata.getState().status,'failed');assert.equal(metadata.getState().errorCode,'DESKTOP_UPDATE_TIMEOUT');
 const directory=await temp(t),download=controller(directory,(url,options)=>url===RELEASE_API?Promise.resolve(Response.json(release())):stalled(url,options),{downloadTimeoutMs:5});await download.check();await assert.rejects(download.download(),cause=>cause.code==='DESKTOP_UPDATE_TIMEOUT');assert.equal(download.getState().status,'failed');assert.equal(download.getState().errorCode,'DESKTOP_UPDATE_TIMEOUT');assert.deepEqual(await fs.readdir(directory),[]);
});

test('connection failures expose a safe actionable code without raw errors, private paths or signed URLs',async t=>{
 const privateDetail='https://release-assets.githubusercontent.com/f?signature=private C:\\Users\\Secret\\update.exe';
 const updater=controller(await temp(t),async url=>{if(url===RELEASE_API)return Response.json(release());throw new Error(privateDetail);});await updater.check();await assert.rejects(updater.download(),cause=>cause.code==='DESKTOP_UPDATE_CONNECT');const state=updater.getState();assert.equal(state.errorCode,'DESKTOP_UPDATE_CONNECT');assert.equal(JSON.stringify(state).includes('signature='),false);assert.equal(JSON.stringify(state).includes('Secret'),false);
});

test('folder preparation and file-write errors remain distinct and clean only the owned partial',async t=>{
 const parent=await temp(t),directory=path.join(parent,'updates'),originalMkdir=fs.mkdir;
 fs.mkdir=async function(selected,...args){if(selected===directory)throw Object.assign(new Error('private filesystem path'),{code:'EACCES'});return originalMkdir.call(this,selected,...args);};
 try{const updater=controller(directory,async()=>Response.json(release()));await updater.check();await assert.rejects(updater.download(),cause=>cause.code==='DESKTOP_UPDATE_FOLDER');assert.equal(updater.getState().errorCode,'DESKTOP_UPDATE_FOLDER');assert.equal(JSON.stringify(updater.getState()).includes('private filesystem'),false);}finally{fs.mkdir=originalMkdir;}
 const targetDirectory=await temp(t),originalOpen=fs.open;fs.open=async function(selected,...args){const handle=await originalOpen.call(this,selected,...args);if(typeof selected==='string'&&selected.endsWith('.partial'))handle.write=async()=>{throw Object.assign(new Error('disk full private path'),{code:'ENOSPC'});};return handle;};
 try{const updater=controller(targetDirectory,async url=>url===RELEASE_API?Response.json(release()):new Response(Buffer.from('data')));await updater.check();await assert.rejects(updater.download(),cause=>cause.code==='DESKTOP_UPDATE_WRITE');assert.equal(updater.getState().errorCode,'DESKTOP_UPDATE_WRITE');assert.deepEqual(await fs.readdir(targetDirectory),[]);}finally{fs.open=originalOpen;}
});
