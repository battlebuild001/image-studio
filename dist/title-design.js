// Shared, local Canvas artwork for every intro/chapter/outro entry point.
// Only already-decoded project images are used; drawing never fetches a URL.
const FONT='"Noto Sans KR","Malgun Gothic",system-ui,sans-serif';
const TITLE_IMAGE=/(?:^(?:인트로|아웃트로|챕터)[-· ]|-(?:intro|outro|chapter)\.png$|^(?:intro|outro|chapter)[-_.])/iu;
export const TITLE_DESIGN_VERSION=2;
export const TITLE_ACCENT='#c8dfc7';
export function normalizeTitleOverline(value,kind='intro'){
 if(value===undefined)return kind==='outro'?'EPILOGUE':kind==='chapter'?'CHAPTER':'PROLOGUE';
 if(typeof value!=='string'||Array.from(value).length>80||/[\u0000-\u001f\u007f]/u.test(value))throw new Error('상단 작은 문구는 제어 문자 없이 80자까지 입력해 주세요.');
 return value.trim();
}

export function selectTitleBackdrop(api,kind='intro'){
 const project=api.getProject(),assets=api.getAssets?.();if(!assets?.get)return null;
 const ids=(project.scenes||[]).map(scene=>scene.imageId).filter(Boolean);
 if(kind==='outro')ids.reverse();
 for(const id of ids){const asset=assets.get(id);if(asset?.image&&!TITLE_IMAGE.test(asset.name||''))return asset.image;}
 for(const ref of project.imageStudio?.references||[]){const asset=assets.get(ref.assetId);if(asset?.image&&!TITLE_IMAGE.test(asset.name||''))return asset.image;}
 return null;
}
function cover(ctx,image,w,h){const iw=image.naturalWidth||image.videoWidth||image.width,ih=image.naturalHeight||image.videoHeight||image.height;if(!(iw>0&&ih>0))return false;const factor=Math.max(w/iw,h/ih),sw=w/factor,sh=h/factor;ctx.drawImage(image,(iw-sw)/2,(ih-sh)/2,sw,sh,0,0,w,h);return true;}
function wrap(ctx,text,width){const result=[];for(const paragraph of String(text).replace(/\r\n?/gu,'\n').split('\n')){if(!paragraph.trim()){result.push('');continue;}let line='';for(const word of paragraph.trim().split(/\s+/u)){if(ctx.measureText(line?`${line} ${word}`:word).width<=width){line=line?`${line} ${word}`:word;continue;}if(line){result.push(line);line='';}for(const character of word){if(line&&ctx.measureText(line+character).width>width){result.push(line);line=character;}else line+=character;}}if(line)result.push(line);}return result;}
function fit(ctx,text,{w,h,size,min=24,weight=750,leading=1.15}){let current=size,lines=[];for(;current>=min;current--){ctx.font=`${weight} ${current}px ${FONT}`;lines=wrap(ctx,text,w);if(lines.length*current*leading<=h)break;}current=Math.max(min,current);ctx.font=`${weight} ${current}px ${FONT}`;const maxLines=Math.max(1,Math.floor(h/(current*leading)));if(lines.length>maxLines){lines=lines.slice(0,maxLines);let last=lines.at(-1);while(last&&ctx.measureText(last+'…').width>w)last=last.slice(0,-1);lines[lines.length-1]=last+'…';}return{lines,size:current,font:ctx.font,lineHeight:current*leading,height:lines.length*current*leading};}
function drawText(ctx,block,x,y,color='#f6f4ef'){ctx.font=block.font;ctx.fillStyle=color;ctx.textAlign='left';ctx.textBaseline='top';block.lines.forEach((line,index)=>ctx.fillText(line,x,y+index*block.lineHeight));}
function smallText(ctx,text,x,y,width,size=18,color='#c4c5c2',weight=500){const block=fit(ctx,text,{w:width,h:size*2.7,size,min:Math.max(12,size-5),weight,leading:1.32});drawText(ctx,block,x,y,color);return block;}
function background(ctx,image,w,h,portrait,kind){
 ctx.fillStyle='#0b0c0e';ctx.fillRect(0,0,w,h);let hasImage=false;
 if(image){ctx.save();if(kind==='outro')ctx.filter='blur(3px) saturate(.7)';try{hasImage=cover(ctx,image,w,h);}catch{}ctx.restore();}
 if(!hasImage){const haze=ctx.createRadialGradient(w*.83,h*.27,0,w*.83,h*.27,w*.95);haze.addColorStop(0,'#788e7852');haze.addColorStop(.38,'#4a565327');haze.addColorStop(1,'#10111300');ctx.fillStyle=haze;ctx.fillRect(0,0,w,h);const warm=ctx.createRadialGradient(w*.98,h*.65,0,w*.98,h*.65,w*.64);warm.addColorStop(0,'#7c625128');warm.addColorStop(1,'#18161300');ctx.fillStyle=warm;ctx.fillRect(0,0,w,h);}
 // Broad directional scrims protect type on even a completely white source.
 const side=ctx.createLinearGradient(0,0,w,0);side.addColorStop(0,'#080a0cf5');side.addColorStop(portrait?.25:.38,'#080a0cdb');side.addColorStop(portrait?.85:.72,'#080a0c70');side.addColorStop(1,'#080a0c42');ctx.fillStyle=side;ctx.fillRect(0,0,w,h);
 const shade=ctx.createLinearGradient(0,0,0,h);shade.addColorStop(0,'#080a0c46');shade.addColorStop(.32,'#080a0c08');shade.addColorStop(portrait?.63:.72,'#080a0c9c');shade.addColorStop(1,'#080a0cfa');ctx.fillStyle=shade;ctx.fillRect(0,0,w,h);
 // A restrained deterministic film texture; no borders, grids or fake controls.
 ctx.save();ctx.fillStyle='#e4e5e0';ctx.globalAlpha=.035;let state=271828;for(let i=0;i<1600;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;const x=(state%10000)/10000*w;state=(Math.imul(state,1664525)+1013904223)>>>0;ctx.fillRect(x,(state%10000)/10000*h,.8,.8);}ctx.restore();
}

