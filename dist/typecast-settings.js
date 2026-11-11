import {getDesktopSettingsBridge,desktopRememberAvailable} from './desktop-settings.js';
import {getTypecastSettings, setTypecastSettings, clearTypecastSettings, checkTypecastKey} from './direct-typecast.js';
import {createOperationStatus, nextPaint} from './operation-status.js';

function node(tag, className = '', text) {const value=document.createElement(tag);if(className)value.className=className;if(text!==undefined)value.textContent=text;return value;}
function button(id,text,className='outline') {const value=node('button',className,text);value.id=id;value.type='button';return value;}
function field(id,label,type='text') {const wrapper=node('label','api-settings-field');wrapper.htmlFor=id;wrapper.append(node('span','',label));const input=node('input');input.id=id;input.type=type;wrapper.append(input);return{wrapper,input};}
function link(text,href) {const value=node('a','',text);value.href=href;value.target='_blank';value.rel='noopener noreferrer';return value;}
function friendlyError(cause) {
  if(cause?.status===401||cause?.status===403||/AUTH|PERMISSION/u.test(String(cause?.code||'')))return'Typecast API 키와 사용 권한을 확인해 주세요. 기존 설정은 유지했어요. 웹 서비스 구독과 API 연결은 별도예요.';
  if(cause?.status===429)return'Typecast API 사용량 또는 요청 한도에 도달했어요. 계정 사용량을 확인한 뒤 다시 시도해 주세요. 기존 설정은 유지했어요.';
  if(/STORAGE/u.test(String(cause?.code||''))&&getDesktopSettingsBridge())return'PC 보안 저장소에 Typecast 설정을 저장하지 못했어요. 현재 창에서만 기억하기를 선택하거나 Windows 보안 저장소를 확인해 주세요. 기존 설정은 유지했어요.';
  if(/STORAGE/u.test(String(cause?.code||'')))return'선택한 보관 방식으로 Typecast 설정을 저장하지 못했어요. 브라우저의 사이트 데이터 저장 권한을 확인해 주세요. 기존 설정은 유지했어요.';
  if(cause?.name==='AbortError')return'';
  if(/INPUT|KEY|MODEL|SETTING/u.test(String(cause?.code||'')))return'Typecast API 키, 모델과 보관 방식을 확인해 주세요. 기존 설정은 유지했어요.';
  return'Typecast 연결을 확인하지 못했어요. 네트워크 상태와 API 키를 확인해 주세요. 기존 설정은 유지했어요.';
}

