// Actual local HTTP + Service Worker: scene downloads precede optional audio packs.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const root=path.resolve(process.env.ARTIFACT_ROOT||process.cwd());
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.glb':'model/gltf-binary','.m4a':'audio/mp4'};
const report={engine:'Chrome mobile emulation, actual local SW; not physical iOS',root,checkpoints:[],errors:[]};
let stage='install',failModels=false;
const blocked=new Set(['home.glb','hero.glb','child.glb','camp.glb']),held=new Set(),requests=[];
const audio=()=>requests.filter(request=>request.file.endsWith('.m4a'));
function release(names){for(const name of names)blocked.delete(name);for(const entry of [...held])if(!blocked.has(entry.name)){held.delete(entry);entry.send();}}
function checkpoint(name,extra={}){const state={name,audioRequests:audio().length,...extra};report.checkpoints.push(state);return state;}

(async()=>{
 const server=http.createServer((request,response)=>{
  const pathname=decodeURIComponent(new URL(request.url,'http://local').pathname),file=path.resolve(root,`.${pathname==='/'?'/index.html':pathname}`);
  if(!file.startsWith(root+path.sep)){response.writeHead(403);response.end();return;}
  requests.push({file:pathname,stage});
  fs.readFile(file,(error,bytes)=>{
   if(error){response.writeHead(404);response.end();return;}
   const send=()=>{if(!response.destroyed){response.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':bytes.length});response.end(bytes);}};
   if(file.endsWith('.glb')){
    if(failModels){response.writeHead(503);response.end('controlled unavailable model');return;}
    const name=path.basename(file);
    if(blocked.has(name)){const entry={name,send};held.add(entry);response.on('close',()=>held.delete(entry));return;}
   }
   send();
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}/`;
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
 async function fresh(){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await context.addInitScript(()=>{
   localStorage.setItem('word-island:guide:v1','{"version":1,"status":"skipped","intro":0}');
   window.__cacheRequests=[];window.__realPlays=[];
   const post=ServiceWorker.prototype.postMessage;
   ServiceWorker.prototype.postMessage=function(message,...args){window.__cacheRequests.push({type:message?.type,paths:message?.paths,phase:window.__wordIsland?.getState().phase});return post.call(this,message,...args);};
   const play=HTMLMediaElement.prototype.play;
   HTMLMediaElement.prototype.play=function(...args){const item={src:this.currentSrc||this.src,started:false};window.__realPlays.push(item);const result=play.apply(this,args);result?.then(()=>{item.started=true;item.duration=this.duration;},error=>{item.error=error.name;});return result;};
  });
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated',null,{timeout:15000});
  return {context,page};
 }
 async function noPreparation(page,name){
  await page.waitForTimeout(700);
  const messages=await page.evaluate(()=>window.__cacheRequests.filter(message=>message.type==='CACHE_LESSON'));
  checkpoint(name,{lessonMessages:messages.length});
  assert.equal(messages.length,0,`${name}: no optional lesson request may compete with the scene`);
  assert.equal(audio().length,0,`${name}: no audio body may download before a lesson starts with a ready scene`);
 }
 async function realPlay(page){
  await page.locator('[data-action="play-word"]').click();
  await page.waitForFunction(()=>window.__realPlays.some(play=>play.started&&Number.isFinite(play.duration)&&play.duration>0));
 }
 try{
  const first=await fresh(),page=first.page;
  assert.equal(audio().length,0,'installation only prepares the small learning shell');
  stage='home-pending';await chooseTestProfile(page,'错峰测试');
  await page.waitForFunction(()=>window.__wordIsland.getDiagnostics().loadingModels.length>0);
  await noPreparation(page,'home-pending');
  release(['home.glb','hero.glb','child.glb']);
  await page.waitForFunction(()=>window.__wordIsland.getDiagnostics().sceneReady);
  stage='home-ready';await noPreparation(page,'home-ready');
  stage='camp-pending';await page.locator('.main-nav [data-nav="camp"]').click();
  await page.waitForFunction(()=>window.__wordIsland.getDiagnostics().loadingModels.includes('camp'));
  await noPreparation(page,'camp-pending');
  release(['camp.glb']);await page.waitForFunction(()=>window.__wordIsland.getDiagnostics().scene==='camp'&&window.__wordIsland.getDiagnostics().sceneReady);
  stage='camp-overview';await noPreparation(page,'camp-overview');
  stage='lesson';await page.locator('#notebook-content [data-task="listen"]').click();
  await page.waitForFunction(()=>window.__cacheRequests.some(message=>message.type==='CACHE_LESSON'));
  await realPlay(page);checkpoint('lesson-ready',{realPlayback:true});
  await first.context.close();

  failModels=true;requests.length=0;stage='failed-scene';
  const second=await fresh(),failure=second.page;await chooseTestProfile(failure,'先学测试');
  await failure.locator('#world-loading[data-state="error"]').waitFor();
  await failure.locator('#world-loading [data-action="start-learning"]').click();
  await failure.locator('[data-answer]').first().waitFor();await noPreparation(failure,'failed-scene-lesson');
  await realPlay(failure);assert(audio().length>0,'requested single-word audio must still play with a failed scene');
  assert.equal(await failure.evaluate(()=>window.__cacheRequests.some(message=>message.type==='CACHE_LESSON')),false);
  checkpoint('failed-scene-manual-play',{realPlayback:true});
  await failure.locator('#parent-button').click();await failure.locator('#prepare-offline').click();
  await failure.waitForFunction(()=>window.__cacheRequests.some(message=>message.type==='CACHE_MODELS'));
  await failure.waitForFunction(()=>!document.querySelector('#prepare-offline').disabled);
  assert(audio().length>20,'explicit full-pack preparation remains available regardless of scene state');
  assert((await failure.locator('#offline-detail').textContent()).includes('尚未准备好'),'unavailable models must not claim complete offline readiness');
  checkpoint('explicit-full-pack',{stillAvailable:true});await second.context.close();

  failModels=false;requests.length=0;blocked.add('camp.glb');stage='early-lesson';
  const third=await fresh(),early=third.page;await chooseTestProfile(early,'边等边学');
  await early.waitForFunction(()=>window.__wordIsland.getDiagnostics().sceneReady);
  await early.locator('.main-nav [data-nav="camp"]').click();
  await early.waitForFunction(()=>window.__wordIsland.getDiagnostics().loadingModels.includes('camp'));
  await early.locator('#notebook-content [data-task="listen"]').click();await early.locator('[data-answer]').first().waitFor();
  await noPreparation(early,'lesson-before-camp-ready');
  release(['camp.glb']);await early.waitForFunction(()=>window.__wordIsland.getDiagnostics().sceneReady);
  await early.waitForFunction(()=>window.__cacheRequests.some(message=>message.type==='CACHE_LESSON'));
  checkpoint('scene-ready-resumes-lesson-pack',{phase:await early.evaluate(()=>window.__wordIsland.getState().phase)});
  await third.context.close();
  assert.deepEqual(report.errors,[]);console.log(JSON.stringify(report));
 }catch(error){report.failure=String(error);report.requests=requests;console.error(JSON.stringify(report));throw error;}
 finally{fs.writeFileSync('/private/tmp/word-island-scene-priority-report.json',JSON.stringify(report,null,2));await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