/** Draw a complete image scene. Leave the bottom 9% clear for the AI notice. */
export function renderTitleDesign(canvas,{kind='intro',title='',subtitle='',channelName='',color=TITLE_ACCENT,backgroundImage=null,logo=null,overline}={}){
 const width=canvas.width,height=canvas.height,ctx=canvas.getContext('2d');if(!ctx||width<320||height<240)throw new Error('제목 화면의 크기를 확인해 주세요.');if(!['intro','chapter','outro'].includes(kind))throw new Error('제목 화면의 종류를 확인해 주세요.');
 const portrait=height>width,w=portrait?720:1280,h=portrait?1280:720,safeX=portrait?64:82;
 const accent=/^#[a-f\d]{6}$/iu.test(color)?color:TITLE_ACCENT,label=normalizeTitleOverline(overline,kind);
 const main=String(title|| (kind==='outro'?'다음 이야기에서 만나요.':kind==='chapter'?'새로운 이야기':'이야기의 시작')).slice(0,600),sub=String(subtitle||'').slice(0,1200),channel=String(channelName||'').slice(0,240);
 ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,width,height);ctx.scale(width/w,height/h);background(ctx,backgroundImage,w,h,portrait,kind);
 let channelX=safeX;
 if(logo){const lw=logo.naturalWidth||logo.width,lh=logo.naturalHeight||logo.height;if(lw>0&&lh>0){const ratio=Math.min(90/lw,40/lh);ctx.save();ctx.drawImage(logo,safeX,portrait?72:48,lw*ratio,lh*ratio);ctx.restore();channelX+=lw*ratio+18;}}
 if(channel)smallText(ctx,channel,channelX,portrait?78:54,w-channelX-safeX,portrait?20:19,'#e4e5df',600);
 const availableW=portrait?w-safeX*2:w*.72;
 const titleArea=portrait?{w:availableW,h:kind==='chapter'?360:420,size:kind==='chapter'?66:76,min:26}:{w:availableW,h:kind==='chapter'?285:310,size:kind==='chapter'?86:94,min:26};
 const heading=fit(ctx,main,{...titleArea,leading:1.16,weight:750});
 const titleBottom=portrait?(kind==='outro'?894:877):(kind==='outro'?500:512);
 const titleY=Math.max(portrait?390:212,titleBottom-heading.height);
 // The overline identifies the beat rather than repeating a second headline.
 if(label){
  ctx.fillStyle=accent;ctx.fillRect(safeX,titleY-(portrait?52:42),portrait?32:28,2);
  const overlineBlock=fit(ctx,label,{w:w-safeX*2-(portrait?49:44),h:portrait?21:18,size:portrait?15:13,min:10,weight:600,leading:1.15});
  drawText(ctx,overlineBlock,safeX+(portrait?49:44),titleY-(portrait?58:48),accent);
 }
 drawText(ctx,heading,safeX,titleY);
 if(sub){const subBox=fit(ctx,sub,{w:portrait?availableW:Math.min(830,availableW),h:portrait?146:100,size:portrait?25:24,min:17,weight:400,leading:1.45});drawText(ctx,subBox,safeX,titleBottom+(portrait?38:32),'#d0d2cf');}
 const bottomY=portrait?1128:635;
 ctx.strokeStyle='#ffffff24';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(safeX,bottomY);ctx.lineTo(w-safeX,bottomY);ctx.stroke();
 ctx.fillStyle=accent;ctx.fillRect(safeX,bottomY,portrait?45:48,2);
 // A single quiet sign-off; the user's copy remains the focus of the frame.
 const signoff=kind==='outro'?'이야기는 계속됩니다':kind==='chapter'?'다음 장으로':'지금, 이야기를 시작합니다';
 smallText(ctx,signoff,safeX,bottomY+18,w-safeX*2,portrait?16:15,'#a9afab',400);
 ctx.restore();return canvas;
}