/** Typecast credentials remain global connection settings, separate from editable projects. */
export function setupTypecastSettings(api={}) {
  const desktop=Boolean(getDesktopSettingsBridge()),secureRemember=desktop&&desktopRememberAvailable();
  const container=api.container;if(!container?.append)throw new Error('Typecast 설정 화면을 준비하지 못했어요.');
  const client=api.typecastClient||{getSettings:getTypecastSettings,setSettings:setTypecastSettings,clearSettings:clearTypecastSettings,checkKey:checkTypecastKey};
  if(!document.getElementById('typecastSettingsStyles')){const sheet=node('link');sheet.id='typecastSettingsStyles';sheet.rel='stylesheet';sheet.href=new URL('./typecast-settings.css',import.meta.url).href;document.head.append(sheet);}
  container.classList.add('typecast-settings');
  container.append(node('p','api-settings-help','본인의 Typecast API 키로 목소리 목록을 불러오고 한국어 내레이션을 만들어요. 키 저장과 연결 확인은 음성을 생성하지 않아요. Typecast 웹 서비스 구독과 API 요금제는 별도예요.'));
  const current=node('p','api-settings-current');current.id='typecastSettingsCurrent';current.setAttribute('role','status');current.setAttribute('aria-live','polite');container.append(current);
  const key=field('typecastApiKey','Typecast API 키','password');key.input.autocomplete='off';key.input.spellcheck=false;key.input.maxLength=2048;key.input.placeholder='Typecast에서 발급한 API 키';key.input.setAttribute('aria-describedby','typecastApiKeyHelp');container.append(key.wrapper);
  const keyHelp=node('p','api-settings-help','저장된 키는 화면에 다시 표시하지 않아요. 빈칸으로 저장하면 기존 키를 유지해요. 프로젝트·백업·보관함에는 키를 포함하지 않아요.');keyHelp.id='typecastApiKeyHelp';container.append(keyHelp);
  const enabledLabel=node('label','api-settings-checkbox typecast-enabled'),enabled=node('input');enabled.id='typecastEnabled';enabled.type='checkbox';enabledLabel.htmlFor=enabled.id;enabledLabel.append(enabled,node('span','','Typecast로 음성 생성하기'));container.append(enabledLabel,node('p','api-settings-help','이 선택은 음성 생성에만 적용해요. OpenAI 대본·이미지·음성 분석 연결은 그대로 사용할 수 있어요. 선택을 끄면 저장한 키는 유지하고 음성 생성은 선택한 서버 연결을 사용해요.'));
  const retention=node('fieldset','api-settings-retention');retention.append(node('legend','','Typecast 키 보관 방식'));
  function choice(id,label,help){const wrapper=node('label','api-settings-retention-option'),input=node('input');input.id=id;input.type='radio';input.name='typecastKeyRetention';const text=node('span');text.append(node('span','api-settings-retention-label',label),node('span','api-settings-help',help));wrapper.append(input,text);retention.append(wrapper);return input;}
  const browser=choice('rememberTypecastKeyBrowser',desktop?'이 PC에 안전하게 기억하기':'이 브라우저에서 계속 기억하기',desktop?'Windows 보안 저장소로 암호화해 앱을 다시 실행해도 유지해요.':'브라우저를 닫고 다시 열어도 이 기기의 키와 모델 설정을 유지해요.');
  const tab=choice('rememberTypecastKeyTab',desktop?'현재 창에서만 기억하기':'이 탭을 사용하는 동안 기억하기',desktop?'화면을 새로고침해도 유지하고 앱을 완전히 종료하면 지워요.':'같은 탭의 새로고침에는 유지하고 탭을 닫으면 보관이 끝나요.');
  const memory=choice('forgetTypecastKey','저장하지 않기','현재 페이지에서만 사용해요. 새로고침하면 다시 입력해야 해요.');container.append(retention,node('p','api-settings-help',desktop?(secureRemember?'보관 방식은 저장해야 적용돼요. 키는 이 PC의 사용자 계정으로 암호화하며 프로젝트 파일에는 포함하지 않아요. 공용 PC에서는 현재 창 보관을 선택하세요.':'이 PC에서 보안 저장소를 사용할 수 없어요. 현재 창에서만 기억하거나 저장하지 않고 사용할 수 있어요.'):'보관 방식은 저장해야 적용돼요. 공용 기기에서는 브라우저 보관을 선택하지 마세요. 사이트 데이터를 삭제하거나 다른 브라우저를 사용하면 키를 다시 입력해야 해요.'));
  const modelLabel=node('label','api-settings-field');modelLabel.htmlFor='typecastModel';modelLabel.append(node('span','','Typecast 음성 모델'));const model=node('select');model.id='typecastModel';for(const[value,label]of[['ssfm-v31','SSFM v3.1 · 권장'],['ssfm-v30','SSFM v3.0'],['ssfm-v21','SSFM v2.1']]){const option=node('option','',label);option.value=value;model.append(option);}modelLabel.append(model);container.append(modelLabel,node('p','api-settings-help','선택한 모델을 지원하는 실제 목소리 목록을 사용해요. 감정·속도·음높이·음량은 음성 만들기 화면에서 조절합니다. 모델이나 키 변경만으로 합성하지 않아요.'));
  const privacy=node('p','api-settings-privacy');privacy.append('‘연결 확인·저장’은 목소리 목록만 조회해요. 대본은 ‘음성 생성’을 실행할 때만 Typecast에 전송되며 요금이 발생할 수 있어요. 상업적 사용과 출처 표기 조건은 ',link('공식 API 요금제','https://typecast.ai/pricing/api/'),'에서 확인하세요.');container.append(privacy);
  const actions=node('div','api-settings-actions'),verify=button('verifyTypecastKeyBtn','연결 확인·저장','primary'),save=button('saveTypecastSettingsBtn','저장'),clear=button('clearTypecastKeyBtn','키 삭제','ghost');actions.append(verify,save,clear);container.append(actions);
  const status=node('p','api-settings-status');status.id='typecastSettingsStatus';status.setAttribute('role','status');status.setAttribute('aria-live','polite');const error=node('p','api-settings-error');error.id='typecastSettingsError';error.setAttribute('role','alert');container.append(status,error);
  const help=node('p','api-settings-help typecast-settings-links');help.append(link('Typecast API 키 발급·관리','https://studio.typecast.ai/developers/api'),' · ',link('공식 API 문서','https://typecast.ai/docs/ko/overview'));container.append(help);
  const progressMount=node('div');container.append(progressMount);const progress=createOperationStatus({container:progressMount,region:container,id:'typecastSettingsOperation'});
  let busy=false,operation=0,controller=null,timeout=null,applying=false;
  const controls=[key.input,enabled,browser,tab,memory,model,verify,save,clear];
  const mutable=()=>!api.canMutate||api.canMutate();
  function candidate(){return{apiKey:key.input.value,enabled:enabled.checked,model:model.value,rememberForTab:tab.checked,rememberInBrowser:browser.checked};}
  function render(){const saved=client.getSettings(),scope=saved.rememberInBrowser?(desktop?'PC 보안 저장소':'이 브라우저'):saved.rememberForTab?(desktop?'현재 창':'이 탭'):'현재 페이지';current.textContent=saved.hasKey?`Typecast API 키 저장됨 · •••••••• · ${scope} · ${saved.model||'ssfm-v31'} · ${saved.enabled?'음성 생성 사용 중':'음성 생성 사용 꺼짐'}`:'Typecast API 키가 아직 입력되지 않았어요. 키를 입력하고 저장해 주세요.';current.dataset.connected=String(Boolean(saved.enabled&&saved.hasKey));for(const input of controls)input.disabled=busy||!mutable();container.setAttribute('aria-busy',String(busy));}
  function hydrate(){const saved=client.getSettings();key.input.value='';enabled.checked=saved.hasKey?saved.enabled:true;model.value=saved.model||'ssfm-v31';browser.checked=Boolean(saved.rememberInBrowser)||(!saved.hasKey&&secureRemember);tab.checked=!browser.checked&&(Boolean(saved.rememberForTab)||(!saved.hasKey&&desktop));memory.checked=!browser.checked&&!tab.checked;render();}
  function stop(message='연결 확인을 취소했어요. 기존 설정은 유지했어요.'){operation++;controller?.abort();controller=null;if(timeout)clearTimeout(timeout);timeout=null;if(busy)progress.cancel(message);busy=false;if(message)status.textContent=message;render();}
  async function saveSettings(check){if(busy||!mutable())return;error.textContent='';status.textContent='';const value=candidate(),sequence=++operation;
    if(!check){try{applying=true;client.setSettings(value);hydrate();status.textContent=value.enabled?'Typecast 설정을 저장했어요. 음성 만들기에서 목소리를 선택해 주세요.':'Typecast 키와 모델을 저장했어요. 음성 생성 사용은 꺼져 있어요.';}catch(cause){error.textContent=friendlyError(cause);}finally{applying=false;render();}return;}
    busy=true;controller=new AbortController();const abort=controller;timeout=setTimeout(()=>abort.abort(),65000);const task=progress.start('Typecast API 키와 실제 목소리 목록을 확인하고 있어요.',{detail:'음성을 생성하지 않는 조회입니다.'});render();
    try{await nextPaint();const result=await client.checkKey(value,{signal:abort.signal});if(sequence!==operation)return;if(abort.signal.aborted)throw new DOMException('연결 확인을 취소했어요.','AbortError');applying=true;client.setSettings(value);applying=false;key.input.value='';hydrate();const count=Array.isArray(result?.speakers)?result.speakers.length:0;status.textContent=count?`Typecast 연결을 확인하고 저장했어요. ${count.toLocaleString()}개 목소리를 불러왔어요.${value.enabled?'':' 음성 생성 사용은 꺼져 있어요.'}`:'API 키를 확인하고 저장했어요. 선택한 모델에서 사용할 목소리가 없어 모델 설정을 확인해 주세요.';task.finish('Typecast 목소리 목록 확인 완료');}
    catch(cause){if(sequence!==operation)return;const message=cause?.name==='AbortError'?'연결 확인 시간이 초과됐어요. 기존 설정은 유지했어요.':friendlyError(cause);error.textContent=message;task.fail(message);}
    finally{applying=false;if(sequence===operation){if(timeout)clearTimeout(timeout);timeout=null;controller=null;busy=false;render();}}
  }
  verify.addEventListener('click',()=>saveSettings(true));save.addEventListener('click',()=>saveSettings(false));clear.addEventListener('click',()=>{if(busy||!mutable())return;try{applying=true;client.clearSettings();key.input.value='';error.textContent='';hydrate();status.textContent='Typecast 키를 삭제했어요. 대본과 기존 음성·프로젝트는 그대로 있어요.';}catch(cause){error.textContent=friendlyError(cause);}finally{applying=false;render();}});
  for(const input of[key.input,enabled,browser,tab,memory,model])input.addEventListener(input.tagName==='SELECT'||input.type==='radio'||input.type==='checkbox'?'change':'input',()=>{if(busy)stop('입력이 바뀌어 연결 확인을 취소했어요. 다시 확인해 주세요.');error.textContent='';});
  const changed=()=>{if(applying)return;if(busy)stop('다른 Typecast 설정 변경으로 연결 확인을 취소했어요. 현재 저장 상태를 확인해 주세요.');key.input.value='';hydrate();};
  window.addEventListener('studio-voice-settings-change',changed);
  function onClose(){stop('');key.input.value='';}
  function reset(){onClose();status.textContent='';error.textContent='';progress.clear();hydrate();}
  hydrate();return{render,hydrate,onClose,reset,flush(){},isBusy:()=>busy,dispose(){onClose();window.removeEventListener('studio-voice-settings-change',changed);progress.dispose?.();}};
}
