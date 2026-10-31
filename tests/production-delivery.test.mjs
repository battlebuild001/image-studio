import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createProject,createScene,validateProject,getTimeline} from '../dist/project.js';
import {captureChannelPreset,applyChannelPreset,normalizeChannelPreset,renderChannelTitleCard} from '../dist/production-channels.js';
import {validateShortSegments,parseShortSegments,extractShortScenes,extractShortCaptions,cutNarrationSamples,buildShortsVariant} from '../dist/production-shorts.js';
import {parsePublishingChapters,manualPublishingDraft,publishingText,renderPublishingThumbnail} from '../dist/production-publishing.js';
import {createDeliveryZip,crc32,deliverySourceKey} from '../dist/production-delivery-utils.js';

const imageBytes=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url));
const image={blob:new Blob([imageBytes],{type:'image/png'}),type:'image/png',name:'합성 이미지.png'};
function source(){return createProject({title:'우주 이주 이야기',scenes:[createScene({imageId:'image-one',duration:10,caption:'첫 번째 원본 문장입니다.',motion:'none'}),createScene({imageId:'image-two',duration:20,caption:'두 번째 원본의 설명입니다.',motion:'none'}),createScene({imageId:'image-three',duration:10,caption:'세 번째 원본의 마무리입니다.',motion:'none'})],production:{version:1,speech:{pronunciations:[{term:'ABOL',reading:'아볼'}]}}});}
const channel={name:'사용자가 정한 이름',tone:'차분하고 구체적으로 설명해 주세요.',intro:{enabled:true,title:'이주의 시작',subtitle:'원본의 흐름을 살펴봅니다.',duration:3},outro:{enabled:true,title:'다음 이야기',subtitle:'',duration:2}};

test('channel profiles capture only allowlisted style and dictionary and never overwrite project text or media',()=>{
  const project=source();project.settings.aiImageNotice=true;project.settings.aiImageNoticePosition='bottom-right';project.imageStudio.style='차분한 청록색';
  const preset=captureChannelPreset(project,'설명 채널',channel);const other=createProject({title:'유지할 제목',scenes:[createScene({imageId:'existing-image',caption:'유지할 문장'})]});other.imageStudio.references=[{assetId:'kept-reference',label:'기준',role:'concept',enabled:true}];const oldScene=structuredClone(other.scenes),oldRefs=structuredClone(other.imageStudio.references);
  applyChannelPreset(other,preset);const canonical=validateProject(other);
  assert.equal(canonical.title,'유지할 제목');assert.deepEqual(canonical.scenes,oldScene);assert.deepEqual(canonical.imageStudio.references,oldRefs);assert.equal(canonical.settings.aiImageNoticePosition,'bottom-right');assert.equal(canonical.imageStudio.style,'차분한 청록색');assert.deepEqual(canonical.production.speech.pronunciations,[{term:'ABOL',reading:'아볼'}]);assert.equal(canonical.production.channel.name,channel.name);
  assert.throws(()=>normalizeChannelPreset({...preset,apiKey:'not-an-allowed-field'}));assert.throws(()=>normalizeChannelPreset({...preset,settings:{...preset.settings,accessToken:'forbidden'}}));assert.throws(()=>normalizeChannelPreset({...preset,pronunciations:[{term:'ABOL',reading:'아볼',credential:'forbidden'}]}));
  assert.throws(()=>normalizeChannelPreset({...preset,channel:{...preset.channel,tone:'sk-synthetic-credential-value-not-for-presets'}}));
});

test('short segment parsing rejects overlapping, out-of-range, too-short and over-budget spans',()=>{
  assert.deepEqual(parseShortSegments('5 → 15 | 도입\n30 -> 40 | 결말',{durationSeconds:40,targetSeconds:30}),[{start:5,end:15,label:'도입'},{start:30,end:40,label:'결말'}]);
  for(const segments of [[{start:0,end:20},{start:19,end:21}],[{start:0,end:41}],[{start:0,end:.1}],[{start:0,end:31}]])assert.throws(()=>validateShortSegments(segments,{durationSeconds:40,targetSeconds:30}));
  assert.throws(()=>parseShortSegments('어제부터 오늘까지',{durationSeconds:40,targetSeconds:30}));
});

