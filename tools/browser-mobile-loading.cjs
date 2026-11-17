// Local-only regression for mobile first-paint/loading failures; no real learner data.
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173/';
const observations=[],failures=[];
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
 const make=async()=>{const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce',serviceWorkers:'block'});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));return {context,page,errors};};
 const start=async page=>{await page.goto(base);await page.locator('#profile-dialog').waitFor({state:'visible'});await page.locator('#profile-name').fill('加载测试');await page.locator('#create-profile').tap();await page.locator('#profile-dialog').waitFor({state:'hidden'});};
 const retry=page=>page.locator('#world-loading button').filter({hasText:/重新|重试|再试/}).first();
 const inspect=async(page,label)=>page.evaluate(label=>({label,loadingVisible:!document.querySelector('#world-loading').hidden,loadingText:document.querySelector('#world-loading').innerText,retryVisible:[...document.querySelectorAll('#world-loading button')].some(button=>/重新|重试|再试/.test(button.textContent)&&button.getClientRects().length),diagnostics:window.__wordIsland?.world.getDiagnostics()}),label);
 const ready=page=>page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready,null,{timeout:15000});
 try{
  for(const [label,file,expectedReady] of [['unearned-fox-pending','companions/fox.glb',true],['home-pending','home.glb',false]]){
   const {context,page,errors}=await make();let release,requested=false;const latch=new Promise(resolve=>{release=resolve;});
   await page.route(`**/assets/models/${file}`,async route=>{requested=true;await latch;await route.continue().catch(()=>{});});
   try{
    await start(page);await page.waitForFunction(()=>window.__wordIsland);for(let i=0;i<40&&!requested;i++)await wait(50);if(!expectedReady)assert(requested,`${label} must reach the withheld real asset request`);await wait(2200);
    const before=await inspect(page,label);observations.push({...before,errors:[...errors]});await page.screenshot({path:`/private/tmp/word-island-${label}.png`});
    if(expectedReady&&!before.diagnostics.ready)failures.push('an unearned partner request blocks the initial home scene');
    release();await ready(page);observations.push({...await inspect(page,`${label}-released`),errors:[...errors]});
   }finally{release();await context.close();}
  }
  {
   const {context,page,errors}=await make();let failing=true;await page.route('**/assets/models/home.glb',async route=>failing?route.abort('failed'):route.continue());
   try{await start(page);await retry(page).waitFor({state:'visible'});observations.push({...await inspect(page,'home-failed'),errors:[...errors]});await page.locator('#world-loading details summary').tap();const detailsText=await page.locator('#world-loading details pre').innerText(),details=JSON.parse(detailsText);assert.match(details.version,/^\d+\.\d+\.\d+$/);assert.equal(details.reason,'network');assert(Number.isFinite(details.elapsedMs));assert(!detailsText.includes('加载测试'),'load diagnostics must not contain the selected child name');observations.push({label:'visible-private-free-load-diagnostics',version:details.version,reason:details.reason,phase:details.phase,loaded:details.loaded,errors:[...errors]});await page.screenshot({path:'/private/tmp/word-island-model-error-details.png'});failing=false;await retry(page).tap();if(await page.locator('#profile-dialog').isVisible())await page.locator('[data-profile-select]').first().tap();await ready(page);observations.push({...await inspect(page,'home-failed-retried'),errors:[...errors]});}finally{await context.close();}
  }
  {
   const {context,page,errors}=await make();await page.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:get.call(this,type,...args);};});
   try{await start(page);await retry(page).waitFor({state:'visible'});const unavailable=await inspect(page,'webgl2-unavailable');observations.push({...unavailable,errors:[...errors]});if(!unavailable.loadingVisible||!unavailable.retryVisible)failures.push('no WebGL2 has no visible recovery message');await page.locator('.main-nav [data-nav="camp"]').tap();await page.locator('[data-task="listen"]').tap();await page.locator('[data-answer]').first().waitFor({state:'visible'});observations.push({label:'no-webgl2-learning-fallback',phase:await page.evaluate(()=>window.__wordIsland.getState().phase),errors:[...errors]});}finally{await context.close();}
  }
  {
   const {context,page,errors}=await make();try{await start(page);await ready(page);await page.evaluate(()=>document.querySelector('#world-canvas canvas').dispatchEvent(new Event('webglcontextlost',{cancelable:true})));const lost=await inspect(page,'context-lost-after-ready');observations.push({...lost,errors:[...errors]});await page.screenshot({path:'/private/tmp/word-island-context-lost.png'});if(!lost.loadingVisible||!lost.retryVisible)failures.push('context loss after first paint hides the recovery message');}finally{await context.close();}
  }
  {
   // Exercise the actual WorldView loader with a short explicit budget, not fake timers.
   const {context,page,errors}=await make();let hold=true,release;const latch=new Promise(resolve=>{release=resolve;});
   await page.route('**/assets/models/home.glb',async route=>{if(hold)await latch;await route.continue().catch(()=>{});});
   try{
    await page.goto(new URL('vendor/THREE-LICENSE.txt',base).href);
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><script type="importmap">{"imports":{"three":"${new URL('vendor/three.module.js',base).href}"}}</script><div id="stage" style="width:360px;height:460px"></div>`);
    const started=Date.now();
    await page.evaluate(async base=>{const {WorldView}=await import(new URL('src/world.js',base).href);window.loadEvents=[];window.loadingWorld=new WorldView(document.getElementById('stage'),{modelTimeoutMs:600,onLoading:value=>window.loadEvents.push({event:'loading',...value}),onReady:()=>window.loadEvents.push({event:'ready'}),onSceneReady:value=>window.loadEvents.push({event:'scene-ready',...value}),onAssetError:(error,value)=>window.loadEvents.push({event:'asset-error',message:error.message,...value}),onError:error=>window.loadEvents.push({event:'error',message:error.message})});window.loadingWorld.ready.catch(error=>window.loadEvents.push({event:'ready-rejected',message:error.message}));},base);
    let timedOut=false;await page.waitForFunction(()=>Boolean(window.loadingWorld.getDiagnostics().error),null,{timeout:4000}).catch(()=>{timedOut=true;});
    const failed=await page.evaluate(()=>({diagnostics:window.loadingWorld.getDiagnostics(),events:window.loadEvents}));observations.push({label:'core-600ms-timeout',elapsedMs:Date.now()-started,...failed,errors:[...errors]});
    if(timedOut)failures.push('a hanging core model has no bounded timeout');
    hold=false;release();
    const retried=await page.evaluate(async()=>{if(typeof window.loadingWorld.retryLoads!=='function')return {supported:false};try{await window.loadingWorld.retryLoads();return {supported:true,diagnostics:window.loadingWorld.getDiagnostics()};}catch(error){return {supported:true,error:error.message,diagnostics:window.loadingWorld.getDiagnostics()};}});
    observations.push({label:'core-timeout-retry',...retried,errors:[...errors]});
    if(!retried.supported||!retried.diagnostics?.ready||retried.error)failures.push('core model timeout cannot recover through retryLoads');
   }finally{release();await context.close();}
  }
  const result={webkit:{path:webkit.executablePath(),installed:fs.existsSync(webkit.executablePath())},observations,failures};fs.writeFileSync('/private/tmp/word-island-mobile-loading-report.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify({webkit:result.webkit,observations:observations.map(o=>({label:o.label,ready:o.diagnostics?.ready,loadingVisible:o.loadingVisible,retryVisible:o.retryVisible,error:o.diagnostics?.error,errors:o.errors})),failures,report:'/private/tmp/word-island-mobile-loading-report.json'}));assert.deepEqual(failures,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
