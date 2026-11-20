import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {copyFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {dirname,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {verifyAsar} from '../scripts/desktop-build.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const fromBuilder=createRequire(require.resolve('app-builder-lib/package.json')),asar=fromBuilder('@electron/asar');

test('Windows ASAR listings are verified with relative native paths, including nested app icons',async()=>{
 const staging=await mkdtemp(join(tmpdir(),'desktop-asar-paths-')),source=join(staging,'app'),archive=join(staging,'app.asar');
 const names=['package.json','desktop/main.cjs','desktop/preload.cjs','desktop/assets/icon.png','dist/index.html','dist/main.js','dist/production-run-engine.js','dist/scene-image-replace.js'];
 try{
  for(const name of names){await mkdir(dirname(join(source,name)),{recursive:true});await copyFile(join(root,name),join(source,name));}
  await asar.createPackage(source,archive);
  const stats=[],extracts=[],relativeNative=name=>{assert.ok(!name.startsWith(sep),'Archive paths must be relative');assert.ok(!name.includes(sep==='\\'?'/':'\\'),'ASAR methods must receive native separators');return name;};
  const wrapped={
   listPackage:file=>asar.listPackage(file).map(name=>name.replaceAll('/','\\')),
   statFile:(file,name)=>{stats.push(name);return asar.statFile(file,relativeNative(name));},
   extractFile:(file,name)=>{extracts.push(name);return asar.extractFile(file,relativeNative(name));},
  };
  const result=await verifyAsar(archive,{asar:wrapped});
  assert.equal(result.files,names.length);assert.equal(result.main,'desktop/main.cjs');assert.match(result.sha256,/^[a-f0-9]{64}$/u);
  assert.ok(stats.includes('desktop'));assert.ok(extracts.includes(['desktop','assets','icon.png'].join(sep)));
 }finally{await rm(staging,{recursive:true,force:true});}
});

test('a failed desktop build remains nonzero when later cleanup overwrites exitCode',()=>{
 const lateCleanup='data:text/javascript,'+encodeURIComponent("process.on('beforeExit',()=>{process.exitCode=0;});");
 const result=spawnSync(process.execPath,['--import',lateCleanup,join(root,'scripts/desktop-build.mjs'),'--invalid-build-option'],{cwd:root,encoding:'utf8',timeout:30000});
 assert.ifError(result.error);assert.equal(result.status,1);assert.match(result.stderr,/데스크톱 빌드 실패/u);
});
