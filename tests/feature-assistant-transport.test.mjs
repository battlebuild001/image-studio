import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {once} from 'node:events';
import {createProject, createScene} from '../dist/project.js';
import {CHAT_SCENE_FIELDS, CHAT_SETTING_FIELDS} from '../dist/chat-edit-protocol.js';
import {createDirectOpenAi} from '../dist/direct-openai.js';
import {createProductionApi} from '../scripts/production-api.mjs';
import {PRODUCTION_TASKS, ProductionAssistantError, validateProductionAssistantRequest, buildProductionAssistantRequest, parseProductionAssistantResponse, normalizeProductionAssistantResult} from '../dist/production-assistant-protocol.js';

// These are synthetic credentials and intercepted provider payloads. No paid or
// authenticated public service is called by this suite.
const key = 'sk-test-feature-assistant-only-not-a-real-api-key';
const png = (await readFile(new URL('./fixtures/image-test-1.png', import.meta.url))).toString('base64');
const completed = value => ({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}]});
const json = value => new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
const post = value => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
const sourceText = 'In 2030, the first colony was established. In 2040, the city was abandoned.';
const fullScript = '2030년 최초의 식민지가 건설되었습니다.';
function fixtures() {
  const scene = createScene({id:'scene-1',caption:fullScript,duration:60,imageId:'image-1'});
  const project = createProject({id:'episode-1',title:'합성 테스트',scenes:[scene]});
  const fidelity = {task:'source-fidelity',context:{sourceText,fullScript,scenes:[{sceneId:'scene-1',text:fullScript,start:0,end:60}]},options:{}};
  const edit = {task:'edit-plan',context:{projectId:project.id,title:project.title,aspect:project.aspect,durationSeconds:60,selectedSceneIds:['scene-1'],scenes:[{id:scene.id,caption:scene.caption,start:0,end:60,...Object.fromEntries(Object.keys(CHAT_SCENE_FIELDS).map(name=>[name,scene[name] ?? (name==='exposure'?0:undefined)]))}],settings:Object.fromEntries(Object.keys(CHAT_SETTING_FIELDS).map(name=>[name,project.settings[name]])),audio:{narration:false,bgm:false},instruction:'선택한 장면의 움직임을 없애 줘.'},options:{}};
  const framing = {task:'shorts-framing',context:{scenes:[{sceneId:'scene-1',width:1280,height:720,caption:fullScript}]},options:{},images:[{mimeType:'image/png',data:png,role:'scene',sceneId:'scene-1',label:'장면 1'}]};
  return [
    {request:fidelity, output:{summary:'원본의 두 사건 중 하나가 대본에 없습니다.',findings:[{kind:'missing',severity:'warning',sourceQuote:'In 2040, the city was abandoned.',scriptQuote:'',reason:'원본의 도시 포기 사건이 대본에 표현되지 않았습니다.',suggestion:'2040년 사건의 포함 여부를 검토하세요.',sceneId:''}],notes:[]}},
    {request:edit, output:{summary:'선택한 장면의 카메라 움직임을 멈춥니다.',operations:[{type:'scene',sceneId:'scene-1',patch:{motion:'none'}}],notes:[]}},
    {request:framing, output:{summary:'제공된 실제 이미지의 중앙 영역을 선택했습니다.',frames:[{sceneId:'scene-1',subjectFound:true,box:{x:.3,y:.1,width:.4,height:.8},reason:'실제 이미지의 중심 피사체 영역입니다.'}],notes:[]}},
  ];
}

function walkSchema(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties,false);
    assert.deepEqual([...schema.required].sort(),Object.keys(schema.properties).sort());
    for (const property of Object.values(schema.properties)) walkSchema(property);
  }
  if (schema.items) walkSchema(schema.items);
  for (const branch of schema.anyOf || []) walkSchema(branch);
}

test('new assistant tasks use strict bounded schemas and the existing fixed Responses model without web tools', () => {
  for (const {request,output} of fixtures()) {
    assert.ok(PRODUCTION_TASKS.includes(request.task));
    const payload=buildProductionAssistantRequest(request,'gpt-5-mini');
    assert.equal(payload.store,false);assert.equal(payload.tools,undefined);
    assert.equal(payload.text.format.strict,true);walkSchema(payload.text.format.schema);
    const data=JSON.parse(payload.input[0].content[0].text);
    assert.equal(data.task,request.task);assert.deepEqual(data.context,request.context);
    assert.match(payload.instructions,/실제 웹 검색은 이 요청에 포함되지/);
    assert.match(payload.instructions,/비밀 요청/);
    const result=parseProductionAssistantResponse(completed(output),request,'gpt-5-mini',new Date('2026-11-04T00:00:00.000Z'));
    assert.equal(result.model,'gpt-5-mini');assert.equal(result.createdAt,'2026-11-04T00:00:00.000Z');
    if (request.task==='shorts-framing') assert.equal(payload.input[0].content[1].image_url,'data:image/png;base64,'+png);
    else assert.equal(payload.input[0].content.length,1);
  }
});

