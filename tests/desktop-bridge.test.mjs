import test from 'node:test';
import assert from 'node:assert/strict';
import {createDirectOpenAi} from '../dist/direct-openai.js';
import {createDirectTypecastClient} from '../dist/direct-typecast.js';
import {createApiClient} from '../dist/api-client.js';
import {createDesktopProjectController,initializeDesktopBridge} from '../dist/desktop-bridge.js';
import {createDesktopFetch} from '../dist/desktop-fetch.js';

const OPENAI='sk-synthetic-desktop-openai-key-not-real',SECOND='sk-synthetic-desktop-second-key-not-real',TYPECAST='synthetic-desktop-typecast-key-not-real',TOKEN='synthetic-desktop-server-access-code';
function store(){const values=new Map();return{values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};}
function vault(){
 const persistent={},volatile={};let fail=false,calls=0;
 const bridge={version:1,loadSettingsSync(){calls++;return{available:true,settings:structuredClone({...persistent,...volatile})};},saveSettingsSync(patch){calls++;if(fail)throw Error('synthetic private vault failure');for(const[name,value]of Object.entries(patch)){delete persistent[name];delete volatile[name];if(value&&(name==='server'||value.rememberInBrowser))persistent[name]=structuredClone(value);else if(value?.rememberForTab)volatile[name]=structuredClone(value);}return{saved:true,available:true};}};
 return{bridge,persistent,volatile,set fail(value){fail=value;},get calls(){return calls;},restart(){for(const name of Object.keys(volatile))delete volatile[name];}};
}
function openai(native,extra={}){return createDirectOpenAi({desktopSettings:native,localStorage:store(),sessionStorage:store(),storageEvents:null,dispatchChange(){},...extra});}
function typecast(native,extra={}){return createDirectTypecastClient({desktopSettings:native,localStorage:store(),sessionStorage:store(),storageEvents:null,dispatchChange(){},...extra});}

test('native PC retention restores provider settings locally without browser plaintext, startup calls or sibling erasure',()=>{
 const native=vault(),local=store(),session=store();let calls=0;
 const a=openai(native.bridge,{localStorage:local,sessionStorage:session,fetchImpl:()=>{calls++;throw Error('No network on startup');}});
 a.setDirectSettings({apiKey:OPENAI,rememberInBrowser:true,scriptModel:'gpt-5-mini'});
 const t=typecast(native.bridge);t.setSettings({apiKey:TYPECAST,rememberInBrowser:true,model:'ssfm-v30'});
 const backend=createApiClient({desktopSettings:native.bridge,localStorage:local,sessionStorage:session,dispatchChange(){}});backend.setApiSettings({baseUrl:'https://server.example/studio',accessToken:TOKEN});
 assert.equal(openai(native.bridge).getDirectSettings().hasKey,true);assert.equal(typecast(native.bridge).getSettings().model,'ssfm-v30');
 assert.deepEqual(createApiClient({desktopSettings:native.bridge}).getApiSettings(),{baseUrl:'https://server.example/studio',hasToken:true});
 assert.equal(calls,0);assert.equal(local.values.size,0);assert.equal(session.values.size,0);
 assert.equal(JSON.stringify(a.getDirectSettings()).includes(OPENAI),false);assert.equal(JSON.stringify(t.getSettings()).includes(TYPECAST),false);
 a.clearDirectSettings();assert.equal(native.persistent.openai,undefined);assert.ok(native.persistent.typecast);assert.ok(native.persistent.server);
});

test('native window retention survives reload only, memory-only removes previous persistent copies and stale web copies',()=>{
 const native=vault(),local=store(),session=store();
 local.setItem('bth-studio-openai-browser-v1',JSON.stringify({apiKey:OPENAI,enabled:true,rememberInBrowser:true}));
 const a=openai(native.bridge,{localStorage:local,sessionStorage:session});assert.equal(a.getDirectSettings().hasKey,false);assert.equal(local.values.size,0);
 a.setDirectSettings({apiKey:OPENAI,rememberInBrowser:true});a.setDirectSettings({rememberForTab:true});
 assert.equal(native.persistent.openai,undefined);assert.equal(native.volatile.openai.apiKey,OPENAI);assert.equal(openai(native.bridge).getDirectSettings().hasKey,true);
 native.restart();assert.equal(openai(native.bridge).getDirectSettings().hasKey,false);
 a.setDirectSettings({rememberInBrowser:true});a.setDirectSettings({rememberInBrowser:false,rememberForTab:false});
 assert.equal(a.getDirectSettings().hasKey,true);assert.equal(openai(native.bridge).getDirectSettings().hasKey,false);assert.equal(local.values.size,0);assert.equal(session.values.size,0);
});

