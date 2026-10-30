import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {createDirectOpenAi, handlesDirectPath} from '../dist/direct-openai.js';
import {buildImagePrompt} from '../dist/image-prompt.js';
import {prepareReferenceImageRequest} from '../dist/image-studio.js';
import {validateImageRequest, buildImageMultipart, createImageProviderRequest, createImageApi} from '../scripts/image-api.mjs';

const key='sk-only-synthetic-video-image-transport-key';
const png=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url));
const second=await readFile(new URL('./fixtures/image-test-2.png',import.meta.url));
const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const imageInput=()=>({prompt:'공통 색감은 유지하되 이 장면은 초기 지구의 천문 관측소와 망원경을 보여 줍니다.',background:'해안 도시의 관측소',style:'절제된 다큐멘터리 풍',negativePrompt:'자막과 로고',size:'1536x864',quality:'medium',references:[]});
const imageReply=()=>({data:[{b64_json:png.toString('base64')}]});
const reference=(role,bytes,label)=>({role,mimeType:'image/png',data:bytes.toString('base64'),label});
const planInput=()=>({title:'합성 관측과 이주 이야기',fullScript:'처음에는 지구의 천문대가 신호를 포착합니다. 시간이 흐른 뒤 민간 이주선이 우주로 출발합니다.',brief:'두 시기의 차이를 보여 주는 차분한 다큐멘터리',background:'가상 연표',style:'청록과 금빛을 공통 팔레트로',negativePrompt:'전투 군인, 글자',items:[{sceneId:'scene-observatory',start:0,end:10,caption:'지구의 천문대가 신호를 포착합니다.'},{sceneId:'scene-departure',start:10,end:20,caption:'민간 이주선이 우주로 출발합니다.'}]});
const planReply=(input=planInput())=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({globalConcept:'차분한 청록·금빛 팔레트. 초기 지구의 과학 관측에서 민간 이주 준비로 이어집니다. 군인을 억지로 삽입하지 않습니다.',shots:input.items.map((item,index)=>({sceneId:item.sceneId,prompt:index?'먼 전경의 민간 이주선과 승선 터미널. 공통 색감을 유지합니다.':'지구 관측소 안의 망원경과 연구 장비. 미래 전투 장면은 넣지 않습니다.'}))})}]}]});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function client(fetchImpl){const c=createDirectOpenAi({sessionStorage:null,dispatchChange(){},fetchImpl});c.setDirectSettings({apiKey:key});return c;}

async function server(t, options={}){
 const handle=createImageApi({env:{IMAGE_AI_API_KEY:'synthetic-server-key'},...options});
 const s=http.createServer((req,res)=>{handle(req,res,new URL(req.url,'http://localhost').pathname).then(handled=>{if(!handled)res.writeHead(404).end();}).catch(()=>res.writeHead(500).end());});
 s.listen(0,'127.0.0.1');await once(s,'listening');t.after(async()=>{s.closeAllConnections();await new Promise(resolve=>s.close(resolve));});
 return body=>fetch(`http://127.0.0.1:${s.address().port}/api/image/generate`,post(body));
}

test('text-only direct image generation uses fixed generations JSON while shared content priorities do not invent attached references',async()=>{
 const requests=[];const api=client(async(url,options)=>{requests.push({url,options});return json(imageReply());});
 const response=await api.directApiFetch('/api/image/generate',post(imageInput()));assert.equal(response.status,200);const result=await response.json();assert.equal(result.referenceCount,0);
 assert.equal(requests.length,1);const {url,options}=requests[0];assert.equal(url,'https://api.openai.com/v1/images/generations');assert.equal(options.method,'POST');assert.equal(options.headers.get('Content-Type'),'application/json');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
 const payload=JSON.parse(options.body);assert.equal(payload.model,'gpt-image-2');assert.equal(payload.n,1);assert.equal(payload.output_format,'png');assert.equal(payload.input_fidelity,undefined);assert.equal(payload.image,undefined);assert.equal(payload.size,'1536x864');
 assert.match(payload.prompt,/참조 이미지가 첨부되지 않았습니다/u);assert.match(payload.prompt,/억지로 삽입하지/u);assert.match(payload.prompt,/초기 지구의 천문 관측소/u);assert.doesNotMatch(payload.prompt,/첨부한 고정 레퍼런스 이미지 자체를 기준/u);assert.equal(JSON.stringify(result).includes(key),false);
});

