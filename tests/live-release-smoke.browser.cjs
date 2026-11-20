const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// Run the complete shared-editor workflow against the actual published bytes.
// Only this application's static origin is allowed over the network. Provider
// and Google transports remain intercepted in the underlying synthetic suite.
const filename = path.join(__dirname, 'multi-video-workflow.browser.cjs');
process.env.STUDIO_URL ||= 'https://battlebuild001.github.io/image-studio/';
let source = fs.readFileSync(filename, 'utf8');
const originalRoute = "await context.route('https://**/*',route=>{unexpected.push(route.request().url());return route.abort();});";
if (!source.includes(originalRoute)) throw new Error('Shared workflow routing changed; review live test transport before running.');
source = source.replace(originalRoute, `await context.route('https://**/*',route=>{if(new URL(route.request().url()).origin===new URL(base).origin)return route.continue();unexpected.push(route.request().url());return route.abort();});`);
source = source.replace("const errors=[],requests=[],unexpected=[],fixtures=", "const errors=[],requests=[],unexpected=[],badResources=[],fixtures=");
source = source.replace("page.on('pageerror',error=>errors.push(error.message));", "page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400&&!response.url().includes('/api/'))badResources.push({status:response.status(),url:response.url()});});");
source = source.replace("assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.equal(requests.length,0);", "assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(badResources,[]);assert.equal(requests.length,0);");
source = source.replace("const result={passed:true,", "const manifest=await page.evaluate(async()=>await(await fetch('./release.json',{cache:'no-store'})).json());const result={site:base,publishedRevision:manifest.revision,failedStaticResources:badResources.length,passed:true,");
source = source.replaceAll('/tmp/multi-video-', '/tmp/live-multi-video-');
const test = new Module(filename, module);
test.filename = filename;
test.paths = Module._nodeModulePaths(__dirname);
test._compile(source, filename);
