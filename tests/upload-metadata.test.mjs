import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {createProject,createScene} from '../dist/project.js';
import {buildProductionAssistantRequest,validateProductionAssistantRequest,parseProductionAssistantResponse,normalizeProductionAssistantResult} from '../dist/production-assistant-protocol.js';
import {buildUploadMetadataContext,uploadMetadataSourceKey,generateUploadMetadata} from '../dist/upload-metadata.js';
import {createDirectOpenAi} from '../dist/direct-openai.js';
import {createProductionApi} from '../scripts/production-api.mjs';
import {createBackendAccess} from '../scripts/backend-access.mjs';
const date='2026-11-04T04:00:00.000Z',model='gpt-5-mini';
const complete=value=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const project=()=>createProject({title:'원본의 항해 이야기',scenes:[createScene({id:'first',caption:'개척자들이 우주선을 타고 새로운 행성으로 떠납니다.',duration:20,imageId:'image-a'}),createScene({id:'second',caption:'도착한 행성에서 도시를 건설하고 새로운 질서를 만듭니다.',duration:25,imageId:'image-b'})],scriptDraft:{draftScript:'오래된 발음 대본',displayScript:'오래된 화면 대본',result:null}});
const request=(task,context=buildUploadMetadataContext(project()))=>({task,context,options:{}});
const parse=(task,value,input=request(task))=>parseProductionAssistantResponse(complete(value),input,model,new Date(date));