test('new task adapters reject unsafe fields, missing pixel evidence, made-up quotes or scene ids and incomplete responses', () => {
  for (const {request,output} of fixtures()) {
    assert.throws(()=>validateProductionAssistantRequest({...request,context:{...request.context,apiKey:'test-secret'}}),ProductionAssistantError);
    assert.throws(()=>validateProductionAssistantRequest({...request,options:{...request.options,endpoint:'https://example.invalid'}}),ProductionAssistantError);
    assert.throws(()=>parseProductionAssistantResponse({status:'incomplete',output:[]},request),ProductionAssistantError);
    assert.throws(()=>normalizeProductionAssistantResult(request.task,{...output,model:'gpt-5-mini',createdAt:'2026-11-04T00:00:00.000Z'}),ProductionAssistantError);
    const value=structuredClone(output);value.rawProviderBody='unrequested';
    assert.throws(()=>parseProductionAssistantResponse(completed(value),request),ProductionAssistantError);
  }
  const [fidelity,edit,framing]=fixtures();
  const forged=structuredClone(fidelity.output);forged.findings[0].sourceQuote='An event never supplied by the user.';
  assert.throws(()=>parseProductionAssistantResponse(completed(forged),fidelity.request),ProductionAssistantError);
  const invented=structuredClone(edit.output);invented.operations[0].sceneId='made-up-scene';
  assert.throws(()=>parseProductionAssistantResponse(completed(invented),edit.request),ProductionAssistantError);
  assert.throws(()=>validateProductionAssistantRequest({...framing.request,images:[]}),ProductionAssistantError);
  const wrong=structuredClone(framing.output);wrong.frames[0].box.x=.9;
  assert.throws(()=>parseProductionAssistantResponse(completed(wrong),framing.request),ProductionAssistantError);
});

test('all new tasks route through personal-key direct transport once with no hidden image generation or alternative destination',async()=>{
  for (const {request,output} of fixtures()) {
    const calls=[],api=createDirectOpenAi({sessionStorage:null,localStorage:null,dispatchChange(){},fetchImpl:async(url,options)=>{calls.push({url,options});return json(completed(output));}});
    api.setDirectSettings({apiKey:key,scriptModel:'gpt-5-mini'});
    const config=await(await api.directApiFetch('/api/production/config')).json();assert.ok(config.tasks.includes(request.task));assert.equal(calls.length,0);
    const response=await api.directApiFetch('/api/production/assist',post(request));assert.equal(response.status,200,await response.clone().text());
    const result=await response.json();assert.equal(result.model,'gpt-5-mini');assert.equal(calls.length,1);
    assert.equal(calls[0].url,'https://api.openai.com/v1/responses');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');
    assert.equal(calls[0].options.headers.get('Authorization'),'Bearer '+key);assert.equal(JSON.stringify(result).includes(key),false);
  }
});

test('new tasks validate before provider dispatch and share direct cancellation and paid-job lock',async()=>{
  const fixture=fixtures()[0];let entered,calls=0;const started=new Promise(resolve=>entered=resolve);
  const api=createDirectOpenAi({sessionStorage:null,localStorage:null,dispatchChange(){},fetchImpl:async()=>{calls++;entered();return new Promise(()=>{});}});
  api.setDirectSettings({apiKey:key});
  const invalid=await api.directApiFetch('/api/production/assist',post({...fixture.request,context:{...fixture.request.context,sourceText:''}}));
  assert.equal(invalid.status,400);assert.equal(calls,0);
  const running=api.directApiFetch('/api/production/assist',post(fixture.request));await started;
  const locked=await api.directApiFetch('/api/production/assist',post(fixtures()[1].request));assert.equal(locked.status,429);assert.equal(calls,1);
  api.clearDirectSettings();await assert.rejects(running,error=>error.name==='AbortError');assert.equal(calls,1);
});

test('optional server and personal-key direct adapter share the exact new task contracts and safe rejection',async t=>{
  const cases=fixtures(),calls=[];
  const handler=createProductionApi({env:{SCRIPT_AI_API_KEY:key,SCRIPT_AI_MODEL:'gpt-5-mini'},requestProvider:async({payload})=>{const input=JSON.parse(payload.input[0].content[0].text);calls.push(input);return completed(cases.find(item=>item.request.task===input.task).output);}});
  const app=http.createServer(async(req,res)=>{await handler(req,res,new URL(req.url,'http://local').pathname);});
  app.listen(0,'127.0.0.1');await once(app,'listening');t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const base='http://127.0.0.1:'+app.address().port;
  const config=await(await fetch(base+'/api/production/config')).json();for(const {request} of cases)assert.ok(config.tasks.includes(request.task));assert.equal(calls.length,0);
  for (const {request} of cases) {
    const response=await fetch(base+'/api/production/assist',post(request));assert.equal(response.status,200,await response.clone().text());
    const result=await response.json();assert.equal(result.model,'gpt-5-mini');assert.equal(JSON.stringify(result).includes(key),false);
  }
  assert.equal(calls.length,3);
  const response=await fetch(base+'/api/production/assist',post({...cases[0].request,options:{hiddenUpload:true}}));assert.equal(response.status,400);assert.equal(calls.length,3);
});
