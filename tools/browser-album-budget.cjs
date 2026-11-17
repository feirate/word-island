const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const withWorker=process.argv.includes('--with-worker');

// Real project GLBs over a local slow connection; no child profiles or network services.
(async()=>{
 const serverTransfers={active:0,peak:0,completed:0,cancelled:0};
 const server=http.createServer((request,response)=>{
  const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
  if(pathname==='/fixture'){
   response.setHeader('Content-Type','text/html');response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#stage{height:420px}#after{height:1600px}</style><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script><div id="stage"></div><div id="after"></div>');return;
  }
  const file=path.resolve(root,pathname==='/'?'index.html':`.${pathname}`);
  if(!file.startsWith(`${root}${path.sep}`)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end();return;}
  response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.glb')?'model/gltf-binary':'text/plain');
  response.setHeader('Cache-Control','no-store');
  const body=fs.readFileSync(file);response.setHeader('Content-Length',body.length);
  if(!file.endsWith('.glb')){response.end(body);return;}
  serverTransfers.active++;serverTransfers.peak=Math.max(serverTransfers.peak,serverTransfers.active);
  let offset=0,timer,completed=false;
  const send=()=>{
   if(response.destroyed)return;
   const end=Math.min(offset+65536,body.length);response.write(body.subarray(offset,end));offset=end;
   if(offset===body.length){completed=true;response.end();}else timer=setTimeout(send,18);
  };
  timer=setTimeout(send,180);response.on('close',()=>{clearTimeout(timer);serverTransfers.active--;serverTransfers[completed?'completed':'cancelled']++;});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 let browser,context;
 const checks=[];
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
  context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/fixture`);
  if(withWorker){
   await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Fixture service worker installation timed out')),10000))]);});
   await page.reload();await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
  }
  await page.evaluate(async()=>{
   window.transfer={active:0,peak:0,aborted:0};
   const originalSend=XMLHttpRequest.prototype.send,originalOpen=XMLHttpRequest.prototype.open;
   XMLHttpRequest.prototype.open=function(method,url,...args){this.albumModel=String(url).includes('.glb');return originalOpen.call(this,method,url,...args);};
   XMLHttpRequest.prototype.send=function(...args){
    if(this.albumModel){window.transfer.active++;window.transfer.peak=Math.max(window.transfer.peak,window.transfer.active);this.addEventListener('loadend',()=>window.transfer.active--,{once:true});this.addEventListener('abort',()=>window.transfer.aborted++,{once:true});}
    return originalSend.apply(this,args);
   };
   const {CompanionView}=await import('/src/companion-view.js');
   window.albumErrors=[];window.album=new CompanionView(document.getElementById('stage'),{onError:error=>window.albumErrors.push(error.message)});await window.album.ready;
   window.select=id=>window.album.setCompanion(id,false).catch(error=>{throw error;});
   window.results=[];
  });
  const selected=async id=>{await page.evaluate(id=>window.select(id),id);await page.waitForFunction(id=>{const d=window.album.getDiagnostics();return d.ready&&d.id===id;},id);};
  const makeCold=async id=>page.evaluate(async id=>{
   for(const name of await caches.keys()){
    const cache=await caches.open(name);
    for(const request of await cache.keys())if(new URL(request.url).pathname.endsWith(`/${id}.glb`))await cache.delete(request);
   }
  },id);
  for(const id of ['bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox']){
   await page.evaluate(id=>{window.results.push(window.select(id));},id);await page.waitForTimeout(25);
  }
  await page.evaluate(()=>Promise.all(window.results));
  const rapid=await page.evaluate(()=>({transfer:{...window.transfer},...window.album.getDiagnostics()}));
  assert.equal(rapid.transfer.peak,1,'rapidly choosing companions must keep at most one native model request active');
  assert(rapid.transfer.aborted>=6,'obsolete model downloads must be aborted');
  assert.equal(rapid.id,'fox');assert.equal(rapid.ready,true);assert.deepEqual(await page.evaluate(()=>window.albumErrors),[]);
  checks.push('rapid selection: one native XHR, obsolete requests aborted, final fox shown');

  for(const id of ['bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox']){
   await selected(id);
   const d=await page.evaluate(()=>window.album.getDiagnostics());
   assert(d.cachedModels.length<=2,'loaded companion GPU entries must be bounded to two');
   assert.equal(d.gray,true);assert(d.materialColors.every(c=>Math.abs(c[0]-c[1])<.0001&&Math.abs(c[1]-c[2])<.0001));
  }
  checks.push('all eight real grey models, bounded two-entry cache, evicted model reload');
  await page.evaluate(()=>window.album.setCompanion('fox',true));
  const colored=await page.evaluate(()=>window.album.getDiagnostics());assert.equal(colored.gray,false);assert(colored.materialColors.some(c=>Math.abs(c[0]-c[1])>.02));
  checks.push('unlocked preview restores original colors');

  await makeCold('bunny');await page.evaluate(()=>{window.results=[window.select('bunny')];});
  await page.waitForFunction(()=>window.transfer.active===1);
  await page.evaluate(()=>window.album.setActive(false));
  await page.evaluate(()=>Promise.all(window.results));
  assert.equal(await page.evaluate(()=>window.transfer.active),0,'leaving the album cancels current transfer');
  await page.evaluate(()=>window.album.setActive(true));await selected('bunny');
  checks.push('leaving album cancels page request; returning can load again');

  await page.waitForTimeout(200);const before=await page.evaluate(()=>window.album.getDiagnostics().frames);await page.waitForTimeout(1100);const after=await page.evaluate(()=>window.album.getDiagnostics().frames);
  assert(after>before&&after-before<=35,`mobile active render budget should be 30fps (observed ${after-before}/1.1s)`);
  assert.equal(await page.evaluate(()=>window.album.renderer.getPixelRatio()),1);
  checks.push('mobile frame and pixel budgets');
  await page.waitForTimeout(5100);const idleBefore=await page.evaluate(()=>window.album.getDiagnostics().frames);await page.waitForTimeout(1100);const idleAfter=await page.evaluate(()=>window.album.getDiagnostics().frames);
  assert(idleAfter>idleBefore&&idleAfter-idleBefore<=16,'idle preview must keep gentle motion within a 12fps budget');
  await page.touchscreen.tap(180,180);const wakeBefore=await page.evaluate(()=>window.album.getDiagnostics().frames);await page.waitForTimeout(1100);const wakeAfter=await page.evaluate(()=>window.album.getDiagnostics().frames);
  assert(wakeAfter-wakeBefore>idleAfter-idleBefore,'touching the preview restores the active animation budget');
  checks.push('idle animation budget and touch wake');
  await page.evaluate(()=>scrollTo(0,1100));await page.waitForTimeout(150);
  const hiddenFrames=await page.evaluate(()=>window.album.getDiagnostics().frames);await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>window.album.getDiagnostics().frames),hiddenFrames);
  await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(150);
  assert((await page.evaluate(()=>window.album.getDiagnostics().frames))>hiddenFrames);
  checks.push('out-of-viewport render pause and resume');

  await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(200);const still=await page.evaluate(()=>window.album.getDiagnostics().frames);await page.waitForTimeout(350);assert.equal(await page.evaluate(()=>window.album.getDiagnostics().frames),still);
  await page.evaluate(()=>window.album.resetCamera());await page.waitForTimeout(150);assert((await page.evaluate(()=>window.album.getDiagnostics().frames))>still);
  checks.push('reduced-motion draws on demand and camera interaction still redraws');

  await makeCold('cat');await page.evaluate(()=>{window.results=[window.select('cat')];});await page.waitForFunction(()=>window.transfer.active===1);
  await page.evaluate(()=>window.album.dispose());await page.evaluate(()=>Promise.all(window.results));
  assert.equal(await page.evaluate(()=>window.transfer.active),0);assert.equal(await page.locator('#stage canvas').count(),0);assert.deepEqual(errors,[]);
  assert.deepEqual(await page.evaluate(()=>window.albumErrors),[]);
  checks.push('dispose cancels page request and removes renderer without late errors');
  console.log(JSON.stringify({withWorker,passed:checks,rapid,serverTransfersBeforeContextClose:serverTransfers,budgets:{activeFrames:after-before,idleFrames:idleAfter-idleBefore,touchFrames:wakeAfter-wakeBefore,windowMs:1100},errors}));
 }finally{await context?.close();await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