test('enabled references still use edits multipart with every actual concept-first image byte, never a text-only fallback',async()=>{
 let received;const api=client(async(url,options)=>{received={url,options};return json(imageReply());});
 const input={...imageInput(),references:[reference('background',png,'지구 배경'),reference('concept',second,'공통 디자인')]};
 const res=await api.directApiFetch('/api/image/generate',post(input));assert.equal(res.status,200);assert.equal((await res.json()).referenceCount,2);assert.equal(received.url,'https://api.openai.com/v1/images/edits');
 const form=received.options.body;assert.ok(form instanceof FormData);assert.equal(received.options.headers.has('Content-Type'),false);const images=form.getAll('image[]');assert.equal(images.length,2);assert.deepEqual(new Uint8Array(await images[0].arrayBuffer()),new Uint8Array(second));assert.deepEqual(new Uint8Array(await images[1].arrayBuffer()),new Uint8Array(png));
 assert.match(form.get('prompt'),/1\. 메인 컨셉 — 공통 디자인/u);assert.match(form.get('prompt'),/해당 인물·기체가 실제로 등장하는 장면에서만/u);assert.match(form.get('prompt'),/화풍 역할의 참조는 색감/u);
});

test('text-only image request preparation needs no media upload and respects cancellation',async()=>{
 const settings={...imageInput(),references:[]};const actual=await prepareReferenceImageRequest({settings,assets:new Map()});assert.deepEqual(actual.references,[]);assert.equal(actual.prompt,settings.prompt);assert.equal(actual.background,settings.background);
 const controller=new AbortController();controller.abort();await assert.rejects(prepareReferenceImageRequest({settings,assets:new Map(),signal:controller.signal}),{name:'AbortError'});
});

test('invalid references and oversized final composed prompts reject before a direct provider call',async()=>{
 let calls=0;const api=client(async()=>{calls++;return json(imageReply());});
 for(const patch of [{references:null},{references:[reference('concept',Buffer.from('not an image'),'손상 이미지')]},{references:Array.from({length:6},()=>reference('concept',png,'초과'))},{prompt:'가'.repeat(30001)},{prompt:'가'.repeat(28000),background:'나'.repeat(8000)}]){
  const result=await api.directApiFetch('/api/image/generate',post({...imageInput(),...patch}));assert.equal(result.status,400);assert.equal(calls,0);
 }
 assert.throws(()=>buildImagePrompt({...imageInput(),prompt:'가'.repeat(31000),background:'나'.repeat(2000)}),{code:'IMAGE_PROMPT_TOO_LARGE'});
});

