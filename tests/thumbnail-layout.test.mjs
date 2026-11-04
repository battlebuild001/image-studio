import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createProject,createScene,validateProject,exportProjectBackup,importProjectBackup} from '../dist/project.js';
import {manualPublishingDraft,renderPublishingThumbnail} from '../dist/production-publishing.js';
import {renderThumbnailFrame} from '../dist/production-delivery-utils.js';

const bytes=await readFile(new URL('./fixtures/image-test-1.png',import.meta.url));
const sourceImage={width:1600,height:900,fixture:'actual supplied scene'};
const media=new Map([['thumbnail-image',{blob:new Blob([bytes],{type:'image/png'}),type:'image/png',name:'원본 장면.png',image:sourceImage}]]);
function source(){const project=createProject({id:'thumbnail-layout-source',title:'원본 영상 제목',scenes:[createScene({id:'thumbnail-scene-one',imageId:'thumbnail-image',duration:12,caption:'원본 사건을 따라가는 첫 번째 이야기입니다.',motion:'none'}),createScene({id:'thumbnail-scene-two',imageId:'thumbnail-image',duration:12,caption:'원본 사건을 따라가는 두 번째 이야기입니다.',motion:'none'}),createScene({id:'thumbnail-scene-three',imageId:'thumbnail-image',duration:12,caption:'원본 사건을 따라가는 세 번째 이야기입니다.',motion:'none'})],production:{version:1}});project.production.publishing={result:manualPublishingDraft(project),selectedTitle:0};return project;}
const style=(index=0,extra={})=>({index,title:'독립된 썸네일 문구',layout:'overlay',titlePosition:'center',...extra});
function withStyles(items){const project=source();project.production.publishing.thumbnail={version:1,items};return project;}

function traceCanvas(width=1280,height=720){
 const calls=[],stack=[],keys=['font','fillStyle','strokeStyle','textAlign','textBaseline','shadowBlur','lineWidth','lineJoin'];
 const gradient=()=>({addColorStop(){}}),ctx={canvas:null,font:'20px sans-serif',fillStyle:'',strokeStyle:'',textAlign:'left',textBaseline:'alphabetic',shadowBlur:0,lineWidth:1,
  save(){stack.push(Object.fromEntries(keys.map(key=>[key,this[key]])));},restore(){Object.assign(this,stack.pop());},
  createLinearGradient:gradient,fillRect(x,y,w,h){calls.push({type:'rectangle',x,y,w,h,color:this.fillStyle});},
  drawImage(image,...args){calls.push({type:'image',image,args});},
  measureText(value){const font=Number(/([\d.]+)px/u.exec(this.font)?.[1]||20);return{width:Array.from(String(value)).length*font*.7};},
  strokeText(){},fillText(text,x,y){const size=Number(/([\d.]+)px/u.exec(this.font)?.[1]||20),width=this.measureText(text).width;calls.push({type:'text',text,x,y,width,font:this.font,size,top:this.textBaseline==='middle'?y-size/2:y,bottom:this.textBaseline==='middle'?y+size/2:y+size});}};
 const canvas={width,height,getContext:()=>ctx};ctx.canvas=canvas;return{canvas,calls};
}
function headings(trace){return trace.calls.filter(call=>call.type==='text'&&call.font.startsWith('800 '));}
function titleExtent(trace){const text=headings(trace);assert.ok(text.length);return{top:Math.min(...text.map(call=>call.top)),bottom:Math.max(...text.map(call=>call.bottom)),center:text.reduce((sum,call)=>sum+call.y,0)/text.length};}

test('missing thumbnail metadata stays absent and preserves legacy title/description/concepts',()=>{
 const project=source(),before=structuredClone(project),canonical=validateProject(project);assert.equal(canonical.production.publishing.thumbnail,undefined);assert.deepEqual(canonical.production.publishing.result,before.production.publishing.result);assert.equal(canonical.title,before.title);assert.deepEqual(project,before);
});

test('three typed thumbnail edits remain independent from the project and publishing titles',()=>{
 const project=withStyles([style(0),style(1,{title:'',layout:'split',titlePosition:'bottom'}),style(2,{title:'세 번째 후보',layout:'band',titlePosition:'top'})]),before=structuredClone(project),canonical=validateProject(project);
 assert.deepEqual(canonical.production.publishing.thumbnail,project.production.publishing.thumbnail);assert.equal(canonical.title,'원본 영상 제목');assert.deepEqual(canonical.production.publishing.result.titles,before.production.publishing.result.titles);assert.deepEqual(canonical.production.publishing.result.thumbnailConcepts,before.production.publishing.result.thumbnailConcepts);assert.equal(canonical.production.publishing.thumbnail.items[1].title,'');assert.deepEqual(project,before);
});

test('thumbnail schema rejects unsupported fields, duplicate/out-of-range indices and malformed layout data',()=>{
 const bad=[{version:2,items:[style()]},{version:1,items:[style()],extra:true},{version:1,items:[style(0),style(0)]},{version:1,items:[style(3)]},{version:1,items:[style(-1)]},{version:1,items:[style(.5)]},{version:1,items:[style(0),style(1),style(2),style(0)]},{version:1,items:[{...style(),unexpected:'not allowed'}]},{version:1,items:[style(0,{layout:'external-template'})]},{version:1,items:[style(0,{titlePosition:'freeform'})]},{version:1,items:[style(0,{title:null})]},{version:1,items:[style(0,{title:27})]},{version:1,items:'not a list'}];
 for(const thumbnail of bad){const project=source();project.production.publishing.thumbnail=thumbnail;assert.throws(()=>validateProject(project),JSON.stringify(thumbnail));}
 const project=withStyles([style(2)]);project.production.publishing.result.thumbnailConcepts.pop();assert.throws(()=>validateProject(project),/썸네일/);
});

