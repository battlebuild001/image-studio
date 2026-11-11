/** Optional native settings boundary. The web app never calls IPC or changes its storage policy. */
export function getDesktopSettingsBridge(value=globalThis.contentStudioDesktop){
  return value?.version===1&&typeof value.loadSettingsSync==='function'&&typeof value.saveSettingsSync==='function'?value:null;
}
export function readDesktopProvider(bridge,name){
  if(!bridge)return null;
  const result=bridge.loadSettingsSync();
  if(!result||typeof result!=='object'||!result.settings||typeof result.settings!=='object')return null;
  const value=result.settings[name];
  return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
}
export function writeDesktopProvider(bridge,name,value){
  if(!bridge||!['openai','typecast','server'].includes(name))throw new Error('PC 설정 저장소를 준비하지 못했어요.');
  const result=bridge.saveSettingsSync({[name]:value});
  if(!result||result.saved!==true)throw new Error('PC 설정을 저장하지 못했어요. 기존 설정은 유지했어요.');
  return result;
}
export function removeDesktopProvider(bridge,name){return writeDesktopProvider(bridge,name,null);}
export function clearLegacyProviderCopies(stores){
  for(const[store,key]of stores){try{store?.removeItem(key);}catch{}}
}
export function desktopRememberAvailable(){
  const bridge=getDesktopSettingsBridge();if(!bridge)return false;
  try{return bridge.loadSettingsSync()?.available===true;}catch{return false;}
}