test('title and description are separate exact JSON tasks with real YouTube Unicode and UTF8 bounds',()=>{
 assert.equal(parse('upload-title',{title:'🚀'.repeat(100)}).title.length,200);
 assert.throws(()=>parse('upload-title',{title:'🚀'.repeat(101)}));
 for(const value of [{title:'줄\n바꿈'},{title:'<태그>'},{title:'제목',description:'다른 항목'}])assert.throws(()=>parse('upload-title',value));
 assert.equal(parse('upload-description',{description:'가'.repeat(1666)}).description.length,1666);
 assert.throws(()=>parse('upload-description',{description:'가'.repeat(1667)}));
 assert.throws(()=>parse('upload-description',{description:'<html>본문</html>'}));
 for(const task of ['upload-title','upload-description']){const payload=buildProductionAssistantRequest(request(task));assert.equal(payload.text.format.strict,true);assert.deepEqual(Object.keys(payload.text.format.schema.properties),[task==='upload-title'?'title':'description']);assert.equal(payload.tools,undefined);assert.match(payload.instructions,/영상/);}
});
test('description uses only actual supplied source links and preserves readable Korean lines',()=>{
 const context={...buildUploadMetadataContext(project()),sources:[{title:'공식 설정',url:'https://example.org/%EC%84%A4%EC%A0%95'}]},input=request('upload-description',context);
 assert.equal(parse('upload-description',{description:'영상 소개입니다.\n\n출처: https://example.org/설정'},input).description,'영상 소개입니다.\n\n출처: https://example.org/설정');
 assert.throws(()=>parse('upload-description',{description:'출처: https://invented.example/story'},input),/출처/);
});
test('music recommendations are bounded style/query suggestions and never fabricated track assets',()=>{
 const recommendation={title:'차분한 우주 앰비언트',mood:'긴장감과 신비로움',style:'ambient',instruments:['신시사이저','현악기'],tempoBpm:null,searchQuery:'ambient cinematic instrumental',reason:'항해와 정착의 흐름을 방해하지 않는 편성입니다.'};
 const result=parse('music-recommendations',{recommendations:[recommendation]});assert.deepEqual(result.recommendations,[recommendation]);assert.equal(result.notes,undefined);
 for(const bad of [{...recommendation,tempoBpm:301},{...recommendation,tempoBpm:19},{...recommendation,audioUrl:'https://invented.example/song.mp3'},{...recommendation,instruments:Array(13).fill('피아노')}])assert.throws(()=>parse('music-recommendations',{recommendations:[bad]}));
 assert.throws(()=>parse('music-recommendations',{recommendations:Array(6).fill(recommendation)}));
 assert.throws(()=>validateProductionAssistantRequest({task:'music-recommendations',context:{title:'주제만'},options:{}}));
});
test('metadata context prioritizes actual timed captions and isolates external notes from unrelated project facts',()=>{
 const p=project(),context=buildUploadMetadataContext(p);assert.match(context.fullScript,/개척자들/);assert.equal(context.fullScript.includes('오래된'),false);assert.equal(context.durationSeconds,45);assert.deepEqual(context.scenes.map(item=>[item.start,item.end]),[[0,20],[20,45]]);
 const before=structuredClone(p),key=uploadMetadataSourceKey(p);p.production={version:1,budget:{spentUsd:1},youtube:{draft:{title:'수동 제목'}}};assert.equal(uploadMetadataSourceKey(p),key);p.scenes[0].caption='새 장면 내용';assert.notEqual(uploadMetadataSourceKey(p),key);assert.deepEqual(before.scriptDraft,p.scriptDraft);
 const external=buildUploadMetadataContext(p,{source:'external',notes:'외부 영상에서는 미니어처를 조립합니다. https://example.org/reference',currentTitle:'조립 과정'});assert.equal(external.sourceKind,'external');assert.equal(external.title,'');assert.equal(external.scenes.length,0);assert.equal(external.fullScript.includes('개척자'),false);assert.equal(external.sources[0].url,'https://example.org/reference');
 assert.throws(()=>buildUploadMetadataContext(p,{source:'external',notes:'  '}),/내용이나 대본/);
});
test('helper dispatches exactly one requested field through central API and validates before a provider request',async()=>{
 const calls=[],api={getProject:project,apiFetch:async(path,options)=>{calls.push({path,options});return Response.json({title:'희망을 품은 우주 이주',model,createdAt:date});}},controller=new AbortController();
 const result=await generateUploadMetadata(api,{field:'title',signal:controller.signal});assert.equal(result.title,'희망을 품은 우주 이주');assert.equal(result.description,undefined);assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/production/assist');assert.equal(calls[0].options.signal,controller.signal);assert.equal(JSON.parse(calls[0].options.body).task,'upload-title');
 await assert.rejects(generateUploadMetadata(api,{field:'title',source:'external',notes:''}),/외부 영상/);assert.equal(calls.length,1);
 const failed={...api,apiFetch:async()=>Response.json({error:'모의 작성 오류'},{status:429})};await assert.rejects(generateUploadMetadata(failed,{field:'description'}),/모의 작성 오류/);
});
test('new metadata tasks use fixed direct Responses model/schema and preserve original context without hidden search',async()=>{
 const calls=[],direct=createDirectOpenAi({sessionStorage:null,localStorage:null,dispatchChange(){},fetchImpl:async(url,options)=>{calls.push({url,options});const payload=JSON.parse(options.body),task=JSON.parse(payload.input[0].content[0].text).task;return Response.json(complete(task==='upload-title'?{title:'이주의 시작'}:{description:'새로운 행성에 도시가 세워지는 과정을 다룹니다.'}));}});direct.setDirectSettings({apiKey:'sk-synthetic-metadata-test-not-a-real-key'});
 for(const task of ['upload-title','upload-description']){const response=await direct.directApiFetch('/api/production/assist',{method:'POST',body:JSON.stringify(request(task))});assert.equal(response.ok,true);assert.equal((await response.json()).model,model);}
 assert.equal(calls.length,2);for(const call of calls){assert.equal(call.url,'https://api.openai.com/v1/responses');assert.equal(call.options.redirect,'error');assert.equal(call.options.credentials,'omit');const payload=JSON.parse(call.options.body);assert.equal(payload.tools,undefined);assert.match(payload.text.format.name,/production_upload_/);assert.equal(JSON.parse(payload.input[0].content[0].text).context.durationSeconds,45);}
});
test('authenticated optional server picks up both new metadata schemas with one provider request each',async t=>{
 const key='sk-synthetic-server-metadata-not-a-real-key',token='synthetic-metadata-access-token',env={SCRIPT_AI_API_KEY:key,STUDIO_ACCESS_TOKEN:token},gate=createBackendAccess({env,publicMode:true}),calls=[],handler=createProductionApi({env,requestProvider:async({payload})=>{calls.push(payload);const task=JSON.parse(payload.input[0].content[0].text).task;return complete(task==='upload-title'?{title:'정착지의 탄생'}:{description:'개척자들의 항해와 정착을 설명합니다.'});}}),app=http.createServer(async(req,res)=>{const path=new URL(req.url,'http://local').pathname;if(gate(req,res,path))return;if(await handler(req,res,path))return;res.writeHead(404).end();});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
 for(const task of ['upload-title','upload-description']){const response=await fetch(`http://127.0.0.1:${app.address().port}/api/production/assist`,{method:'POST',headers:{Origin:'https://battlebuild001.github.io',Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(request(task))});assert.equal(response.status,200);assert.equal(JSON.stringify(await response.json()).includes(key),false);}
 assert.equal(calls.length,2);assert.match(calls[0].text.format.name,/upload_title/);assert.match(calls[1].text.format.name,/upload_description/);
});