test('shorts preserve chosen source order, exact duration and timed original captions without mutating the original',async()=>{
  const project=source();project.production.budget={enabled:true,currency:'USD',limit:10,exchangeRate:1400,rates:{textPerMillion:2},spentUsd:3,ledger:[]};project.scenes[0].caption='ABOL에 가는 1991년 이야기입니다.';project.scriptDraft={sourceText:'',instructions:'',targetMinutes:1,charsPerMinute:330,draftScript:'원본 음성',displayScript:'원본 표기',narrationStyle:'korean-digits',result:null};const before=structuredClone(project),segments=[{start:5,end:15,label:'발췌1'},{start:30,end:40,label:'발췌2'}],assets=new Map([['image-one',image],['image-two',image],['image-three',image]]);
  const scenes=extractShortScenes(project,segments);assert.equal(scenes.reduce((sum,scene)=>sum+scene.duration,0),20);assert.deepEqual(scenes.map(scene=>scene.imageId),['image-one','image-two','image-three']);assert.ok(scenes.every(scene=>!project.scenes.some(old=>old.id===scene.id)));
  const captions=extractShortCaptions(project,segments);assert.ok(captions.every(cue=>cue.start>=0&&cue.end<=20&&cue.end>cue.start));assert.ok(captions.some(cue=>cue.text.includes('마무리')));
  const result=await buildShortsVariant(project,assets,{title:'짧은 이주 이야기',segments},{targetSeconds:30});assert.equal(result.project.aspect,'9:16');assert.equal(getTimeline(result.project).duration,20);assert.equal(result.project.audio.narrationId,null);assert.equal(result.project.captionMode,'srt');assert.equal(result.hasNarration,false);assert.equal(result.assets.size,3);assert.notEqual(result.project.id,project.id);assert.equal(result.project.production.budget.spentUsd,0);assert.equal(result.project.production.budget.limit,10);assert.deepEqual(result.project.production.budget.ledger,[]);assert.ok(result.project.scriptDraft.displayScript.includes('1991'));assert.ok(result.project.scriptDraft.draftScript.includes('일구구일'));assert.ok(result.project.scriptDraft.draftScript.includes('아볼'));assert.deepEqual(project,before);
  await assert.rejects(buildShortsVariant(project,new Map(),{segments},{targetSeconds:30}),/이미지/);
});

test('tiny cut-edge scenes keep the entire selected time while avoiding invalid sub-quarter-second scenes',()=>{
  const project=source(),scenes=extractShortScenes(project,[{start:9.9,end:10.9}]);assert.equal(scenes.length,1);assert.ok(Math.abs(scenes[0].duration-1)<1e-8);assert.ok(scenes[0].caption.includes('첫 번째'));assert.ok(scenes[0].caption.includes('두 번째'));
});

test('real PCM cutting honors narration trim, timeline offset and independent source windows',()=>{
  const rate=8000,samples=new Float32Array(rate*4);for(let index=0;index<samples.length;index++)samples[index]=index<rate? .1:index<rate*2?.2:index<rate*3?.3:.4;
  const buffer={sampleRate:rate,duration:4,numberOfChannels:1,getChannelData:()=>samples};
  const selected=cutNarrationSamples(buffer,[{start:0,end:1},{start:2,end:3}],{narrationStart:1,narrationEnd:3,narrationOffset:.5},rate);assert.equal(selected.length,rate*2);assert.equal(selected[0],0);assert.ok(Math.abs(selected[rate*.75]-.2)<1e-6);assert.ok(Math.abs(selected[rate+rate*.25]-.3)<1e-6);assert.equal(selected[rate+rate*.75],0);
  const stereo={...buffer,numberOfChannels:2,getChannelData:index=>new Float32Array(rate*4).fill(index?.6:.2)};const average=cutNarrationSamples(stereo,[{start:1,end:2}],{},rate);assert.ok(Math.abs(average[100]-.4)<1e-6);assert.throws(()=>cutNarrationSamples(buffer,[{start:0,end:1}],{},Infinity));
});