test('thumbnail text uses the 120-Unicode-point bound and cannot carry credentials or control characters',()=>{
 assert.equal(validateProject(withStyles([style(0,{title:'😀'.repeat(120)})])).production.publishing.thumbnail.items[0].title,'😀'.repeat(120));
 for(const title of ['한'.repeat(121),'😀'.repeat(121),'문구\u0001삽입','제목\u007f삽입','sk-proj-synthetic-secret-value-not-for-projects-12345'])assert.throws(()=>validateProject(withStyles([style(0,{title})])));
 assert.equal(validateProject(withStyles([style(0,{title:'문구\u0000정리'})])).production.publishing.thumbnail.items[0].title,'문구정리');
 const secret=withStyles([style()]);secret.production.publishing.thumbnail.items[0].apiKey='forbidden';assert.throws(()=>validateProject(secret));
});

test('portable project backup retains exact source image bytes and thumbnail edits without modifying published text',async()=>{
 const project=withStyles([style(0,{title:'아래에 놓는 독립 문구',layout:'split',titlePosition:'bottom'}),style(2,{title:'',layout:'band',titlePosition:'top'})]),restored=await importProjectBackup(await exportProjectBackup(project,media));
 assert.deepEqual(restored.project.production.publishing.thumbnail,project.production.publishing.thumbnail);assert.deepEqual(restored.project.production.publishing.result,project.production.publishing.result);assert.equal(restored.project.title,project.title);assert.deepEqual(new Uint8Array(await restored.assets.get('thumbnail-image').blob.arrayBuffer()),new Uint8Array(bytes));
 const legacy=source(),old=await importProjectBackup(await exportProjectBackup(legacy,media));assert.equal(old.project.production.publishing.thumbnail,undefined);
});

test('thumbnail renderer uses actual scene pixels and the edited text without injecting a fixed channel name',async()=>{
 const project=source(),concept=project.production.publishing.result.thumbnailConcepts[0];
 for(const layout of ['overlay','split','band']){const trace=traceCanvas();await renderPublishingThumbnail(project,media,concept,{canvas:trace.canvas,thumbnail:style(0,{title:'내가 고친 문구',layout,titlePosition:'bottom'})});assert.ok(trace.calls.some(call=>call.type==='image'&&call.image===sourceImage));assert.equal(headings(trace).map(call=>call.text).join(''),'내가 고친 문구');assert.equal(trace.calls.some(call=>call.type==='text'&&/BATTLE TABLE HOBBY|\bBTH\b/iu.test(call.text)),false);}
 const blank=traceCanvas();await renderPublishingThumbnail(project,media,concept,{canvas:blank.canvas,thumbnail:style(0,{title:''})});assert.equal(headings(blank).length,0);
});

test('top, center and bottom choices move real Canvas text for every layout',()=>{
 for(const layout of ['overlay','split','band']){const positions=[];for(const titlePosition of ['top','center','bottom']){const trace=traceCanvas();renderThumbnailFrame(trace.canvas,sourceImage,{headline:'중요한 이야기',layout,titlePosition,legacy:false});positions.push(titleExtent(trace).center);}
  assert.ok(positions[0]<positions[1]&&positions[1]<positions[2],JSON.stringify({layout,positions}));assert.ok(positions[0]<720*.38&&positions[2]>720*.65,JSON.stringify({layout,positions}));}
});

test('120-character bottom titles stay within the frame and clear the optional chosen channel in every layout',()=>{
 const headline='원본사건과설정을지키며미래의이야기를자세히설명합니다'.repeat(5).slice(0,120),channelName='직접 정한 채널';
 for(const [width,height]of [[1280,720],[640,360],[320,180]])for(const layout of ['overlay','split','band']){
  const trace=traceCanvas(width,height);renderThumbnailFrame(trace.canvas,sourceImage,{headline,channelName,layout,titlePosition:'bottom',legacy:false});const channel=trace.calls.find(call=>call.type==='text'&&call.font.startsWith('600 '));assert.ok(channel);const heading=titleExtent(trace);assert.ok(channel.bottom<heading.top,JSON.stringify({width,layout,channel,heading}));
  for(const call of trace.calls.filter(item=>item.type==='text')){assert.ok(call.x>=0&&call.x+call.width<=width+.01,JSON.stringify({width,layout,call}));assert.ok(call.top>=0&&call.bottom<=height+.01,JSON.stringify({height,layout,call}));}
 }
});

test('many explicit line breaks are bounded instead of pushing edited title text outside the frame',()=>{
 for(const layout of ['overlay','split','band']){const trace=traceCanvas();renderThumbnailFrame(trace.canvas,sourceImage,{headline:'한\n'.repeat(60),layout,titlePosition:'bottom',legacy:false});assert.ok(headings(trace).length);for(const call of headings(trace))assert.ok(call.top>=0&&call.bottom<=720,JSON.stringify({layout,call}));}
});
