import {validateTypecastVoiceRequest, assertTypecastVoiceSupport} from './typecast-protocol.js';

function node(tag, className = '', text) {const value=document.createElement(tag);value.className=className;if(text!==undefined)value.textContent=text;return value;}
const EMOTIONS={normal:'보통',happy:'기쁨',sad:'슬픔',angry:'화남',whisper:'속삭임',toneup:'밝게',tonedown:'차분하게'};
function labelText(field,text){const span=field.wrapper.querySelector('span');if(span)span.textContent=text;}
function number(field,{min,max,step,value},reset){field.input.min=String(min);field.input.max=String(max);field.input.step=String(step);if(reset)field.input.value=String(value);}

/** Shared provider controls keep legacy numeric semantics separate from Typecast. */
export function setupVoiceProviderControls({container,fields,prefix,onChange=()=>{},openSettings=()=>{}}) {
  if(!document.getElementById('voiceProviderControlsStyles')){const style=node('link');style.id='voiceProviderControlsStyles';style.rel='stylesheet';style.href=new URL('./voice-provider-controls.css',import.meta.url).href;document.head.append(style);}
  const {speaker,speed,pitch,volume}=fields,legacyOptions=[...speaker.input.options].map(option=>({id:option.value,name:option.textContent})),legacyLabels=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,value.wrapper.querySelector('span')?.textContent||''])),legacyRanges=Object.fromEntries(['speed','pitch','volume'].map(key=>[key,{min:fields[key].input.min,max:fields[key].input.max,step:fields[key].input.step,value:fields[key].input.value}]));
  const box=node('section','voice-provider-controls');box.hidden=true;container.after(box);
  const model=node('p','voice-provider-help');model.id=prefix+'ModelInfo';const settings=node('button','ghost small','타입캐스트 API 설정');settings.type='button';settings.id=prefix+'TypecastSettingsBtn';settings.addEventListener('click',openSettings);box.append(model,settings);
  function selectField(id,label){const wrapper=node('label','voice-provider-field'),input=node('select');input.id=id;wrapper.htmlFor=id;wrapper.append(node('span','',label),input);return{wrapper,input};}
  const emotionType=selectField(prefix+'EmotionType','감정 표현'),emotion=selectField(prefix+'Emotion','감정'),intensityWrapper=node('label','voice-provider-field'),intensity=node('input');intensity.type='number';intensity.id=prefix+'EmotionIntensity';intensity.min='0';intensity.max='2';intensity.step='.1';intensity.value='1';intensityWrapper.htmlFor=intensity.id;intensityWrapper.append(node('span','','감정 강도 · 0~2'),intensity);
  const grid=node('div','voice-provider-grid');grid.append(emotionType.wrapper,emotion.wrapper,intensityWrapper);box.append(grid);
  const sampleRow=node('div','voice-provider-sample'),sample=node('button','outline','선택 목소리 샘플 듣기');sample.type='button';sample.id=prefix+'SampleBtn';const audio=node('audio');audio.id=prefix+'SampleAudio';audio.controls=true;audio.preload='none';audio.crossOrigin='anonymous';audio.setAttribute('referrerpolicy','no-referrer');audio.hidden=true;const sampleStatus=node('p','voice-provider-help');sampleStatus.id=prefix+'SampleStatus';sampleStatus.setAttribute('role','status');sampleStatus.setAttribute('aria-live','polite');sampleRow.append(sample,audio);box.append(sampleRow,sampleStatus,node('p','voice-provider-help','타입캐스트의 다국어 목소리로 한국어를 합성해요. 공식 샘플은 다른 언어일 수 있고, 제공되지 않을 수 있어요. 샘플 조회는 새 음성을 생성하지 않아요.'));
  let config=null,disabled=false,epoch=0;
  const isTypecast=()=>config?.provider==='typecast';
  const selected=()=>config?.speakers?.find(value=>value.id===speaker.input.value);
  function choices(){const item=selected(),modelEntry=item?.models?.find(value=>value.version===config?.model);return(modelEntry?.emotions||[]).filter(value=>Object.hasOwn(EMOTIONS,value));}
  function refreshEmotion(){if(!isTypecast())return;const previous=emotion.input.value,list=choices();emotion.input.replaceChildren(...list.map(value=>{const option=node('option','',EMOTIONS[value]);option.value=value;return option;}));if(list.includes(previous))emotion.input.value=previous;const preset=emotionType.input.value==='preset';emotion.wrapper.hidden=intensityWrapper.hidden=!preset;emotion.input.disabled=disabled||!preset;intensity.disabled=disabled||!preset;sample.disabled=disabled||!selected()?.previewUrl;}
  function stopSample(){epoch++;audio.pause();audio.removeAttribute('src');audio.load();audio.hidden=true;sampleStatus.textContent='';}
  function setSpeakers(list){const previous=speaker.input.value;speaker.input.replaceChildren(...list.map(value=>{const option=node('option','',value.name||value.id);option.value=value.id;return option;}));speaker.input.value=list.some(value=>value.id===previous)?previous:list[0]?.id||'';}
  function applyConfig(value={}){
    const previousType=isTypecast(),previousModel=config?.model;config=value;const typecast=isTypecast(),changed=previousType!==typecast||previousModel!==value.model;box.hidden=!typecast;
    if(typecast){
      setSpeakers(Array.isArray(value.speakers)?value.speakers:[]);labelText(speaker,'목소리 · 한국어 합성');labelText(speed,'읽는 속도 · 1배가 기본');labelText(pitch,'음높이 · 반음');labelText(volume,'출력 음량 · %');number(speed,{min:.5,max:2,step:.05,value:1},changed);number(pitch,{min:-12,max:12,step:1,value:0},changed);number(volume,{min:0,max:200,step:1,value:100},changed);
      model.textContent=`Typecast · ${value.model||'모델 확인 필요'} · 한국어`;const previous=emotionType.input.value,types=value.model==='ssfm-v21'?['preset']:['smart','preset'];emotionType.input.replaceChildren(...types.map(kind=>{const option=node('option','',kind==='smart'?'문맥에 맞게 자동':'직접 감정 선택');option.value=kind;return option;}));emotionType.input.value=!changed&&types.includes(previous)?previous:types[0];if(changed){intensity.value='1';stopSample();}refreshEmotion();
    }else{
      if(previousType){setSpeakers(Array.isArray(value.speakers)&&value.speakers.length?value.speakers:legacyOptions);for(const[key,field]of Object.entries(fields))labelText(field,legacyLabels[key]);for(const key of['speed','pitch','volume']){const field=fields[key],saved=legacyRanges[key];field.input.min=saved.min;field.input.max=saved.max;field.input.step=saved.step;field.input.value=saved.value;}stopSample();}
      else if(Array.isArray(value.speakers)&&value.speakers.length)setSpeakers(value.speakers);
    }
    setDisabled(disabled);
  }
  function snapshot(){const common={speaker:speaker.input.value,...(isTypecast()?{provider:'typecast',model:config.model,tempo:Number(speed.input.value),pitch:Number(pitch.input.value),volume:Number(volume.input.value),emotionType:emotionType.input.value,emotion:emotion.input.value||'normal',emotionIntensity:Number(intensity.value)}:{speed:Number(speed.input.value),pitch:Number(pitch.input.value),volume:Number(volume.input.value)})};return common;}
  function request(text){const data={text,...snapshot()};if(isTypecast()){const normalized=validateTypecastVoiceRequest(data);assertTypecastVoiceSupport(normalized,config.speakers);const{characters,...result}=normalized;return result;}for(const[key,min,max]of[['speed',-5,10],['pitch',-5,5],['volume',-5,5]])if(!Number.isInteger(data[key])||data[key]<min||data[key]>max)throw new Error('목소리 속도·음높이·음량의 범위를 확인해 주세요.');return data;}
  function setDisabled(value){disabled=Boolean(value);for(const field of[speaker,speed,pitch,volume])field.input.disabled=disabled;emotionType.input.disabled=settings.disabled=disabled;if(isTypecast())refreshEmotion();else sample.disabled=true;}
  speaker.input.addEventListener('change',()=>{if(isTypecast()){stopSample();refreshEmotion();}onChange();});emotionType.input.addEventListener('change',()=>{refreshEmotion();onChange();});emotion.input.addEventListener('change',onChange);intensity.addEventListener('input',onChange);
  sample.addEventListener('click',async()=>{const url=selected()?.previewUrl;if(!url||disabled)return;stopSample();const serial=epoch;audio.src=url;audio.hidden=false;sampleStatus.textContent='공식 목소리 샘플을 불러오고 있어요.';try{await audio.play();if(serial===epoch)sampleStatus.textContent='공식 샘플을 재생하고 있어요. 한국어 합성 결과는 생성 후 확인하세요.';}catch{if(serial===epoch)sampleStatus.textContent='이 목소리의 공식 샘플을 재생하지 못했어요. 유료 음성 생성은 실행하지 않았어요.';}});
  audio.addEventListener('error',()=>{sampleStatus.textContent='이 목소리의 공식 샘플을 재생하지 못했어요. 유료 음성 생성은 실행하지 않았어요.';});
  return{applyConfig,snapshot,request,setDisabled,stopSample,isTypecast,getConfig:()=>config,extraInputs:[emotionType.input,emotion.input,intensity],reset(){stopSample();applyConfig({});}};
}
