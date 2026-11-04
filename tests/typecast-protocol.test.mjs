import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {
  TYPECAST_MODELS,TYPECAST_DEFAULT_MODEL,TYPECAST_MAX_TEXT,TYPECAST_CHUNK_CHARACTERS,
  TYPECAST_MAX_CHUNK_AUDIO_BYTES,TypecastProtocolError,normalizeTypecastVoices,
  validateTypecastVoiceRequest,splitTypecastText,buildTypecastTtsRequest,
  assertTypecastVoiceSupport,getTypecastConfig,validateTypecastAudio,
} from '../dist/typecast-protocol.js';
const baseVoice=()=>({voice_id:'tc_6045d56d5f9ae03ac175cf73',voice_name:{eng:'Valkyrie',kor:'발키리'},voice_type:'original',models:[{version:'ssfm-v31',emotions:['normal','happy','sad','whisper']},{version:'ssfm-v30',emotions:['normal','angry']},{version:'ssfm-v21',emotions:['normal','happy','sad','angry']}],gender:'female',age:'young_adult',preview_url:'https://static2.typecast.ai/data/actor/valkyrie.mp3'});
const app=(overrides={})=>({provider:'typecast',text:'일구구일년, 새로운 항해가 시작됐습니다.',speaker:baseVoice().voice_id,...overrides});
const normalized=overrides=>validateTypecastVoiceRequest(app(overrides));
const badInput=error=>error instanceof TypecastProtocolError&&error.status===400&&error.code==='INVALID_TYPECAST_INPUT';
const badResponse=error=>error instanceof TypecastProtocolError&&error.status===502&&error.code==='INVALID_TYPECAST_RESPONSE';

