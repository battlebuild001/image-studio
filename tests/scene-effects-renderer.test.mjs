import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProject,createScene} from '../dist/project.js';
import {renderFrame,getSceneAt} from '../dist/engine.js';
import {drawSceneEffect} from '../dist/scene-effects.js';

function context(width=1280,height=720,id='main') {
  const operations=[],stack=[];
  const ctx={canvas:{width,height,id},globalAlpha:1,globalCompositeOperation:'source-over',fillStyle:'#000',
    operations,reset(){operations.length=0;},
    save(){stack.push({globalAlpha:this.globalAlpha,globalCompositeOperation:this.globalCompositeOperation,fillStyle:this.fillStyle});operations.push(['save']);},
    restore(){Object.assign(this,stack.pop());operations.push(['restore']);},
    setTransform(...args){operations.push(['transform',...args]);},clearRect(...args){operations.push(['clear',...args]);},
    beginPath(){operations.push(['begin']);},rect(...args){operations.push(['rect',...args]);},clip(){operations.push(['clip']);},
    moveTo(...args){operations.push(['moveTo',...args]);},lineTo(...args){operations.push(['lineTo',...args]);},stroke(){operations.push(['stroke']);},arcTo(...args){operations.push(['arcTo',...args]);},closePath(){operations.push(['close']);},
    arc(...args){operations.push(['arc',...args]);},
    fill(){operations.push(['fill',this.globalAlpha,this.globalCompositeOperation,this.fillStyle]);},
    fillRect(...args){operations.push(['fillRect',...args,this.globalAlpha,this.globalCompositeOperation,this.fillStyle]);},
    drawImage(image,...args){operations.push(['image',image.id||'image',...args,this.globalAlpha]);},
    fillText(text,...args){operations.push(['text',text,...args]);},measureText(text){return{width:Array.from(text).length*20};},
    createLinearGradient(...args){return gradient('linear',args);},createRadialGradient(...args){return gradient('radial',args);},
  };
  function gradient(type,args){const value={type,args,stops:[],addColorStop(...stop){this.stops.push(stop);}};operations.push(['gradient',type,...args]);return value;}
  return ctx;
}
function fixture(overrides={},image={id:'source',width:1280,height:720}) {
  const scene=createScene({id:'stable-scene',imageId:'source',duration:10,motion:'none',...overrides});
  return{project:createProject({scenes:[scene],settings:{branding:false,subtitles:false,transition:0}}),assets:new Map([['source',{image}]]),scene};
}
function frame(project,assets,time=0){const ctx=context();renderFrame(ctx,project,assets,time);return ctx;}
const imageDraw=ctx=>ctx.operations.find(row=>row[0]==='image');
const cloneTrace=ctx=>structuredClone(ctx.operations.map(row=>row.map(item=>item&&typeof item==='object'&&item.type?{type:item.type,args:item.args,stops:item.stops}:item)));

test('new gentle camera presets stay below 2.5 percent zoom and bound drift even for extreme image crops',()=>{
  for(const fit of ['cover','contain']){
    const {project,assets}=fixture({motion:'subtle-zoom',fit});
    const first=imageDraw(frame(project,assets,0)),last=imageDraw(frame(project,assets,10));
    assert.ok(Math.abs(last[4]-first[4])<=1280*.025+.001);
    assert.ok(Math.abs(last[5]-first[5])<=720*.025+.001);
    if(fit==='contain'){assert.ok(first[4]<=1280&&last[4]<=1280);assert.ok(first[5]<=720&&last[5]<=720);}
  }
  for(const image of [{id:'wide',width:9000,height:720},{id:'tall',width:1280,height:9000},{id:'match',width:1280,height:720}])for(const fit of ['cover','contain']){
    const {project,assets}=fixture({motion:'subtle-drift',fit},image);
    const first=imageDraw(frame(project,assets,0)),last=imageDraw(frame(project,assets,10));
    assert.ok(Math.abs(last[2]-first[2])<=1280*.0125+.001);
    assert.ok(Math.abs(last[3]-first[3])<=720*.0025+.001);
    for(const draw of [first,last]){
      const [, ,x,y,w,h]=draw;
      if(fit==='cover'){assert.ok(x<=.001&&y<=.001);assert.ok(x+w>=1280-.001&&y+h>=720-.001);}
      else{assert.ok(x>=-.001&&y>=-.001);assert.ok(x+w<=1280+.001&&y+h<=720+.001);}
    }
  }
});