test('manual publishing metadata derives real source times and remains clearly a non-AI draft',()=>{
  const project=source(),draft=manualPublishingDraft(project);assert.equal(draft.model,'manual-editor');assert.deepEqual(draft.chapters.map(item=>item.start),[0,10,30]);assert.deepEqual(draft.thumbnailConcepts.map(item=>item.sceneId),project.scenes.map(scene=>scene.id));assert.ok(publishingText(draft).includes('00:10'));assert.ok(draft.notes[0].includes('AI 작성'));
  assert.deepEqual(parsePublishingChapters('00:00 도입\n00:10 본론\n00:30 마무리',40).map(item=>item.start),[0,10,30]);assert.throws(()=>parsePublishingChapters('00:50 범위 초과',40));assert.throws(()=>parsePublishingChapters('00:10 두 번\n00:10 중복',40));const short=source();short.scenes=[createScene({imageId:'image-one',duration:4,caption:'짧은 영상'})];assert.deepEqual(manualPublishingDraft(short).chapters,[]);
});

function traceCanvas(width=1280,height=720){const calls=[],ctx={canvas:null,fillStyle:'',strokeStyle:'',globalAlpha:1,lineWidth:1,font:'20px sans-serif',textAlign:'left',createLinearGradient:()=>({addColorStop(){}}),fillRect(...args){calls.push(['rect',...args]);},strokeRect(){},drawImage(...args){calls.push(['image',...args]);},measureText(value){const size=Number(/([\d.]+)px/u.exec(this.font)?.[1]||20);return{width:Array.from(value).length*size*.7};},fillText(text,x,y){calls.push(['text',text,x,y]);},strokeText(){}};const canvas={width,height,getContext:()=>ctx};ctx.canvas=canvas;return{canvas,calls};}
test('thumbnail and channel titlecard render actual scene pixels and user text without a fixed channel mark',async()=>{
  const project=source(),canvas=traceCanvas(),assets=new Map([['image-one',{...image,image:{width:1600,height:900}}]]);await renderPublishingThumbnail(project,assets,{sceneId:project.scenes[0].id,headline:'우주 이주의 시작'},{canvas:canvas.canvas});assert.equal(canvas.calls.filter(call=>call[0]==='image').length,1);assert.ok(canvas.calls.some(call=>call[0]==='text'&&call[1].includes('우주')));assert.equal(canvas.calls.some(call=>/BTH|BATTLE TABLE HOBBY/iu.test(String(call[1]))),false);
  const title=traceCanvas();renderChannelTitleCard(title.canvas,{title:'내가 정한 제목',subtitle:'내가 정한 보조 문구',channelName:'직접 입력한 채널'});const words=title.calls.filter(call=>call[0]==='text').map(call=>call[1]);assert.ok(words.includes('직접 입력한 채널'));assert.ok(words.includes('내가 정한 제목'));assert.equal(words.some(word=>/BTH|BATTLE TABLE HOBBY/iu.test(word)),false);
});

test('UTF-8 delivery ZIP contains exact local file bytes, valid CRCs and no path traversal',async()=>{
  const contents=[{name:'게시자료.txt',data:'한국어 제목\n설명입니다.'},{name:'썸네일.png',data:new Uint8Array(imageBytes)}],blob=await createDeliveryZip(contents),bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer);let offset=0;const entries=[];
  while(view.getUint32(offset,true)===0x04034b50){assert.equal(view.getUint16(offset+6,true),0x0800);const length=view.getUint32(offset+18,true),nameLength=view.getUint16(offset+26,true),name=new TextDecoder().decode(bytes.slice(offset+30,offset+30+nameLength)),data=bytes.slice(offset+30+nameLength,offset+30+nameLength+length);assert.equal(crc32(data),view.getUint32(offset+14,true));entries.push({name,data});offset+=30+nameLength+length;}
  assert.deepEqual(entries.map(item=>item.name),contents.map(item=>item.name));assert.equal(new TextDecoder().decode(entries[0].data),contents[0].data);assert.deepEqual(entries[1].data,new Uint8Array(imageBytes));assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);assert.equal(view.getUint16(bytes.length-12,true),2);await assert.rejects(createDeliveryZip([{name:'../secret',data:'no'}]));await assert.rejects(createDeliveryZip([{name:'duplicate',data:'one'},{name:'duplicate',data:'two'}]));
});

test('delivery source guards ignore budget/version bookkeeping but notice genuine scene or speech changes',()=>{
  const project=source(),key=deliverySourceKey(project);project.production.budget={spentUsd:3};project.production.versions=[];assert.equal(deliverySourceKey(project),key);project.scenes[0].caption+=' 바뀐 내용';assert.notEqual(deliverySourceKey(project),key);
});