test('v3 bare-array metadata keeps actual account voices/model emotions and uses localized names without inventing Korean-only language',()=>{
 const custom={...baseVoice(),voice_id:'uc_my_owned_voice',voice_name:{eng:'My voice',kor:''},voice_type:'custom',preview_url:null,models:[{version:'ssfm-v31',emotions:['happy','unknown-future-emotion']},{version:'ssfm-future',emotions:['new']}],apiKey:'provider-extra-must-not-propagate'};
 const input=[baseVoice(),custom],before=structuredClone(input),voices=normalizeTypecastVoices(input,{model:'ssfm-v31'});
 assert.deepEqual(voices.map(value=>[value.id,value.name,value.language]),[[baseVoice().voice_id,'발키리','multi'],['uc_my_owned_voice','My voice','multi']]);
 assert.deepEqual(voices[1].models,[{version:'ssfm-v31',emotions:['happy']}]);assert.equal(Object.hasOwn(voices[1],'previewUrl'),false);assert.equal(JSON.stringify(voices).includes('apiKey'),false);
 assert.equal(voices[0].previewUrl,baseVoice().preview_url);assert.deepEqual(input,before);
 assert.equal(normalizeTypecastVoices(input,{model:'ssfm-v21'}).length,1);
 assert.deepEqual(TYPECAST_MODELS,['ssfm-v31','ssfm-v30','ssfm-v21']);assert.equal(TYPECAST_DEFAULT_MODEL,'ssfm-v31');
});
test('malformed or duplicate provider metadata fails before UI hydration; unknown models do not become supported',()=>{
 for(const value of [{voices:[]},null,[null],[{...baseVoice(),voice_id:'https://example.com'}],[baseVoice(),baseVoice()],[{...baseVoice(),voice_name:'old-v2-shape'}],[{...baseVoice(),models:[{version:'ssfm-v31',emotions:'all'}]}],[{...baseVoice(),models:[baseVoice().models[0],baseVoice().models[0]]}]])assert.throws(()=>normalizeTypecastVoices(value),badResponse);
 assert.deepEqual(normalizeTypecastVoices([]),[]);
 assert.deepEqual(normalizeTypecastVoices([{...baseVoice(),models:[{version:'new-engine',emotions:[]}]}]),[]);
 assert.throws(()=>normalizeTypecastVoices([], {model:'unknown-engine'}),badInput);
});
test('preview links are optional official HTTPS samples and never arbitrary destinations or credential-bearing URLs',()=>{
 for(const url of ['https://example.com/audio.mp3','http://static2.typecast.ai/audio.mp3','https://static2.typecast.ai.attacker.example/a.mp3','https://secret@static2.typecast.ai/a.mp3','javascript:alert(1)','https://static2.typecast.ai:444/a.mp3']) {
  const voice=normalizeTypecastVoices([{...baseVoice(),preview_url:url}])[0];assert.equal(Object.hasOwn(voice,'previewUrl'),false,url);
 }
 const voice=normalizeTypecastVoices([{...baseVoice(),preview_url:'https://static.typecast.ai/data/actor/sample.mp3'}])[0];assert.equal(voice.previewUrl,'https://static.typecast.ai/data/actor/sample.mp3');
});
test('canonical Korean narration preserves exact source text and rejects legacy knobs, credentials and undocumented fields',()=>{
 const text='  첫 문장입니다.\n\t둘째 문장 😀\r\n';const value=normalized({text,tempo:.75,pitch:-12,volume:0,emotionType:'preset',emotion:'whisper',emotionIntensity:0});
 assert.equal(value.text,text);assert.equal(value.characters,Array.from(text).length);assert.equal(value.tempo,.75);assert.equal(value.volume,0);
 const defaultValue=normalized();assert.equal(defaultValue.model,'ssfm-v31');assert.equal(defaultValue.tempo,1);assert.equal(defaultValue.pitch,0);assert.equal(defaultValue.volume,100);assert.equal(defaultValue.emotionType,'smart');
 for(const extra of [{speed:0},{apiKey:'never-send'},{seed:5},{characters:100},{provider:'legacy'},{speaker:'nara'},{model:'unverified-engine'},{text:'\ud800'},{text:'no\u0000control'},{text:'   '}])assert.throws(()=>validateTypecastVoiceRequest(app(extra)),badInput);
 assert.throws(()=>validateTypecastVoiceRequest({...app(),provider:undefined}),badInput);
 assert.equal(normalized({text:'😀'.repeat(TYPECAST_MAX_TEXT)}).characters,TYPECAST_MAX_TEXT);
 assert.throws(()=>normalized({text:'😀'.repeat(TYPECAST_MAX_TEXT+1)}),badInput);
});
test('real model control ranges distinguish tempo multiples, semitone pitch, integer volume and emotion intensity',()=>{
 for(const extra of [{tempo:.49},{tempo:2.01},{tempo:'1'},{tempo:NaN},{pitch:12.1},{pitch:.5},{pitch:-13},{volume:200.1},{volume:100.5},{volume:-1},{emotionIntensity:2.01},{emotionIntensity:-.01},{emotionIntensity:Infinity},{emotionType:'freeform'},{emotion:'invented'}])assert.throws(()=>normalized(extra),badInput);
 assert.equal(normalized({tempo:2,pitch:12,volume:200,emotionIntensity:2}).emotionIntensity,2);
 const old=normalized({model:'ssfm-v21'});assert.equal(old.emotionType,'preset');
 for(const extra of [{emotionType:'smart'},{emotion:'whisper'},{emotion:'toneup'},{emotion:'tonedown'}])assert.throws(()=>normalized({model:'ssfm-v21',...extra}),badInput);
});
test('long Korean/emoji scripts split without loss and keep every provider request within the documented 2000-code-point limit',()=>{
 const source=('첫 문장은 보존합니다 😀.\n두 번째 문장도 포함합니다!  ').repeat(500),chunks=splitTypecastText(source);
 assert.equal(chunks.join(''),source);assert.ok(chunks.length>1);assert.ok(chunks.every(value=>Array.from(value).length<=TYPECAST_CHUNK_CHARACTERS));assert.ok(chunks.some(value=>value.endsWith('\n')||/[.!?。！？]$/u.test(value)||/\s$/u.test(value)));
 const graphemes='😀'.repeat(2001),emojiChunks=splitTypecastText(graphemes);assert.deepEqual(emojiChunks.map(value=>Array.from(value).length),[2000,1]);assert.equal(emojiChunks.join(''),graphemes);
 for(const limit of [0,-1,2001,1.1,'1000'])assert.throws(()=>splitTypecastText(source,limit),badInput);
 assert.equal(splitTypecastText('한 글자씩',1).join(''),'한 글자씩');
 assert.throws(()=>splitTypecastText('가'.repeat(30001)),badInput);
});
test('whitespace-only provider chunks are rejected locally without dropping any original source characters',()=>{
 const source='첫 문장입니다.'+' '.repeat(4200)+'마지막 문장입니다.',chunks=splitTypecastText(source);
 assert.equal(chunks.join(''),source);assert.ok(chunks.some(chunk=>!chunk.trim()));
 assert.throws(()=>validateTypecastVoiceRequest(app({text:source})),error=>badInput(error)&&error.message.includes('공백만 있는 긴 구간'));
 const ordinary='첫 문장입니다.\n\n다음 문장입니다.';assert.equal(normalized({text:ordinary}).text,ordinary);
});
test('ssfm-v31/v30 Smart Emotion uses adjacent context separately from spoken text with the official output controls',()=>{
 for(const model of ['ssfm-v31','ssfm-v30']) {
  const settings=normalized({model,text:'앞 문맥\n이번 문장\n다음 문맥',tempo:1.25,pitch:2,volume:120});
  const payload=buildTypecastTtsRequest(settings,'이번 문장',{previousText:'앞 문맥',nextText:'다음 문맥'});
  assert.deepEqual(payload,{voice_id:baseVoice().voice_id,model,text:'이번 문장',language:'kor',output:{audio_format:'mp3',audio_tempo:1.25,audio_pitch:2,volume:120},prompt:{emotion_type:'smart',previous_text:'앞 문맥',next_text:'다음 문맥'}});
  assert.equal(Object.hasOwn(payload,'seed'),false);assert.equal(Object.hasOwn(payload,'characters'),false);assert.equal(Object.hasOwn(payload,'provider'),false);assert.equal(Object.hasOwn(payload,'apiKey'),false);
 }
 assert.throws(()=>buildTypecastTtsRequest(normalized(), '가'.repeat(2001)),badInput);
 assert.throws(()=>buildTypecastTtsRequest(normalized(), '내용',{previousText:'가'.repeat(2001)}),badInput);
 assert.throws(()=>buildTypecastTtsRequest({...normalized(),characters:1}),badInput);
});
test('preset requests use model-specific prompt schemas and never silently enable silence removal or unsupported seed',()=>{
 const recent=buildTypecastTtsRequest(normalized({emotionType:'preset',emotion:'whisper',emotionIntensity:1.5}));
 assert.deepEqual(recent.prompt,{emotion_type:'preset',emotion_preset:'whisper',emotion_intensity:1.5});
 const old=buildTypecastTtsRequest(normalized({model:'ssfm-v21',emotion:'happy',emotionIntensity:.5}),undefined,{previousText:'not part of the older prompt'});
 assert.deepEqual(old.prompt,{emotion_preset:'happy',emotion_intensity:.5});assert.equal(Object.hasOwn(old.prompt,'emotion_type'),false);
 assert.equal(Object.hasOwn(old.output,'remove_silence_ms'),false);assert.equal(Object.hasOwn(old.output,'target_lufs'),false);
});
test('actual account voice/model/emotion capabilities gate generation before any charged request',()=>{
 const voices=normalizeTypecastVoices([baseVoice()]);assert.equal(assertTypecastVoiceSupport(normalized({emotionType:'preset',emotion:'whisper'}),voices).id,baseVoice().voice_id);
 assert.throws(()=>assertTypecastVoiceSupport(normalized({emotionType:'preset',emotion:'tonedown'}),voices),badInput);
 assert.throws(()=>assertTypecastVoiceSupport(normalized({speaker:'uc_other_account'}),voices),badInput);
 assert.throws(()=>assertTypecastVoiceSupport(normalized({model:'ssfm-v21'}),normalizeTypecastVoices([{...baseVoice(),models:[baseVoice().models[0]]}])),badInput);
 assert.throws(()=>assertTypecastVoiceSupport(normalized(),[{id:baseVoice().voice_id,models:'broken'}]),badInput);
 const smart=normalizeTypecastVoices([{...baseVoice(),models:[{version:'ssfm-v31',emotions:[]}]}]);assert.equal(assertTypecastVoiceSupport(normalized(),smart).id,baseVoice().voice_id);
});
test('configuration reports only real compatible voices and documented controls, with an honest unavailable state for empty lists',()=>{
 const voices=normalizeTypecastVoices([baseVoice()]),config=getTypecastConfig(voices);assert.equal(config.configured,true);assert.equal(config.provider,'typecast');assert.equal(config.model,'ssfm-v31');assert.equal(config.speakers[0].language,'multi');assert.deepEqual(config.capabilities.emotionTypes,['smart','preset']);assert.equal(config.capabilities.language,'kor');assert.equal(config.capabilities.audioFormat,'mp3');
 const old=getTypecastConfig(voices,'ssfm-v21');assert.deepEqual(old.capabilities.emotionTypes,['preset']);assert.deepEqual(old.capabilities.emotions,['normal','happy','sad','angry']);
 assert.equal(getTypecastConfig([]).configured,false);assert.equal(getTypecastConfig([{id:'unusable',models:[]}]).configured,false);
});
test('real WAV fixture validation respects typed-array windows and rejects truncated, empty, invalid or disguised containers',async()=>{
 const wav=await readFile(new URL('./fixtures/narration-test.wav',import.meta.url));const before=wav.slice(),value=validateTypecastAudio(wav,'audio/wav; charset=binary');assert.equal(value.mimeType,'audio/wav');assert.equal(value.bytes,wav);assert.deepEqual(wav,before);
 const surrounded=new Uint8Array(wav.length+10);surrounded.set(wav,5);assert.equal(validateTypecastAudio(surrounded.subarray(5,5+wav.length),'application/octet-stream').mimeType,'audio/wav');
 const wrongSize=wav.slice();new DataView(wrongSize.buffer,wrongSize.byteOffset,wrongSize.byteLength).setUint32(4,wav.length,true);
 const badSamples=wav.slice();new DataView(badSamples.buffer,badSamples.byteOffset,badSamples.byteLength).setUint16(32,1,true);
 for(const data of [wav.subarray(0,wav.length-1),wrongSize,badSamples,new Uint8Array(44),new Uint8Array(TYPECAST_MAX_CHUNK_AUDIO_BYTES+1),new TextEncoder().encode('{"error":"not audio"}'),new TextEncoder().encode('https://example.com/not-an-audio-file.wav')])assert.throws(()=>validateTypecastAudio(data,'audio/wav'),badResponse);
 assert.throws(()=>validateTypecastAudio(wav,'application/json'),badResponse);
});
test('MP3 validation requires a complete MPEG audio frame and safe ID3 size rather than merely trusting a file header',()=>{
 const frame=new Uint8Array(417);frame.set([255,251,144,0]);assert.equal(validateTypecastAudio(frame,'audio/mpeg').mimeType,'audio/mpeg');
 const tagged=new Uint8Array(10+frame.length);tagged.set([73,68,51,4,0,0,0,0,0,0]);tagged.set(frame,10);assert.equal(validateTypecastAudio(tagged,'audio/mp3').mimeType,'audio/mpeg');
 const badTag=tagged.slice();badTag[6]=128;
 for(const data of [frame.subarray(0,24),badTag,new Uint8Array(417).fill(255)])assert.throws(()=>validateTypecastAudio(data,'audio/mpeg'),badResponse);
});
