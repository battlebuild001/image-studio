import {setupProductionShorts} from './production-shorts.js';
import {setupProductionPublishing} from './production-publishing.js';
import {setupYouTubeStudio} from './youtube-studio.js';
import {setupUploadSeries} from './upload-series.js';

const SECTIONS=[['youtube','유튜브 업로드',setupYouTubeStudio],['shorts','쇼츠·드라마 제작',setupProductionShorts],['series','시리즈 업로드',setupUploadSeries],['publishing','게시 자료',setupProductionPublishing]];
function node(tag,className='',text){const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;}
function stylesheet(id,path){if(document.getElementById(id))return;const link=node('link');link.id=id;link.rel='stylesheet';link.href=new URL(path,import.meta.url).href;document.head.append(link);}

/** Delivery tools have a separate entry point; project settings stay in their own dialog. */
export function setupVideoUploadWorkbench(api){
 stylesheet('productionWorkbenchStyles','./production-workbench.css');stylesheet('videoUploadWorkbenchStyles','./video-upload-workbench.css');
 const launcher=node('button','outline','영상 업로드');launcher.id='videoUploadBtn';launcher.type='button';document.querySelector('.project-tools').append(launcher);
 const dialog=node('dialog','modal production-workbench video-upload-workbench');dialog.id='videoUploadDialog';dialog.setAttribute('aria-labelledby','videoUploadTitle');
 const heading=node('div','dialog-heading'),titles=node('div');titles.append(node('span','eyebrow','VIDEO DELIVERY'));const title=node('h2','','영상 업로드');title.id='videoUploadTitle';titles.append(title);const close=node('button','icon-button','×');close.type='button';close.id='closeVideoUploadHeaderBtn';close.setAttribute('aria-label','영상 업로드 닫기');heading.append(titles,close);dialog.append(heading);
 const tabs=node('div','production-workbench-tabs video-upload-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','영상 업로드 도구');dialog.append(tabs);
 const body=node('div','dialog-body production-workbench-body'),error=node('p','production-error');error.id='videoUploadError';error.setAttribute('role','alert');body.append(error);dialog.append(body);
 const footer=node('div','dialog-footer'),done=node('button','ghost','닫기');done.id='closeVideoUploadBtn';done.type='button';footer.append(done);dialog.append(footer);document.body.append(dialog);
 const features=new Map(),buttons=new Map(),panels=new Map();let active='youtube',rendering=false,lastFocus=null;
 function select(id,context={},focus=false){if(!features.has(id))id='youtube';if(active!==id)features.get(active)?.flush?.({strict:true});active=id;for(const[key,tab]of buttons){const selected=key===id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;panels.get(key).hidden=!selected;}error.textContent='';const feature=features.get(id);feature.render?.();if(feature.onOpen)feature.onOpen(context);else feature.setContext?.(context);if(focus)buttons.get(id).focus();}
 function open(id='youtube',context={}){if(typeof id==='object'){context=id.context||{};id=id.section||'youtube';}api.pause?.();if(!dialog.open)lastFocus=document.activeElement;render();select(id,context);if(!dialog.open)dialog.showModal();buttons.get(active).focus();}
 for(const[id,label,setup]of SECTIONS){const tab=node('button','production-workbench-tab',label);tab.id='uploadTab-'+id;tab.type='button';tab.setAttribute('role','tab');tab.setAttribute('aria-controls','uploadPanel-'+id);const panel=node('section','production-workbench-panel');panel.id='uploadPanel-'+id;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);panel.hidden=true;body.append(panel);tabs.append(tab);buttons.set(id,tab);panels.set(id,panel);features.set(id,setup({...api,container:panel,openSection:(section,context)=>api.openProductionSection?api.openProductionSection(section,context):open(section,context)})||{});
  tab.addEventListener('click',()=>{try{select(id);}catch(cause){error.textContent=cause.message||'업로드 도구를 열지 못했어요.';}});tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const ids=SECTIONS.map(item=>item[0]),index=ids.indexOf(active);try{select(event.key==='Home'?ids[0]:event.key==='End'?ids.at(-1):ids[(index+(event.key==='ArrowRight'?1:-1)+ids.length)%ids.length],{},true);}catch(cause){error.textContent=cause.message||'입력 내용을 확인해 주세요.';}});
 }
 function render(){if(rendering)return;rendering=true;try{launcher.disabled=Boolean(api.canMutate&&!api.canMutate());for(const[id,feature]of features){try{feature.render?.();}catch(cause){error.textContent=`${buttons.get(id).textContent}: ${cause.message||'저장된 내용을 확인해 주세요.'}`;}}}finally{rendering=false;}}
 function flush(options={}){for(const feature of features.values())try{feature.flush?.(options);}catch(cause){if(options.strict!==false)throw cause;}}
 function dismiss(){try{flush({strict:true});dialog.close();}catch(cause){error.textContent=cause.message||'입력 내용을 확인한 뒤 닫아 주세요.';}}
 function reset(){for(const feature of features.values())feature.reset?.();if(dialog.open)dialog.close();error.textContent='';render();}
 function isBusy(){return[...features.values()].some(feature=>Boolean(feature.getBusy?.()||feature.isBusy?.()||feature.getUploadBusy?.()));}
 launcher.addEventListener('click',()=>open(active));close.addEventListener('click',dismiss);done.addEventListener('click',dismiss);dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});dialog.addEventListener('close',()=>{for(const feature of features.values())feature.onClose?.();queueMicrotask(()=>{if(lastFocus?.isConnected&&!lastFocus.closest('dialog:not([open])'))lastFocus.focus();});});
 select('youtube');render();return{open,render,flush,reset,getFeature:id=>features.get(id),isBusy};
}
