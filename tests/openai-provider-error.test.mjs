import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {classifyOpenAiProviderError,readOpenAiProviderError,sanitizeOpenAiDiagnostic,OPENAI_ERROR_BODY_LIMIT} from '../dist/openai-provider-error.js';

const secret='sk-synthetic-diagnostic-private-key';
const context={model:'gpt-image-2',size:'1536x864',referenceCount:2,prompt:'private prompt is never diagnostics'};
const errorResponse=(error,status=400,headers={})=>new Response(JSON.stringify({error}),{status,headers:{'Content-Type':'application/json',...headers}});

test('same provider 400/404 responses distinguish missing model, size, references and content refusal without exposing provider prose',async()=>{
  for(const[error,status,reason,word]of[
    [{code:'model_not_found'},404,'MODEL_NOT_FOUND','모델'],
    [{code:'invalid_value',param:'size'},400,'IMAGE_SIZE_UNSUPPORTED','크기'],
    [{code:'invalid_value',param:'quality'},400,'IMAGE_QUALITY_UNSUPPORTED','품질'],
    [{code:'invalid_image_size',param:'size'},400,'IMAGE_SIZE_UNSUPPORTED','크기'],
    [{code:'invalid_image_size',param:'quality'},400,'IMAGE_QUALITY_UNSUPPORTED','품질'],
    [{code:'invalid_image_size',param:'image[0]'},400,'IMAGE_REFERENCE_INVALID','참고 이미지'],
    [{code:'invalid_image_format',param:'image[0]'},400,'IMAGE_REFERENCE_INVALID','참고 이미지'],
    [{code:'content_policy_violation'},400,'CONTENT_POLICY','안전 정책'],
    [{code:'unsupported_parameter',param:'output_format'},400,'REQUEST_INVALID','설정'],
    [{code:'organization_verification_required'},403,'ORGANIZATION_VERIFICATION_REQUIRED','조직 인증'],
    [{code:'insufficient_quota'},429,'INSUFFICIENT_QUOTA','결제'],
    [{code:'rate_limit_exceeded'},429,'RATE_LIMITED','요청 한도']
  ]){
    const result=await readOpenAiProviderError(errorResponse({...error,message:`private provider ${secret}`},status,{'x-request-id':'req_image_request_123'}),{context,secrets:[secret]});
    assert.equal(result.reason,reason);assert.ok(result.message.includes(word));assert.equal(result.diagnostic.providerStatus,status);assert.equal(result.diagnostic.providerCode,error.code);assert.equal(result.diagnostic.requestId,'req_image_request_123');assert.equal(result.diagnostic.model,context.model);assert.equal(result.diagnostic.size,context.size);assert.equal(result.diagnostic.referenceCount,2);
    assert.equal(JSON.stringify(result).includes(secret),false);assert.equal(JSON.stringify(result).includes('private'),false);
  }
});

test('organization verification with the official null-code phrase produces fixed guidance without copying the message',async()=>{
  const value=await readOpenAiProviderError(errorResponse({code:null,message:`Your organization must be verified to use this model: private ${secret}`},403));
  assert.equal(value.reason,'ORGANIZATION_VERIFICATION_REQUIRED');assert.equal(value.diagnostic.providerCode,undefined);assert.equal(JSON.stringify(value).includes(secret),false);
});

test('diagnostics only accept known fields, tokens, request IDs and bounded safe request context',()=>{
  const value=sanitizeOpenAiDiagnostic({provider:'openai',providerStatus:400,providerCode:'invalid_value',parameter:'image[3]',requestId:'req_safe123',model:'gpt-image-2',size:'1536x864',referenceCount:5,
    apiKey:secret,prompt:'private',providerMessage:'private',url:'https://private.example',headers:{Authorization:secret}});
  assert.deepEqual(value,{provider:'openai',providerStatus:400,providerCode:'invalid_value',parameter:'image[]',requestId:'req_safe123',model:'gpt-image-2',size:'1536x864',referenceCount:5});
  const removed=sanitizeOpenAiDiagnostic({provider:'openai',providerStatus:404,providerCode:secret,parameter:'https://private.example',requestId:'req_'+secret,model:secret,size:secret,referenceCount:6},{secrets:[secret]});
  assert.deepEqual(removed,{provider:'openai',providerStatus:404});
  assert.equal(sanitizeOpenAiDiagnostic({provider:'evil',providerStatus:400}),null);assert.equal(sanitizeOpenAiDiagnostic({provider:'openai',providerStatus:200}),null);
  for(const requestId of['req_bad space','req_bad\nheader','https://private.example','req_'+('x'.repeat(129))])assert.equal(sanitizeOpenAiDiagnostic({provider:'openai',providerStatus:400,requestId}).requestId,undefined);
  assert.equal(sanitizeOpenAiDiagnostic({provider:'openai',providerStatus:400,requestId:'req_sensitivefragment'},{secrets:['sensitivefragment']}).requestId,undefined);
});