test('failed native vault writes preserve the live OpenAI key and do not announce success or leak native details',async()=>{
 const native=vault(),changes=[],requests=[];
 const a=openai(native.bridge,{dispatchChange:()=>changes.push(true),fetchImpl:async(url,options)=>{requests.push(options.headers.get('Authorization'));return Response.json({data:[]});}});
 a.setDirectSettings({apiKey:OPENAI,rememberInBrowser:true});native.fail=true;
 assert.throws(()=>a.setDirectSettings({apiKey:SECOND,rememberForTab:true}),cause=>cause.code==='OPENAI_SETTINGS_STORAGE'&&!cause.message.includes('private'));
 assert.throws(()=>a.clearDirectSettings(),cause=>cause.code==='OPENAI_SETTINGS_STORAGE');
 assert.equal(changes.length,1);assert.equal(a.getDirectSettings().rememberInBrowser,true);await a.checkDirectKey();assert.deepEqual(requests,[`Bearer ${OPENAI}`]);
});

test('native Typecast storage failure leaves the old model and key, while clear removes only its provider',()=>{
 const native=vault(),a=openai(native.bridge),t=typecast(native.bridge);
 a.setDirectSettings({apiKey:OPENAI,rememberInBrowser:true});t.setSettings({apiKey:TYPECAST,rememberForTab:true,model:'ssfm-v30'});native.fail=true;
 assert.throws(()=>t.setSettings({model:'ssfm-v31',rememberInBrowser:true}),cause=>cause.code==='TYPECAST_SETTINGS_STORAGE');
 assert.equal(t.getSettings().model,'ssfm-v30');native.fail=false;t.clearSettings();assert.equal(native.volatile.typecast,undefined);assert.ok(native.persistent.openai);
});

test('native backend vault writes preserve exact-prefix token reuse and fail atomically without browser credentials',async()=>{
 const native=vault(),local=store(),session=store(),requests=[],changes=[];
 const client=createApiClient({desktopSettings:native.bridge,localStorage:local,sessionStorage:session,dispatchChange:()=>changes.push(true),fetchImpl:async(url,options)=>{requests.push({url,token:options.headers.get('Authorization')});return Response.json({configured:true});}});
 client.setApiSettings({baseUrl:'https://server.example/prefix',accessToken:TOKEN});
 await client.candidateApiFetch('/api/script/config',{baseUrl:'https://server.example/prefix'});await client.candidateApiFetch('/api/script/config',{baseUrl:'https://server.example/other'});
 assert.deepEqual(requests.map(value=>value.token),[`Bearer ${TOKEN}`,null]);native.fail=true;
 assert.throws(()=>client.setApiSettings({baseUrl:'https://other.example'}),cause=>cause.code==='storage');assert.throws(()=>client.clearApiSettings(),cause=>cause.code==='storage');
 assert.deepEqual(client.getApiSettings(),{baseUrl:'https://server.example/prefix',hasToken:true});assert.equal(changes.length,1);assert.equal(local.values.size,0);assert.equal(session.values.size,0);
});

test('native project controller keeps opaque folder tokens, saves same folder until Save As and imports reviewed media',async()=>{
 let project={id:'one',title:'Original'},assets=new Map(),workspace='a';const saves=[],loadedAssets=new Map([['image',{blob:new Blob(['real bytes'])}]]);
 const bridge={saveProjectBundle:async payload=>{saves.push(payload);return{cancelled:false,folderToken:'folder-'+saves.length,name:'project'};},openProjectBundle:async()=>({cancelled:false,backupText:'valid backup',folderToken:'opened-folder'})};
 const api={getProject:()=>project,getAssets:()=>assets,getWorkspaceId:()=>workspace,canMutate:()=>true,replaceProject:async loaded=>{assert.equal(loaded.guard(),true);project=loaded.project;assets=loaded.assets;}};
 const controller=createDesktopProjectController(api,{bridge,parseBackup:async text=>{assert.equal(text,'valid backup');return{project:{id:'opened',title:'Loaded'},assets:loadedAssets};}});
 await controller.saveProjectBackup({backupText:'first',projectId:'one',suggestedName:'one'});await controller.saveProjectBackup({backupText:'second',projectId:'one'});await controller.saveProjectBackup({backupText:'third',projectId:'one',saveAs:true});
 assert.equal(saves[0].folderToken,undefined);assert.equal(saves[1].folderToken,'folder-1');assert.equal(saves[2].folderToken,undefined);
 await controller.openProject();assert.equal(project.id,'opened');assert.equal(assets,loadedAssets);await controller.saveProjectBackup({backupText:'opened',projectId:'opened'});assert.equal(saves[3].folderToken,'opened-folder');
});

test('cancelled or stale native file open preserves the existing workspace and real project assets',async()=>{
 let resolve,project={id:'one'},assets=new Map(),applied=0,parseCalls=0;const pending=new Promise(done=>resolve=done);
 const api={getProject:()=>project,getAssets:()=>assets,getWorkspaceId:()=>null,canMutate:()=>true,replaceProject:()=>applied++};
 const controller=createDesktopProjectController(api,{bridge:{openProjectBundle:()=>pending},parseBackup:()=>{parseCalls++;return{};}});
 const opening=controller.openProject();project.title='changed during dialog';resolve({cancelled:false,backupText:'old'});await assert.rejects(opening,/기존 작업/u);assert.equal(parseCalls,0);assert.equal(applied,0);
 const cancelled=createDesktopProjectController(api,{bridge:{openProjectBundle:async()=>({cancelled:true})}});assert.deepEqual(await cancelled.openProject(),{cancelled:true});assert.equal(applied,0);
 let nativeCalls=0;assert.equal(await initializeDesktopBridge({}, {bridge:{version:1,getInfo(){nativeCalls++;}}}),null);assert.equal(nativeCalls,0);
});

