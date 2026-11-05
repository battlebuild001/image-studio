import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deriveDescriptionHashtags,normalizeOwnedHashtagLine,stripOwnedDescriptionHashtags,composeDescriptionHashtags,composeDescriptionSupport,composeDescriptionChannelIntro,composeDescriptionFooters} from '../dist/description-hashtags.js';
import {SUPPORT_BLOCK,CHANNEL_INTRO_BLOCK,getDescriptionPreferences,normalizeDescriptionPreferences,setDescriptionPreferences,composeVideoDescription} from '../dist/description-preferences.js';
import {createProject,createScene,getTimeline,getCaptions} from '../dist/project.js';
const selected=['블랙아웃','BLKOUT','미니어처 게임 세계관','미니어처 게임','미니어처 워게임','테이블탑 워게임'];
const expected='#블랙아웃 #BLKOUT #미니어처게임세계관 #미니어처게임 #미니어처워게임';
const body='  새로운 행성으로 떠납니다.\r\n\r\n각 세력은 생존을 준비합니다.\n ';

test('only explicit known miniature-game selections become at most five unique Unicode-safe visible hashtags',()=>{
  assert.deepEqual(deriveDescriptionHashtags(selected),expected.split(' '));
  assert.deepEqual(deriveDescriptionHashtags(['SF','ABOL','우주 이주','블랙아웃','BLKOUT','blkout','#ＢＬＫＯＵＴ','워해머40,000','Warhammer 40,000','미니어처게임']),['#블랙아웃','#BLKOUT','#워해머40K','#Warhammer40k','#미니어처게임']);
  assert.deepEqual(deriveDescriptionHashtags([]),[]);assert.deepEqual(deriveDescriptionHashtags(['SF','LEAP']),[]);assert.throws(()=>deriveDescriptionHashtags('BLKOUT'));
});
test('owned-line metadata is exact bounded syntax and never accepts arbitrary prose, multiline content or duplicate tokens',()=>{
  for(const valid of['',expected,'#워해머40K #Warhammer40k','#미니어처_게임'])assert.equal(normalizeOwnedHashtagLine(valid),valid);
  for(const bad of[null,[],3,'BLKOUT',' #BLKOUT','#BLKOUT ','#BLKOUT\n#미니어처게임','#BLKOUT #blkout','#a #b #c #d #e #f','#'+ '가'.repeat(500),'#BLKOUT https://example.test'])assert.throws(()=>normalizeOwnedHashtagLine(bad));
});
test('hashtag application preserves manual body bytes and the exact support footer while recording only the inserted line',()=>{
  const original=body+'\n\n'+SUPPORT_BLOCK,next=composeDescriptionHashtags(original,selected);
  assert.equal(next.hashtagLine,expected);assert.equal(next.description,body+'\n\n'+expected+'\n\n'+SUPPORT_BLOCK);
  assert.equal(stripOwnedDescriptionHashtags(next.description,next.hashtagLine),original);
  assert.deepEqual(composeDescriptionHashtags(next.description,selected,{ownedLine:next.hashtagLine}),next);
  assert.equal(composeDescriptionHashtags(next.description,selected,{enabled:false,ownedLine:next.hashtagLine}).description,original);
  assert.equal(next.description.split(SUPPORT_BLOCK).length-1,1);
});
test('manually written hashtags are retained and case-insensitive duplicates are not appended or claimed as owned text',()=>{
  const manual='기록 #blkout 및 #사용자태그\n직접 작성한 문장입니다.\n\n#블랙아웃';
  const next=composeDescriptionHashtags(manual,['블랙아웃','BLKOUT','미니어처 게임']);
  assert.equal(next.hashtagLine,'#미니어처게임');assert.equal(next.description,manual+'\n\n#미니어처게임');
  assert.equal(composeDescriptionHashtags(next.description,[],{enabled:false,ownedLine:next.hashtagLine}).description,manual);
  assert.deepEqual(composeDescriptionHashtags('#BLKOUT',['BLKOUT']),{description:'#BLKOUT',hashtagLine:''});
  const fragment=composeDescriptionHashtags('기록 https://example.test/#BLKOUT',['BLKOUT']);assert.equal(fragment.hashtagLine,'#BLKOUT');
});
test('only the final exact owned line is replaced; edits, inline mentions and unrelated earlier hashtag lines remain manual',()=>{
  const original='본문\n#BLKOUT\n아직 본문입니다.\n\n#BLKOUT';assert.equal(stripOwnedDescriptionHashtags(original,'#BLKOUT'),'본문\n#BLKOUT\n아직 본문입니다.');
  for(const manual of['본문 중 #BLKOUT','본문\n\n#blkout','본문\n\n#BLKOUT #직접추가'])assert.equal(stripOwnedDescriptionHashtags(manual,'#BLKOUT'),manual);
  const edited='본문\n\n#blkout',next=composeDescriptionHashtags(edited,['BLKOUT'],{ownedLine:'#BLKOUT'});assert.deepEqual(next,{description:edited,hashtagLine:''});
  const old=composeDescriptionHashtags(body,['BLKOUT']);const changed=composeDescriptionHashtags(old.description,['에오지'],{ownedLine:old.hashtagLine});assert.equal(changed.description,body+'\n\n#에오지');assert.equal(changed.description.includes('#BLKOUT'),false);
});
test('empty selections, off state, trailing whitespace and support-only descriptions never leave orphaned automatic tags',()=>{
  assert.deepEqual(composeDescriptionHashtags(body,selected,{enabled:false}),{description:body,hashtagLine:''});
  const original=composeDescriptionHashtags(body,selected),empty=composeDescriptionHashtags(original.description,[],{ownedLine:original.hashtagLine});assert.deepEqual(empty,{description:body,hashtagLine:''});
  for(const tail of['\n','  \r\n\t'])assert.equal(stripOwnedDescriptionHashtags(original.description+tail,original.hashtagLine),body);
  const only=composeDescriptionHashtags(SUPPORT_BLOCK,['BLKOUT']);assert.equal(only.description,'#BLKOUT\n\n'+SUPPORT_BLOCK);assert.equal(stripOwnedDescriptionHashtags(only.description,only.hashtagLine),SUPPORT_BLOCK);
  const noBody=composeDescriptionHashtags('',['BLKOUT']);assert.equal(noBody.description,'#BLKOUT');assert.equal(stripOwnedDescriptionHashtags(noBody.description,noBody.hashtagLine),'');
});
test('support-only leading and trailing whitespace survives hashtag on/off without becoming owned body text',()=>{
  for(const leading of['','\n','\n\n','  \n\n','\r\n'])for(const trailing of['','\n  ']){
    const original=leading+SUPPORT_BLOCK+trailing,next=composeDescriptionHashtags(original,['BLKOUT']);
    assert.equal(next.description,leading+'#BLKOUT\n\n'+SUPPORT_BLOCK+trailing);
    assert.equal(stripOwnedDescriptionHashtags(next.description,next.hashtagLine),original);
    assert.deepEqual(composeDescriptionHashtags(next.description,['BLKOUT'],{ownedLine:next.hashtagLine}),next);
  }
});
test('support toggles compose with current hashtags without truncating manual prose, repeating the footer or changing manual hashtags',()=>{
  const manual=body+' #수동태그',on=composeDescriptionSupport(manual,true,['BLKOUT']);
  assert.equal(on.description,manual+'\n\n#BLKOUT\n\n'+SUPPORT_BLOCK);assert.equal(on.hashtagLine,'#BLKOUT');
  const off=composeDescriptionSupport(on.description,false,['BLKOUT'],{ownedLine:on.hashtagLine});assert.equal(off.description,manual+'\n\n#BLKOUT');
  assert.deepEqual(composeDescriptionSupport(off.description,true,['BLKOUT'],{ownedLine:off.hashtagLine}),on);
  const disabled=composeDescriptionSupport(on.description,true,[],{enabled:false,ownedLine:on.hashtagLine});assert.equal(disabled.description,manual+'\n\n'+SUPPORT_BLOCK);assert.equal(disabled.hashtagLine,'');
  const modified=on.description.replace('서비스하고 있습니다.','서비스합니다.');assert.ok(composeDescriptionHashtags(modified,[],{ownedLine:on.hashtagLine}).description.includes('서비스합니다.'));
});
test('the complete visible description respects the real YouTube UTF8 budget and overflow never truncates input or support copy',()=>{
  const exact='가'.repeat(1664);assert.equal(new TextEncoder().encode(exact).byteLength,4992);assert.throws(()=>composeDescriptionHashtags(exact,['BLKOUT']),/5,000바이트/u);assert.equal(exact,'가'.repeat(1664));
  const oversized=body+SUPPORT_BLOCK+'가'.repeat(2000);assert.throws(()=>composeDescriptionHashtags(oversized,[],{enabled:false}),/5,000바이트/u);
  assert.throws(()=>composeDescriptionSupport('가'.repeat(1600),true,['BLKOUT']),/5,000바이트/u);
  const ok=composeDescriptionSupport('요약입니다.',true,selected);assert.ok(new TextEncoder().encode(ok.description).byteLength<=5000);assert.ok(ok.description.endsWith(SUPPORT_BLOCK));
  assert.throws(()=>composeDescriptionHashtags(body,selected,{enabled:'false'}));
});
test('visible-hashtag preference defaults on for old projects but supports strict explicit off without mutating source media or timing',()=>{
  const project=createProject({scenes:[createScene({duration:4,imageId:'source',caption:'자막입니다.'})],audio:{narrationId:'voice',bgmId:'bgm'}}),before=structuredClone(project),timeline=getTimeline(project),captions=getCaptions(project);
  assert.deepEqual(getDescriptionPreferences(project),{length:'short',support:false,hashtags:true,channelIntro:false});assert.deepEqual(normalizeDescriptionPreferences({length:'standard',support:true}),{length:'standard',support:true,hashtags:true,channelIntro:false});assert.deepEqual(project,before);
  setDescriptionPreferences(project,{length:'short',support:false,hashtags:false});assert.equal(getDescriptionPreferences(project).hashtags,false);assert.deepEqual(project.scenes,before.scenes);assert.deepEqual(project.audio,before.audio);assert.deepEqual(getTimeline(project),timeline);assert.deepEqual(getCaptions(project),captions);
  assert.deepEqual(composeDescriptionHashtags(body,selected,{enabled:getDescriptionPreferences(project).hashtags}),{description:body,hashtagLine:''});assert.equal(composeVideoDescription('요약입니다.',getDescriptionPreferences(project)),'요약입니다.');
  for(const bad of[{hashtags:'true'},{hashtags:null},{hashtags:1},{hashtags:true,ownedLine:'#BLKOUT'}])assert.throws(()=>normalizeDescriptionPreferences(bad));
});
test('hashtags precede channel introduction and support while exact managed footer bytes survive on and off',()=>{
  for(const footers of[CHANNEL_INTRO_BLOCK,CHANNEL_INTRO_BLOCK+'\n\n'+SUPPORT_BLOCK]){
    const original=body+'\n\n'+footers+'\n\t',next=composeDescriptionHashtags(original,['BLKOUT']);
    assert.equal(next.description,body+'\n\n#BLKOUT\n\n'+footers+'\n\t');assert.equal(next.hashtagLine,'#BLKOUT');
    assert.equal(stripOwnedDescriptionHashtags(next.description,next.hashtagLine),original);assert.deepEqual(composeDescriptionHashtags(next.description,['BLKOUT'],{ownedLine:next.hashtagLine}),next);
    assert.deepEqual(composeDescriptionHashtags(next.description,[],{enabled:false,ownedLine:next.hashtagLine}),{description:original,hashtagLine:''});
    for(const leading of['','\n','  \n\n','\r\n']){
      const only=leading+footers+'\n ',withTags=composeDescriptionHashtags(only,['BLKOUT']);assert.equal(withTags.description,leading+'#BLKOUT\n\n'+footers+'\n ');assert.equal(stripOwnedDescriptionHashtags(withTags.description,withTags.hashtagLine),only);
    }
  }
});
test('channel introduction and support toggles independently preserve hashtags and canonical footer order',()=>{
  const manual=body+' #수동태그',intro=composeDescriptionChannelIntro(manual,true,['BLKOUT']);
  assert.deepEqual(intro,{description:manual+'\n\n#BLKOUT\n\n'+CHANNEL_INTRO_BLOCK,hashtagLine:'#BLKOUT'});
  const both=composeDescriptionSupport(intro.description,true,['BLKOUT'],{ownedLine:intro.hashtagLine});assert.equal(both.description,intro.description+'\n\n'+SUPPORT_BLOCK);
  const withoutSupport=composeDescriptionSupport(both.description,false,['BLKOUT'],{ownedLine:both.hashtagLine});assert.deepEqual(withoutSupport,intro);
  const withoutIntro=composeDescriptionChannelIntro(both.description,false,['BLKOUT'],{ownedLine:both.hashtagLine});assert.equal(withoutIntro.description,manual+'\n\n#BLKOUT\n\n'+SUPPORT_BLOCK);
  assert.deepEqual(composeDescriptionChannelIntro(withoutIntro.description,true,['BLKOUT'],{ownedLine:withoutIntro.hashtagLine}),both);
  assert.equal(composeDescriptionFooters(both.description,{channelIntro:false,support:false},[],{enabled:false,ownedLine:both.hashtagLine}).description,manual);
  assert.deepEqual(composeDescriptionFooters(manual,{channelIntro:true,support:true},['BLKOUT']),both);
  for(const bad of['false',null,1]){assert.throws(()=>composeDescriptionChannelIntro(manual,bad,[]));assert.throws(()=>composeDescriptionSupport(manual,bad,[]));}
});
test('edited introductions and manual mentions remain untouched when the optional exact suffix is removed',()=>{
  const edited=CHANNEL_INTRO_BLOCK.replace('댓글로 남겨 주세요.','다음에 알려 주세요.'),manual='MNN을 소개합니다.\n'+edited+'\n\n#수동태그';
  const next=composeDescriptionChannelIntro(manual,true,['BLKOUT']);assert.equal(next.description,manual+'\n\n#BLKOUT\n\n'+CHANNEL_INTRO_BLOCK);
  const off=composeDescriptionChannelIntro(next.description,false,['BLKOUT'],{ownedLine:next.hashtagLine});assert.equal(off.description,manual+'\n\n#BLKOUT');
  const owned=composeDescriptionChannelIntro(body,true,['BLKOUT']),editedOwned=owned.description.replace('댓글로 남겨 주세요.','직접 알려 주세요.');
  const unchanged=composeDescriptionHashtags(editedOwned,[],{enabled:false,ownedLine:owned.hashtagLine});assert.equal(unchanged.description,editedOwned);assert.equal(unchanged.hashtagLine,'');
});
test('complete channel footer and hashtag composition rejects overflow atomically without changing media or manual text',()=>{
  const manual='가'.repeat(1666);assert.throws(()=>composeDescriptionChannelIntro(manual,true,['BLKOUT']),/5,000바이트/u);assert.equal(manual,'가'.repeat(1666));
  const encoder=new TextEncoder(),prefix='가'.repeat(1200),fits=composeDescriptionFooters(prefix,{channelIntro:true,support:true},['BLKOUT']);assert.ok(encoder.encode(fits.description).byteLength<=5000);assert.ok(fits.description.endsWith(SUPPORT_BLOCK));
  const nearLimit='x'.repeat(5000-encoder.encode('\n\n'+CHANNEL_INTRO_BLOCK).byteLength);assert.equal(encoder.encode(nearLimit+'\n\n'+CHANNEL_INTRO_BLOCK).byteLength,5000);
  assert.throws(()=>composeDescriptionChannelIntro(nearLimit,true,['BLKOUT']),/5,000바이트/u);assert.equal(composeDescriptionChannelIntro(nearLimit,true,[],{enabled:false}).description,nearLimit+'\n\n'+CHANNEL_INTRO_BLOCK);
});