test('unknown and non-JSON error bodies retain sanitized generic guidance and real provider status',async()=>{
  for(const response of[errorResponse({code:secret,param:secret,type:secret,message:secret}),new Response(`<html>${secret}</html>`,{status:404}),new Response('null',{status:400})]){
    const value=await readOpenAiProviderError(response);assert.equal(value.reason,'CONFIGURATION_ERROR');assert.equal(JSON.stringify(value).includes(secret),false);assert.ok([400,404].includes(value.diagnostic.providerStatus));
  }
  for(const[status,reason]of[[401,'AUTH_FAILED'],[403,'ACCESS_DENIED'],[429,'RATE_LIMITED'],[503,'UNAVAILABLE']])assert.equal(classifyOpenAiProviderError({status}).reason,reason);
});

test('an oversized stream stops at the 16KiB boundary and never uses partial provider data',async()=>{
  let reads=0,cancelled=0;
  const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(OPENAI_ERROR_BODY_LIMIT+1));},cancel(){cancelled++;}});
  const result=await readOpenAiProviderError(new Response(body,{status:400}));
  assert.equal(result.reason,'CONFIGURATION_ERROR');assert.equal(result.diagnostic.providerCode,undefined);assert.ok(reads<=2);assert.equal(cancelled,1);
  let touched=0;const advertised=new Response(new ReadableStream({pull(){touched++;},cancel(){cancelled++;}}),{status:400,headers:{'Content-Length':String(OPENAI_ERROR_BODY_LIMIT+1)}});
  await readOpenAiProviderError(advertised);assert.ok(touched<=1);assert.equal(cancelled,2);
});

test('stalled error streams have a bounded deadline while caller cancellation is preserved',async()=>{
  let cancelled=0;const response=new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++;}}),{status:400});
  const before=Date.now(),value=await readOpenAiProviderError(response,{timeoutMs:15});assert.equal(value.reason,'CONFIGURATION_ERROR');assert.ok(Date.now()-before<500);assert.equal(cancelled,1);
  const controller=new AbortController(),pending=readOpenAiProviderError(new Response(new ReadableStream({pull(){return new Promise(()=>{});}}),{status:400}),{signal:controller.signal});controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');
  const already=new AbortController();already.abort();await assert.rejects(readOpenAiProviderError(errorResponse({code:'model_not_found'},404),{signal:already.signal}),error=>error.name==='AbortError');
});

test('the same bounded reader consumes real Node error-response streams and cancels huge bodies',async()=>{
  const body=Readable.from([Buffer.from('{"error":{"code":"invalid_value",'),Buffer.from('"param":"size","message":"private"}}')]);body.statusCode=400;body.headers={'x-request-id':'req_node_stream_123'};
  const value=await readOpenAiProviderError(body,{context});assert.equal(value.reason,'IMAGE_SIZE_UNSUPPORTED');assert.equal(value.diagnostic.requestId,'req_node_stream_123');assert.equal(value.diagnostic.providerStatus,400);assert.equal(JSON.stringify(value).includes('private'),false);
  const huge=Readable.from([Buffer.alloc(OPENAI_ERROR_BODY_LIMIT+1)]);huge.statusCode=400;huge.headers={};const result=await readOpenAiProviderError(huge);assert.equal(result.reason,'CONFIGURATION_ERROR');assert.equal(huge.destroyed,true);
});
