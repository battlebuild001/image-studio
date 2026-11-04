import {validateTypecastVoiceRequest} from './typecast-protocol.js';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const ID=/^[A-Za-z0-9_-]{1,180}$/u;
const fields=new Set(['provider','model','speaker','tempo','pitch','volume','emotionType','emotion','emotionIntensity','paragraphPauseSeconds','paragraphPauses']);
const sampleFields=new Set(['assetId','name','textKey','settingsKey','createdAt','duration','settings']);
function fail(message='저장한 음성 설정을 확인해 주세요.'){throw new Error(message);}
export function normalizeVoicePreferences(input){
 if(!plain(input)||Object.keys(input).some(key=>!fields.has(key))||input.provider!=='typecast')fail();
 const {characters,text,...value}=validateTypecastVoiceRequest({...input,text:'음성 설정'});
 return{...value,paragraphPauseSeconds:value.paragraphPauseSeconds??0,paragraphPauses:value.paragraphPauses??[]};
}
function hash(text){let a=2166136261,b=2246822519;for(const c of text){const n=c.codePointAt(0);a=Math.imul(a^n,16777619);b=Math.imul(b^n,3266489917);}return `${text.length.toString(16)}-${(a>>>0).toString(16).padStart(8,'0')}${(b>>>0).toString(16).padStart(8,'0')}`;}
export function voiceTextKey(text){if(typeof text!=='string'||text.length>150000)fail('읽을 대본을 확인해 주세요.');return hash(text.replace(/\r\n/gu,'\n'));}
export function voiceSettingsKey(settings){if(!plain(settings))fail();const keys=Object.keys(settings).sort();const clean=Object.fromEntries(keys.filter(k=>!['text','characters','voiceEpoch'].includes(k)).map(k=>[k,settings[k]]));return hash(JSON.stringify(clean));}
export function normalizeVoiceSample(input){
 if(!plain(input)||Object.keys(input).some(key=>!sampleFields.has(key))||!ID.test(input.assetId||''))fail('저장한 음성 샘플 정보를 확인해 주세요.');
 if(typeof input.name!=='string'||!input.name.trim()||Array.from(input.name).length>180||/[\x00-\x1f\x7f]/u.test(input.name))fail('음성 샘플 이름을 확인해 주세요.');
 for(const key of ['textKey','settingsKey'])if(typeof input[key]!=='string'||!/^[a-f\d]+-[a-f\d]{16}$/u.test(input[key])||input[key].length>100)fail('음성 샘플의 대본·설정 식별자를 확인해 주세요.');
 if(typeof input.duration!=='number'||!Number.isFinite(input.duration)||input.duration<=0||input.duration>3600)fail('음성 샘플 길이를 확인해 주세요.');
 if(typeof input.createdAt!=='string'||input.createdAt.length>40||!/^\d{4}-\d{2}-\d{2}T/u.test(input.createdAt)||!Number.isFinite(Date.parse(input.createdAt)))fail('음성 샘플 저장 시각을 확인해 주세요.');
 const result={assetId:input.assetId,name:input.name,textKey:input.textKey,settingsKey:input.settingsKey,createdAt:input.createdAt,duration:input.duration};
 if(input.settings!==undefined){if(input.settings?.provider==='typecast')result.settings=normalizeVoicePreferences(input.settings);else{const s=input.settings;if(!plain(s)||Object.keys(s).some(key=>!['provider','speaker','speed','pitch','volume'].includes(key))||!['server',undefined].includes(s.provider)||typeof s.speaker!=='string'||!ID.test(s.speaker))fail('음성 샘플 설정을 확인해 주세요.');result.settings={provider:'server',speaker:s.speaker};for(const key of ['speed','pitch','volume']){const n=s[key]??0;if(!Number.isInteger(n)||n<-5||n>(key==='speed'?10:5))fail();result.settings[key]=n;}}}
 return result;
}