test('none, omitted effects and zero intensity produce the exact original scene drawing',()=>{
  const {project,assets}=fixture();const base=cloneTrace(frame(project,assets,2));
  project.scenes[0].effect='none';project.scenes[0].effectIntensity=.9;
  assert.deepEqual(cloneTrace(frame(project,assets,2)),base);
  for(const effect of ['dust','fog','light']){Object.assign(project.scenes[0],{effect,effectIntensity:0});assert.deepEqual(cloneTrace(frame(project,assets,2)),base,effect);}
});

test('animated overlays are deterministic when seeking and change smoothly with local scene time',()=>{
  for(const effect of ['dust','fog','light']){
    const {project,assets}=fixture({effect,effectIntensity:.7});
    const ctx=context();renderFrame(ctx,project,assets,2);const atTwo=cloneTrace(ctx);
    ctx.reset();renderFrame(ctx,project,assets,7);assert.notDeepEqual(cloneTrace(ctx),atTwo,effect+' moves');
    ctx.reset();renderFrame(ctx,project,assets,2);assert.deepEqual(cloneTrace(ctx),atTwo,effect+' returns to exact frame');
    assert.ok(ctx.operations.filter(row=>row[0]==='arc').length<=28);
    assert.ok(ctx.operations.filter(row=>row[0]==='gradient'&&row[1]==='radial').length<=3);
    assert.equal(ctx.globalAlpha,1);assert.equal(ctx.globalCompositeOperation,'source-over');
  }
});

test('effects are image-only and painted beneath narration and the user project title',()=>{
  const {project,assets}=fixture({effect:'light',effectIntensity:1,caption:'자막은 효과 위에 표시합니다.'});
  project.settings.branding=true;project.settings.subtitles=true;
  const trace=frame(project,assets,2).operations;
  const imageIndex=trace.findIndex(row=>row[0]==='image'),effectIndex=trace.findIndex(row=>row[0]==='gradient'&&row[1]==='radial');
  const brandingIndex=trace.findIndex(row=>row[0]==='text'&&row[1]===project.title),captionIndex=trace.findIndex(row=>row[0]==='text'&&row[1].includes('자막'));
  assert.ok(imageIndex>=0&&effectIndex>imageIndex&&brandingIndex>effectIndex&&captionIndex>effectIndex);
  const missing=frame(project,new Map(),2).operations;assert.equal(missing.some(row=>row[0]==='gradient'&&row[1]==='radial'),false);
});

test('in-place effect edits invalidate the shared render snapshot and keep intensity bounds without state leaks',()=>{
  const {project,assets}=fixture();assert.equal(getSceneAt(project,2).scene.effect??'none','none');
  project.scenes[0].effect='dust';project.scenes[0].effectIntensity=.9;
  assert.equal(getSceneAt(project,2).scene.effect,'dust');assert.equal(getSceneAt(project,2).scene.effectIntensity,.9);
  assert.equal(frame(project,assets,2).operations.filter(row=>row[0]==='arc').length,28);
  const ctx=context();ctx.globalAlpha=.4;ctx.globalCompositeOperation='multiply';
  drawSceneEffect(ctx,{id:'stable',effect:'dust',effectIntensity:100},2,1280,720);
  assert.ok(ctx.operations.filter(row=>row[0]==='fill').every(row=>row[1]<=.4*.3));
  assert.equal(ctx.globalAlpha,.4);assert.equal(ctx.globalCompositeOperation,'multiply');
});

test('crossfades composite a complete next image/effect layer at its own start while current effects use local time',t=>{
  const old=globalThis.OffscreenCanvas;const buffers=[];
  globalThis.OffscreenCanvas=class{constructor(width,height){this.width=width;this.height=height;this.id='transition';this.ctx=context(width,height,'transition');buffers.push(this.ctx);}getContext(){return this.ctx;}};
  t.after(()=>{globalThis.OffscreenCanvas=old;});
  const {project,assets}=fixture({effect:'dust',effectIntensity:.5,duration:4});
  project.scenes.push(createScene({id:'second',duration:4,imageId:'source',motion:'none',effect:'fog',effectIntensity:.5}));project.settings.transition=1;
  const ctx=frame(project,assets,3.5);assert.equal(buffers.length,1);
  const imageIndex=buffers[0].operations.findIndex(row=>row[0]==='image'),effectIndex=buffers[0].operations.findIndex(row=>row[0]==='gradient'&&row[1]==='radial');assert.ok(effectIndex>imageIndex);
  const nextComposite=ctx.operations.find(row=>row[0]==='image'&&row[1]==='transition');assert.ok(nextComposite);assert.equal(nextComposite.at(-1),.5);
  const expected=context();drawSceneEffect(expected,project.scenes[1],0,1280,720);
  assert.deepEqual(buffers[0].operations.filter(row=>row[0]==='gradient'&&row[1]==='radial'),expected.operations.filter(row=>row[0]==='gradient'&&row[1]==='radial'));
});
