import assert from 'node:assert/strict';
import {test} from 'node:test';
import {normalizeVoicePreferences,normalizeVoiceSample,voiceTextKey,voiceSettingsKey} from '../dist/voice-preferences-protocol.js';
import {validateTypecastVoiceRequest,createTypecastSpeechPlan,splitTypecastText,buildTypecastTtsRequest} from '../dist/typecast-protocol.js';
const base={provider:'typecast',speaker:'tc_saved_voice',model:'ssfm-v31',tempo:1.2,pitch:2,volume:95,emotionType:'preset',emotion:'happy',emotionIntensity:1.4,paragraphPauseSeconds:.4,paragraphPauses:[{afterParagraph:1,seconds:.7}]};
test('project voice preferences preserve explicitly chosen values and reject credentials or invalid pause data',()=>{
 assert.deepEqual(normalizeVoicePreferences(base),base);const input=structuredClone(base);normalizeVoicePreferences(input);assert.deepEqual(input,base);
 for(const value of [{...base,apiKey:'secret'},{...base,speaker:'nara'},{...base,tempo:3},{...base,paragraphPauseSeconds:-1},{...base,paragraphPauses:[{afterParagraph:1,seconds:.2},{afterParagraph:1,seconds:.5}]},{...base,paragraphPauses:[{afterParagraph:1}]}])assert.throws(()=>normalizeVoicePreferences(value));
});
test('paragraph synthesis preserves every original character and attaches added silence only to paragraph ends',()=>{
 const text='첫 번째 단락입니다.\r\n\r\n둘째 단락입니다.\n\n마지막 단락입니다.',input=validateTypecastVoiceRequest({...base,text}),plan=createTypecastSpeechPlan(input);
 assert.equal(plan.map(part=>part.text).join(''),text);assert.deepEqual(plan.map(part=>part.pauseAfterSeconds),[.7,.4,0]);
 const body=buildTypecastTtsRequest(input,plan[0].text,{nextText:plan[1].text});assert.equal(body.language,'kor');assert.equal(Object.hasOwn(body,'paragraphPauses'),false);assert.equal(Object.hasOwn(body,'pauseAfterSeconds'),false);assert.equal(Object.hasOwn(body.output,'paragraphPauseSeconds'),false);
});
test('a long paragraph still uses bounded chunks, while zero-pause requests retain original chunk behavior',()=>{
 const text=('아주 긴 문장입니다. ').repeat(190)+'\n\n두 번째 단락입니다.',input=validateTypecastVoiceRequest({...base,text}),plan=createTypecastSpeechPlan(input);
 assert.equal(plan.map(part=>part.text).join(''),text);assert.ok(plan.every(part=>Array.from(part.text).length<=2000));assert.ok(plan.length>2);assert.equal(plan[0].pauseAfterSeconds,0);assert.equal(plan.at(-2).pauseAfterSeconds,.7);
 const zero=createTypecastSpeechPlan(validateTypecastVoiceRequest({...base,text,paragraphPauseSeconds:0,paragraphPauses:[]}));assert.deepEqual(zero,splitTypecastText(text).map(text=>({text,pauseAfterSeconds:0})));
 assert.throws(()=>createTypecastSpeechPlan({...base,text:'한 단락',paragraphPauses:[{afterParagraph:2,seconds:1}]}));
});
test('voice sample metadata identifies actual spoken text/settings without serializing audio or provider secrets',()=>{
 const text='단락의 이야기',record={assetId:'voice-sample-1',name:'보관할 음성.wav',textKey:voiceTextKey(text),settingsKey:voiceSettingsKey(base),createdAt:'2026-11-04T10:00:00.000Z',duration:1.85,settings:base};assert.deepEqual(normalizeVoiceSample(record),record);
 assert.equal(voiceTextKey('첫 줄\r\n둘째'),voiceTextKey('첫 줄\n둘째'));assert.notEqual(voiceTextKey(text),voiceTextKey(text+'변경'));assert.notEqual(voiceSettingsKey(base),voiceSettingsKey({...base,tempo:1}));
 for(const input of [{...record,blob:new Blob(['audio'])},{...record,accessToken:'secret'},{...record,duration:3601},{...record,textKey:'bad-key'},{...record,settings:{...base,apiKey:'secret'}}])assert.throws(()=>normalizeVoiceSample(input));
});
