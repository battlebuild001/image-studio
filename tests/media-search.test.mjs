import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeCommonsResponse,normalizeMediaCandidate,normalizeReferenceMediaState,normalizeMusicState,mediaAttributionText,mediaDownloadUrl,MAX_REFERENCE_MEDIA_BYTES,MAX_MUSIC_MEDIA_BYTES} from '../dist/media-search-protocol.js';
import {createMediaSearchClient,validateDownloadedMedia} from '../dist/media-search-client.js';
const imageUrl='https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic.png',audioUrl='https://upload.wikimedia.org/wikipedia/commons/c/cd/Synthetic.wav';
function page(kind='image',overrides={}){return{pageid:123,title:kind==='image'?'File:Synthetic.png':'File:Synthetic.wav',index:1,imageinfo:[{url:kind==='image'?imageUrl:audioUrl,mime:kind==='image'?'image/png':'audio/wav',size:500,width:kind==='image'?640:0,height:kind==='image'?480:0,duration:kind==='audio'?4:0,thumburl:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic.png/640px-Synthetic.png?utm_source=test',extmetadata:{ObjectName:{value:'자료 &amp; 실제 제목'},Artist:{value:'<a href="javascript:alert(1)">원작자</a>'},LicenseShortName:{value:'CC BY 4.0'},LicenseUrl:{value:'https://creativecommons.org/licenses/by/4.0/'},ImageDescription:{value:'<script>steal()</script><b>실제 자료 설명</b>'}},...overrides}]};}
const response=p=>({query:{pages:{[p.pageid]:p}}});
const candidate=(kind='image')=>normalizeCommonsResponse(response(page(kind)),{kind})[0];
test('real Commons imageinfo metadata becomes a source-linked candidate with safe text and no invented URLs',()=>{
 const result=candidate();assert.equal(result.id,'commons-123');assert.equal(result.title,'자료 & 실제 제목');assert.equal(result.artist,'원작자');assert.equal(result.description,'실제 자료 설명');assert.equal(result.sourceUrl,'https://commons.wikimedia.org/?curid=123');assert.equal(result.previewUrl.includes('utm_'),false);assert.equal(result.mediaUrl,imageUrl);assert.match(mediaAttributionText(result),/CC BY 4.0/);assert.equal(result.source,'wikimedia-commons');
 assert.deepEqual(normalizeCommonsResponse({batchcomplete:''}),[]);assert.throws(()=>normalizeCommonsResponse({error:{info:'raw private input'}}),/검색 요청/);
});
test('official thumbnail host and real audio application/ogg are supported while malformed/external media are rejected',()=>{
 const ogg=normalizeCommonsResponse(response(page('audio',{mime:'application/ogg',url:'https://upload.wikimedia.org/wikipedia/commons/a/ab/Music.ogg'})),{kind:'audio'});assert.equal(ogg[0].mimeType,'audio/ogg');assert.equal(ogg[0].duration,4);
 for(const bad of ['https://attacker.example/image.png','https://upload.wikimedia.org.attacker.example/image.png','https://user:secret@upload.wikimedia.org/wikipedia/commons/a.png','http://upload.wikimedia.org/wikipedia/commons/a.png','https://upload.wikimedia.org:444/wikipedia/commons/a.png','https://upload.wikimedia.org/other/image.png'])assert.throws(()=>mediaDownloadUrl(bad));
 assert.deepEqual(normalizeCommonsResponse(response(page('image',{url:'https://attacker.example/pixel'}))),[]);
 const big=normalizeCommonsResponse(response(page('image',{size:MAX_REFERENCE_MEDIA_BYTES+1})));assert.equal(big[0].mediaUrl,big[0].previewUrl);
 assert.deepEqual(normalizeCommonsResponse(response(page('audio',{size:MAX_MUSIC_MEDIA_BYTES+1})),{kind:'audio'}),[]);
});
test('portable selection/recommendations retain sources but reject unknown fields, wrong kinds and out-of-result IDs',()=>{
 const picture=candidate(),track=candidate('audio');const images=normalizeReferenceMediaState({query:'항해',results:[picture],selectedIds:[picture.id],imports:[picture]});assert.equal(images.withTopic,true);assert.deepEqual(images.imports,[picture]);assert.equal(normalizeMusicState({candidates:[track],selectedId:track.id,appliedCandidate:track}).appliedCandidate.sourceUrl,track.sourceUrl);
 for(const value of [{apiKey:'secret'},{results:[track]},{results:[picture],selectedIds:['commons-999']},{results:[picture,picture]},{imports:[picture,picture]},{withTopic:'yes'}])assert.throws(()=>normalizeReferenceMediaState(value));
 assert.throws(()=>normalizeMusicState({candidates:[picture]}));assert.throws(()=>normalizeMusicState({query:'x',recommendations:[{title:'음악',mood:'차분',style:'ambient',instruments:[],tempoBpm:500,searchQuery:'ambient',reason:'설명'}]}));
 const input={query:'q',results:[picture],selectedIds:[picture.id]};const before=structuredClone(input);normalizeReferenceMediaState(input);assert.deepEqual(input,before);
});
test('search uses the actual public Commons API query and omits credentials, redirects and supplied provider headers',async()=>{
 const calls=[];const client=createMediaSearchClient({fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(response(page()));}});
 const found=await client.search('우주선 참고',{kind:'image',limit:3});assert.equal(found.length,1);const url=new URL(calls[0].url);assert.equal(url.origin,'https://commons.wikimedia.org');assert.equal(url.pathname,'/w/api.php');assert.equal(url.searchParams.get('origin'),'*');assert.equal(url.searchParams.get('gsrsearch'),'우주선 참고 filetype:bitmap');assert.equal(url.searchParams.get('gsrlimit'),'3');assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');assert.deepEqual(Object.keys(calls[0].options.headers),['Accept']);
 await assert.rejects(client.search('  '));await assert.rejects(client.search('q',{kind:'video'}));assert.equal(calls.length,1);
});
test('chosen imports use real PNG/WAV bytes and declared MIME; rejected content never becomes a File',async()=>{
 const png=new Uint8Array(await readFile(new URL('./fixtures/image-test-1.png',import.meta.url))),wav=new Uint8Array(await readFile(new URL('./fixtures/bgm-test.wav',import.meta.url)));let body=png,mime='image/png',calls=0;
 const client=createMediaSearchClient({fetchImpl:async()=>{calls++;return new Response(body,{headers:{'content-type':mime}});}});
 const image=await client.download(candidate());assert.equal(image.type,'image/png');assert.equal(image.size,png.length);assert.deepEqual(new Uint8Array(await image.arrayBuffer()),png);
 body=wav;mime='audio/wav';const music=await client.download(candidate('audio'));assert.equal(music.type,'audio/wav');assert.equal(music.size,wav.length);
 body=new TextEncoder().encode('{"error":"not audio"}');await assert.rejects(client.download(candidate('audio')),/실제 파일 형식/);
 body=png;mime='text/html';await assert.rejects(client.download(candidate()),/다른 파일 형식/);assert.equal(calls,4);
 assert.equal(validateDownloadedMedia(new Uint8Array([79,103,103,83,...new Array(20).fill(0)]),'audio/ogg'),'audio/ogg');
});
test('download size checks and request cancellation stop data without a retry or a hidden import',async()=>{
 let calls=0;const large=createMediaSearchClient({fetchImpl:async()=>{calls++;return new Response('data',{headers:{'content-length':String(MAX_REFERENCE_MEDIA_BYTES+1)}});}});await assert.rejects(large.download(candidate()),/너무 커요/);assert.equal(calls,1);
 const wait=createMediaSearchClient({fetchImpl:()=>{calls++;return new Promise(()=>{});},timeoutMs:15});await assert.rejects(wait.search('query'),/응답이 늦어요/);assert.equal(calls,2);
 const abort=new AbortController();const pending=wait.search('another',{signal:abort.signal});abort.abort();await assert.rejects(pending,cause=>cause.name==='AbortError');assert.equal(calls,3);
});
test('a response body stalled after its headers is also timed out, canceled and never retried',async()=>{
 let calls=0;const client=createMediaSearchClient({timeoutMs:20,fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}),{headers:{'content-type':'application/json'}});}});
 await assert.rejects(client.search('ambient'),/응답이 늦어요/);assert.equal(calls,1);
});
