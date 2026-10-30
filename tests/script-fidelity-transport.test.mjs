import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {once} from 'node:events';
import {createDirectOpenAi} from '../dist/direct-openai.js';
import {createScriptApi} from '../scripts/script-api.mjs';

// Synthetic setting facts, not the user's uploaded material or a live provider.
const input={sourceText:'2180 Observatory Lumen detects an unclassified signal. 2182 The council orders a survey, but the survey team does not report back. 2185 Port Ceres opens its first civilian landing zone.',instructions:'연표 순서를 지키고 조사대의 생사를 단정하지 마세요.',targetMinutes:16,charsPerMinute:330,projectTitle:'합성 연표',sourceFidelity:'faithful',detailLevel:'expanded',narrationStyle:'standard'};
const spoken='이천백팔십년, 루멘 관측소는 정체를 분류하지 못한 신호를 포착했습니다.\n\n이년 뒤 의회는 조사 명령을 내립니다. 조사대의 보고가 돌아오지 않은 채, 이천백팔십오년 포트 세레스에 첫 민간 착륙 구역이 문을 엽니다.';
const completed=()=>({status:'completed',output:[{type:'web_search_call',status:'completed',action:{sources:[{title:'Synthetic chronology reference',url:'https://example.org/synthetic-chronology'}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify({title:'조사와 개척',summary:'별도 조사 요약',script:spoken,notes:[]})}]}]});
function checkRequest(payload){
 const production=JSON.parse(payload.input[0].content[0].text);
 assert.equal(production.sourceFidelity,'faithful');assert.equal(production.detailLevel,'expanded');
 assert.equal(production.referenceMaterial,input.sourceText);assert.equal(production.productionInstructions,input.instructions);
 assert.equal(production.targetMinutes,16);assert.equal(production.targetCharacters,5280);
 assert.equal(payload.tools[0].type,'web_search');assert.equal(payload.tool_choice,'required');
}
function checkResult(result){
 assert.equal(result.script,spoken);assert.equal(result.sourceFidelity,'faithful');assert.equal(result.detailLevel,'expanded');assert.equal(result.targetMinutes,16);
 assert.equal(result.sources[0].url,'https://example.org/synthetic-chronology');assert.equal(result.webSearchUsed,true);
}

test('direct browser transport carries full source, fidelity and detail settings into the provider request without a hidden duration multiplier',async()=>{
 let calls=0;
 const client=createDirectOpenAi({sessionStorage:null,dispatchChange(){},fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/responses');checkRequest(JSON.parse(options.body));return new Response(JSON.stringify(completed()),{status:200,headers:{'Content-Type':'application/json'}});}});
 client.setDirectSettings({apiKey:'sk-synthetic-fidelity-test-key-not-real'});
 const response=await client.directApiFetch('/api/script/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 assert.equal(response.status,200);checkResult(await response.json());assert.equal(calls,1);
});

test('optional Node API carries the same explicit settings and result metadata without replacing source evidence',async t=>{
 let calls=0;
 const handle=createScriptApi({env:{SCRIPT_AI_API_KEY:'synthetic-not-real-server-key'},requestProvider:async({payload})=>{calls++;checkRequest(payload);return completed();}});
 const server=http.createServer((request,response)=>{handle(request,response,new URL(request.url,'http://localhost').pathname).then(handled=>{if(!handled)response.writeHead(404).end();}).catch(()=>response.writeHead(500).end());});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/script/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 assert.equal(response.status,200);checkResult(await response.json());assert.equal(calls,1);
});
