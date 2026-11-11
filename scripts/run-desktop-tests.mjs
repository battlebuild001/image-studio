import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),allowed=new Set(['--smoke','--export']);
if(args.some(value=>!allowed.has(value))||args.length>1)throw new Error('Usage: node scripts/run-desktop-tests.mjs [--smoke|--export]');
const selected=args[0]==='--smoke'?['desktop-app.browser.cjs']:args[0]==='--export'?['desktop-export.browser.cjs']:['desktop-app.browser.cjs','desktop-export.browser.cjs'];
const env={...process.env};let displayProcess;
function command(command,args,options={}){return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,env,stdio:'inherit',...options});child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${command} exited with ${signal||code}`)));});}
try{
 if(process.platform==='linux'&&!env.DISPLAY){
  const executable=['/usr/bin/Xvfb','/usr/local/bin/Xvfb'].find(existsSync);
  if(!executable)throw new Error('Electron GUI tests need DISPLAY or Xvfb. Install xvfb, or run under xvfb-run.');
  // Use a private display instead of sharing a production browser's display.
  let display=90;while(display<200&&(existsSync('/tmp/.X'+display+'-lock')||existsSync('/tmp/.X11-unix/X'+display)))display++;
  if(display===200)throw new Error('No unused test display is available.');
  env.DISPLAY=':'+display;displayProcess=spawn(executable,[env.DISPLAY,'-screen','0','1920x1080x24','-nolisten','tcp'],{stdio:'ignore'});
  const startupFailure=new Promise((_,reject)=>{displayProcess.once('error',reject);displayProcess.once('exit',(code,signal)=>reject(new Error('Xvfb stopped before tests started: '+(signal||code))));});
  await Promise.race([startupFailure,(async()=>{for(let at=0;at<100;at++){if(existsSync('/tmp/.X11-unix/X'+display))return;await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Xvfb did not become ready.');})()]);
 }
 console.log('Running actual Electron tests on '+os.platform()+'; native Windows execution is only reported when the host is Windows.');
 // Export owns the compositor and audio recorder; never run these in parallel.
 for(const filename of selected)await command(process.execPath,[path.join(root,'tests',filename)]);
}finally{displayProcess?.kill('SIGTERM');}
