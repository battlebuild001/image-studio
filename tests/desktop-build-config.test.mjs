import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const config=require('../electron-builder.config.cjs');
const {getAppUpdatePublishConfiguration}=require('app-builder-lib/out/publish/PublishManager.js');
const {createUpdateInfoTasks}=require('app-builder-lib/out/publish/updateInfoBuilder.js');

test('manual desktop packaging ignores developer GitHub credentials and emits no updater metadata',async()=>{
 const previous=process.env.GH_TOKEN;process.env.GH_TOKEN='synthetic-build-only-not-a-token';
 let repositoryLookups=0;
 try{
  const packager={config,platformSpecificBuildOptions:{},info:{get repositoryInfo(){repositoryLookups++;throw new Error('Manual packaging must not inspect a release provider');}}};
  assert.equal(config.publish,null);
  assert.equal(await getAppUpdatePublishConfiguration(packager,'x64',false),null);
  assert.deepEqual(await createUpdateInfoTasks({packager,arch:'x64'},null),[]);
  assert.equal(repositoryLookups,0);
 }finally{if(previous===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=previous;}
});