test('native fetch preserves multipart bytes, boundary, headers/status and routes public media through ordinary fetch',async()=>{
 const calls=[],fallback=[];const bridge={version:1,network:{fetch:async payload=>{calls.push(payload);return{status:206,statusText:'Partial Content',headers:[['content-type','application/octet-stream'],['range','bytes=0-2']],body:new Uint8Array([7,8,9]).buffer};},cancel:async()=>{}}};
 const fetch=createDesktopFetch({bridge,fetchImpl:async(...args)=>{fallback.push(args);return Response.json({fallback:true});}}),data=new FormData();data.append('image',new Blob([new Uint8Array([0,255,19])],{type:'image/png'}),'원본.png');data.append('prompt','한글 장면');
 const response=await fetch(new Request('https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:'Bearer synthetic'},body:data}));
 assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');assert.equal(new Headers(calls[0].headers).get('Authorization'),'Bearer synthetic');assert.match(new Headers(calls[0].headers).get('Content-Type'),/^multipart\/form-data; boundary=/u);assert.ok(Buffer.from(calls[0].body).includes(Buffer.from([0,255,19])));assert.ok(Buffer.from(calls[0].body).includes(Buffer.from('한글 장면')));assert.equal(response.status,206);assert.equal(response.headers.get('range'),'bytes=0-2');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([7,8,9]));
 await fetch('https://commons.wikimedia.org/w/api.php');await fetch('blob:https://example.org/test');assert.equal(fallback.length,2);assert.equal(calls.length,1);
});

test('native fetch abort cancels exactly its request without retry and oversized requests fail before IPC',async()=>{
 const calls=[],cancelled=[];const bridge={version:1,network:{fetch:payload=>{calls.push(payload);return new Promise(()=>{});},cancel:async value=>cancelled.push(value.id)}};
 const fetch=createDesktopFetch({bridge,maxBytes:8}),abort=new AbortController();
 const request=fetch('https://api.typecast.ai/v3/voices',{signal:abort.signal});await new Promise(resolve=>setImmediate(resolve));abort.abort();await assert.rejects(request,cause=>cause.name==='AbortError');assert.equal(calls.length,1);assert.deepEqual(cancelled,[calls[0].id]);
 await assert.rejects(fetch('https://api.openai.com/v1/responses',{method:'POST',body:'too many request bytes'}),/너무 커요/u);assert.equal(calls.length,1);
});

test('native menus only open existing settings or delegate explicit save, and disposal removes native listeners',async()=>{
 let callback,removed=false,providerCalls=0;const events=[];
 const bridge={version:1,saveProjectBundle:async()=>({cancelled:true}),openProjectBundle:async()=>({cancelled:true}),getInfo:async()=>({}),onMenuAction(fn){callback=fn;return()=>removed=true;},setBusy:async()=>{}};
 const api={canMutate:()=>true,getDesktopActivity:()=>({busy:false,unsaved:false}),saveCurrentProject:async options=>events.push(['save',options?.saveAs||false]),openExport:()=>events.push(['export-settings']),openApiSettings:()=>events.push(['api-settings'])};
 const controller=await initializeDesktopBridge(api,{bridge});
 for(const action of ['save-project','save-project-as','export-video','api-settings','unknown'])callback(action);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,[['save',false],['save',true],['export-settings'],['api-settings']]);assert.equal(providerCalls,0);controller.dispose();assert.equal(removed,true);
});

test('native optional backend checks serialize configuration with dispatch so candidate requests cannot alter current jobs',async()=>{
 const native=vault(),configured=[],calls=[];let release,firstStarted;
 const started=new Promise(resolve=>firstStarted=resolve),held=new Promise(resolve=>release=resolve);
 native.bridge.network={fetch(){},cancel(){},configureServer:async({baseUrl})=>configured.push(baseUrl)};
 const client=createApiClient({desktopSettings:native.bridge,dispatchChange(){},fetchImpl:async(url)=>{calls.push(url);if(calls.length===1){firstStarted();await held;}return Response.json({configured:true});}});
 client.setApiSettings({baseUrl:'https://current.example',accessToken:TOKEN});
 const current=client.apiFetch('/api/script/config');await started;
 const candidate=client.candidateApiFetch('/api/script/config',{baseUrl:'https://candidate.example'});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(configured,['https://current.example']);assert.equal(calls.length,1);release();await Promise.all([current,candidate]);
 assert.deepEqual(configured,['https://current.example','https://candidate.example']);assert.deepEqual(calls,['https://current.example/api/script/config','https://candidate.example/api/script/config']);
});
