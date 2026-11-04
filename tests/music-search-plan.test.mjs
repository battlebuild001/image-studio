import test from 'node:test';
import assert from 'node:assert/strict';
import {musicSearchQueries} from '../dist/music-search-plan.js';

const recommendation=(searchQuery,overrides={})=>({title:'음악 방향',mood:'차분한',style:'',instruments:[],tempoBpm:null,searchQuery,reason:'장면의 분위기를 살려요.',...overrides});

test('keeps the original query first and broadens long orchestral searches to the same genre',()=>{
 for(const query of ['dark cinematic orchestral background music','tense dark orchestral instrumental']){
  const plan=musicSearchQueries(recommendation(query));
  assert.equal(plan[0],query);assert.equal(plan[1],'orchestral');assert.ok(plan.length<=3);
 }
 assert.deepEqual(musicSearchQueries(recommendation('orchestral')),['orchestral']);
});

test('recognizes Korean style/instrument hints and prioritizes genres over generic instrumental',()=>{
 assert.deepEqual(musicSearchQueries(recommendation('잔잔한 피아노 배경음악',{instruments:['피아노']})),['잔잔한 피아노 배경음악','piano']);
 assert.deepEqual(musicSearchQueries(recommendation('cinematic instrumental',{style:'관현악',instruments:['피아노']})),['cinematic instrumental','orchestral','piano']);
 assert.deepEqual(musicSearchQueries(recommendation('몽환적인 분위기',{style:'앰비언트',instruments:['신시사이저']})),['몽환적인 분위기','ambient','electronic']);
});

test('uses only mentioned styles with unique bounded queries and leaves unsupported directions alone',()=>{
 assert.deepEqual(musicSearchQueries(recommendation('ambient instrumental',{style:'ambient',instruments:['ambient','piano']})),['ambient instrumental','ambient','piano']);
 assert.deepEqual(musicSearchQueries(recommendation('rain nature sounds',{mood:'piano',reason:'orchestral'})),['rain nature sounds']);
 assert.deepEqual(musicSearchQueries(recommendation('cinematic suspense')),['cinematic suspense']);
 assert.deepEqual(musicSearchQueries(recommendation('soft instrumental')),['soft instrumental','instrumental']);
 assert.deepEqual(musicSearchQueries(recommendation('PIANO',{style:'piano',instruments:['pianoforte']})),['PIANO']);
 assert.equal(musicSearchQueries(recommendation('jazz ambient electronic acoustic orchestral piano instrumental')).length,3);
});

test('validates all bounded recommendation fields without mutating source or accepting extra secrets',()=>{
 const input=recommendation('calm piano',{instruments:['piano']});const before=structuredClone(input);musicSearchQueries(input);assert.deepEqual(input,before);
 for(const value of [null,{},recommendation(''),recommendation('  '),recommendation('x'.repeat(201)),recommendation('piano',{style:'x'.repeat(201)}),recommendation('piano',{instruments:new Array(13).fill('piano')}),recommendation('piano',{instruments:['x'.repeat(101)]}),recommendation('piano',{apiKey:'synthetic-not-a-real-key'})])assert.throws(()=>musicSearchQueries(value));
});

test('fallback keywords never echo free-form titles, URLs or credential-looking hint text',()=>{
 const input=recommendation('mysterious soundtrack',{style:'https://example.invalid/private?token=synthetic-secret piano',instruments:['synthetic-provider-secret ambient']});
 assert.deepEqual(musicSearchQueries(input),['mysterious soundtrack','ambient','piano']);
 assert.ok(musicSearchQueries(input).slice(1).every(query=>!/secret|token|https|provider/iu.test(query)));
});