test('optional Node image API and native transport send zero-reference JSON only to fixed generations endpoint',async t=>{
 const settings=validateImageRequest(imageInput());const payload=buildImageMultipart(settings);assert.equal(payload.referenceCount,0);assert.equal(payload.contentType,'application/json');const parsed=JSON.parse(payload.body.toString());assert.equal(parsed.n,1);assert.match(parsed.prompt,/참조 이미지가 첨부되지 않았습니다/u);
 let posted;const transport=createImageProviderRequest({},(url,options,onResponse)=>{assert.equal(url,'https://api.openai.com/v1/images/generations');assert.equal(options.headers['Content-Type'],'application/json');assert.equal(options.headers.Authorization,'Bearer test-key');const req=new EventEmitter();req.end=body=>{posted=body;const res=new EventEmitter();res.statusCode=200;onResponse(res);queueMicrotask(()=>{res.emit('data',Buffer.from(JSON.stringify(imageReply())));res.emit('end');});};return req;});
 await transport({payload,key:'test-key'});assert.deepEqual(posted,payload.body);
 let calls=0;const send=await server(t,{requestProvider:async({payload,key})=>{calls++;assert.equal(key,'synthetic-server-key');assert.equal(payload.referenceCount,0);assert.equal(payload.contentType,'application/json');assert.equal(JSON.parse(payload.body.toString()).output_format,'png');return imageReply();}});
 const res=await send(imageInput());assert.equal(res.status,200);const text=await res.text();assert.equal(JSON.parse(text).referenceCount,0);assert.equal(text.includes('synthetic-server-key'),false);assert.equal(calls,1);
 const invalid=await send({...imageInput(),prompt:'가'.repeat(28000),background:'나'.repeat(8000)});assert.equal(invalid.status,400);assert.equal((await invalid.json()).code,'IMAGE_PROMPT_TOO_LARGE');assert.equal(calls,1);
});

test('whole-video planning route uses the selected text model, full story and all slots without generating images or requiring web search',async()=>{
 const calls=[];const input=planInput();const api=client(async(url,options)=>{calls.push({url,options});return json(planReply(input));});api.setDirectSettings({scriptModel:'gpt-5-mini'});
 assert.equal(handlesDirectPath('/api/image/plan'),true);const res=await api.directApiFetch('/api/image/plan',post(input));assert.equal(res.status,200);const result=await res.json();assert.equal(result.model,'gpt-5-mini');assert.equal(result.shots.length,2);assert.deepEqual(result.shots.map(s=>s.sceneId),input.items.map(s=>s.sceneId));assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.openai.com/v1/responses');
 const payload=JSON.parse(calls[0].options.body);assert.equal(payload.model,'gpt-5-mini');assert.equal(payload.store,false);assert.equal(payload.tools,undefined);assert.equal(payload.text.format.strict,true);assert.deepEqual(JSON.parse(payload.input[0].content[0].text),input);assert.match(payload.instructions,/문장이 시간 구간 사이에서 잘릴/u);assert.match(payload.instructions,/미래 전투 장면으로 대체하지/u);assert.equal(JSON.stringify(result).includes(key),false);
});

test('planning failures and malformed inputs do not start an image request or an automatic paid retry',async()=>{
 let calls=0;const api=client(async()=>{calls++;const value=planReply();value.output[0].content[0].text=JSON.stringify({globalConcept:'공통 스타일',shots:[{sceneId:'wrong-id',prompt:'잘못된 장면'}]});return json(value);});
 const invalid=await api.directApiFetch('/api/image/plan',post({...planInput(),endpoint:'https://other.example'}));assert.equal(invalid.status,400);assert.equal(calls,0);
 const malformed=await api.directApiFetch('/api/image/plan',post(planInput()));assert.equal(malformed.status,502);assert.equal((await malformed.json()).code,'INVALID_STORYBOARD_OUTPUT');assert.equal(calls,1);
});

test('planning shares the one-active-AI slot and cancellation releases it without generating images',async()=>{
 let announce,release,calls=0;const seen=new Promise(resolve=>{announce=resolve;});const hold=new Promise(resolve=>{release=resolve;});
 const api=client(async(url)=>{calls++;if(url.endsWith('/responses')){announce();await hold;return json(planReply());}return json(imageReply());});
 const controller=new AbortController();const pending=api.directApiFetch('/api/image/plan',{...post(planInput()),signal:controller.signal});await seen;
 const blocked=await api.directApiFetch('/api/image/generate',post(imageInput()));assert.equal(blocked.status,429);assert.equal(calls,1);controller.abort();await assert.rejects(pending,{name:'AbortError'});release();
 const next=await api.directApiFetch('/api/image/generate',post(imageInput()));assert.equal(next.status,200);assert.equal(calls,2);
});
