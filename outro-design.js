import {createOperationStatus,nextPaint} from './operation-status.js';
import {canvasBlob,taskScope,matchesScope} from './production-delivery-utils.js';
import {renderTitleDesign,selectTitleBackdrop,normalizeTitleOverline} from './title-design.js';

export const DESIGNED_OUTRO_SECONDS=10;
export const OUTRO_DEFAULT_TITLE='다음 이야기에서 만나요.';
export const OUTRO_DEFAULT_SUBTITLE='함께해 주셔서 감사합니다.';
function clean(value,max,label){if(typeof value!=='string'||Array.from(value).length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw new Error(`${label}을 확인해 주세요.`);return value.trim();}
function content(value={}){if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('아웃트로 문구를 확인해 주세요.');return{title:clean(value.title??'',200,'아웃트로 제목')||OUTRO_DEFAULT_TITLE,subtitle:clean(value.subtitle??'',500,'아웃트로 보조 문구')||OUTRO_DEFAULT_SUBTITLE,channelName:clean(value.channelName??'',120,'채널 이름'),overline:normalizeTitleOverline(value.overline,'outro')};}
/** A real frame graphic. Video timing belongs to the explicit 10-second scene. */
export function renderOutroDesign(canvas,value={}){
 const settings=content(value);
 return renderTitleDesign(canvas,{kind:'outro',...settings,backgroundImage:value.backgroundImage??null,logo:value.logo??null,color:value.color});
}

function node(tag,className='',text){const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;}
function download(blob,name){const url=URL.createObjectURL(blob),anchor=node('a');anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function setupOutroDesign(api){
 const container=api.container;if(!document.getElementById('outroDesignStyles')){const sheet=node('link');sheet.id='outroDesignStyles';sheet.rel='stylesheet';sheet.href=new URL('./outro-design.css',import.meta.url).href;document.head.append(sheet);}
 const card=node('section','production-card outro-design-card'),heading=node('div','outro-design-heading');heading.append(node('h4','','아웃트로 · 10초'),node('span','outro-design-duration','10 SEC'));card.append(heading,node('p','production-help','마지막 장면의 이미지에 인사말을 얹어 마무리해요. 위 아웃트로 문구를 사용하며, 빈칸이면 기본 인사말을 넣어요.'));
 const actions=node('div','production-actions'),previewButton=node('button','outline','10초 아웃트로 보기'),saveButton=node('button','outline','PNG 저장'),addButton=node('button','primary','영상 끝에 10초 아웃트로 추가');previewButton.id='previewDesignedOutroBtn';saveButton.id='downloadDesignedOutroBtn';addButton.id='addDesignedOutroBtn';for(const button of[previewButton,saveButton,addButton])button.type='button';actions.append(previewButton,saveButton,addButton);card.append(actions);
 const canvas=node('canvas','production-preview outro-design-preview');canvas.id='designedOutroPreview';canvas.setAttribute('aria-label','영상 끝에 추가할 10초 아웃트로 미리보기');canvas.width=1280;canvas.height=720;canvas.hidden=true;card.append(canvas,node('p','production-help','미리보기와 같은 이미지가 영상에 들어가요. YouTube의 클릭 가능한 종료 화면은 YouTube Studio에서 따로 설정할 수 있어요.'));
 const status=node('p','production-status'),error=node('p','production-error');status.id='designedOutroStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');error.id='designedOutroError';error.setAttribute('role','alert');card.append(status,error);container.append(card);const operation=createOperationStatus({container:card,region:card,id:'designedOutroOperation'});
 let busy=false,serial=0,owner='';const ownerKey=()=>JSON.stringify([api.getWorkspaceId?.()??null,api.getProject().id]);
 function draw(){const value=content(api.getDesignContent?.()||{}),project=api.getProject(),portrait=project.aspect==='9:16';canvas.width=portrait?720:1280;canvas.height=portrait?1280:720;renderOutroDesign(canvas,{...value,backgroundImage:selectTitleBackdrop(api,'outro'),color:project.settings.captionColor==='#ffffff'?'#dfbb84':project.settings.captionColor});canvas.hidden=false;return value;}
 function refresh(){const disabled=busy||Boolean(api.canMutate&&!api.canMutate());previewButton.disabled=saveButton.disabled=addButton.disabled=disabled;}
 async function perform(kind){if(busy)return;const scope=taskScope(api),key=ownerKey(),seq=++serial;error.textContent='';busy=true;refresh();const task=operation.start(kind==='add'?'10초 아웃트로를 영상 끝에 추가하고 있어요.':kind==='save'?'아웃트로 이미지를 저장하고 있어요.':'아웃트로 디자인을 준비하고 있어요.');try{await nextPaint();const value=draw();if(kind==='preview'){status.textContent='현재 영상 비율의 10초 아웃트로를 미리 보여 드려요.';task.finish(status.textContent);return;}const blob=await canvasBlob(canvas);if(seq!==serial||key!==ownerKey()||!matchesScope(api,scope))throw new Error('프로젝트가 바뀌어 아웃트로 작업을 취소했어요.');if(kind==='save'){download(blob,'아웃트로-10초.png');status.textContent='실제 아웃트로 PNG를 저장했어요.';}else{api.mutate(project=>{project.production||={version:1};project.production.channel={...(project.production.channel||{}),name:value.channelName,outro:{enabled:true,title:value.title,subtitle:value.subtitle,overline:value.overline,duration:DESIGNED_OUTRO_SECONDS},updatedAt:new Date().toISOString()};});await api.addTemplateScene({scene:{caption:'',duration:DESIGNED_OUTRO_SECONDS,motion:'none'},asset:{blob,type:'image/png',name:'아웃트로-10초.png'},position:'end'});await api.persist?.();if(seq!==serial||key!==ownerKey())return;status.textContent='영상 끝에 10초 아웃트로를 추가하고 프로젝트 설정에 저장했어요.';}task.finish(status.textContent);}catch(cause){if(seq===serial){error.textContent=cause.message||'아웃트로를 준비하지 못했어요.';task.fail(error.textContent);}}finally{if(seq===serial){busy=false;refresh();}}}
 previewButton.addEventListener('click',()=>perform('preview'));saveButton.addEventListener('click',()=>perform('save'));addButton.addEventListener('click',()=>perform('add'));
 function render(){const key=ownerKey();if(owner!==key){serial++;owner=key;busy=false;canvas.hidden=true;status.textContent=error.textContent='';operation.clear();}refresh();}
 render();return{render,updatePreview(){if(!canvas.hidden&&!busy)draw();},flush(){},reset(){serial++;owner='';busy=false;canvas.hidden=true;operation.clear();render();},onClose(){},getBusy:()=>busy};
}
