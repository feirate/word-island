// Real local browser with controlled storage/network failures. No physical phone
// or Safari claim: the scenarios emulate restrictions found in embedded browsers.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
const budget=Number(process.env.MOBILE_NETWORK_TIMEOUT_MS||5000);
const actionable=text=>/超时|无法|不支持|失败|不可用|未能|暂时|重试/.test(text);

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
  const results=[];
  const run=async(name,exercise,init,{setup,...browserOptions}={})=>{
    if(process.env.MOBILE_NETWORK_CASE&&!name.includes(process.env.MOBILE_NETWORK_CASE))return;
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,...browserOptions});
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(String(e)));
    if(init)await context.addInitScript(init);
    if(setup)await setup(context);
    try {
      await page.goto(base);await chooseTestProfile(page,'测试');
      await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready,null,{timeout:20000});
      await exercise({context,page});
      assert.deepEqual(errors,[],'unexpected application exception');results.push({name,status:'PASS'});
    }catch(error){results.push({name,status:'FAIL',error:error.message});process.exitCode=1;}
    finally{await context.close();}
  };
  try {
    await Promise.all([
      run('pending service worker registration gets bounded feedback',async({page})=>{
        await page.locator('#parent-button').click();
        await page.locator('#prepare-offline').click();
        await page.waitForFunction(()=>document.querySelector('#offline-detail').textContent.includes('正在准备'));
        await page.waitForFunction(()=>/超时|无法|不支持|失败|不可用|未能|暂时|重试/.test(document.querySelector('#offline-detail').textContent),null,{timeout:budget});
        assert(actionable(await page.locator('#offline-detail').innerText()));
        assert.equal(await page.locator('#world-loading').isHidden(),true,'offline preparation must not block the online world');
      },()=>{
        const nativeTimeout=window.setTimeout.bind(window);
        window.setTimeout=(callback,delay,...args)=>nativeTimeout(callback,delay===45000?700:delay,...args);
        const never=new Promise(()=>{});
        Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:()=>never});
        Object.defineProperty(navigator.serviceWorker,'ready',{configurable:true,get:()=>never});
      }),
      run('pending service worker activation gets bounded feedback',async({page})=>{
        await page.locator('#parent-button').click();
        await page.locator('#prepare-offline').click();
        await page.waitForFunction(()=>document.querySelector('#offline-detail').textContent.includes('正在准备'));
        await page.waitForFunction(()=>/超时|无法|不支持|失败|不可用|未能|暂时|重试/.test(document.querySelector('#offline-detail').textContent),null,{timeout:budget});
        assert(actionable(await page.locator('#offline-detail').innerText()));
      },()=>{
        const nativeTimeout=window.setTimeout.bind(window);
        window.setTimeout=(callback,delay,...args)=>nativeTimeout(callback,delay===45000?700:delay,...args);
        const never=new Promise(()=>{});
        Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:()=>Promise.resolve({active:null})});
        Object.defineProperty(navigator.serviceWorker,'ready',{configurable:true,get:()=>never});
      }),
      run('active service worker falls back to network when Cache API rejects',async({context,page})=>{
        await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated',null,{timeout:20000});
        const worker=context.serviceWorkers()[0];assert(worker,'a real installed service worker is required');
        await worker.evaluate(()=>{
          self.__qaOriginalCacheOpen=caches.open.bind(caches);
          caches.open=()=>Promise.reject(new DOMException('Fixture: CacheStorage became unavailable','SecurityError'));
        });
        let reloadError=null;
        try {await page.reload({waitUntil:'domcontentloaded'});}catch(error){reloadError=error.message;}
        assert.equal(reloadError,null,'CacheStorage failure must not block an available online app shell');
        await page.locator('#profile-dialog').waitFor({state:'visible'});
        await chooseTestProfile(page);
        await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready,null,{timeout:20000});
      }),
      run('stalled companion preview times out and its real retry loads successfully',async({context,page})=>{
        let blocked=true;const held=[];
        await context.route('**/assets/models/companions/fox.glb',route=>{
          if(!blocked)return route.continue();
          held.push(route);
        });
        await page.locator('[data-nav="clues"]').first().click();
        await page.locator('[data-companion="fox"]').click();
        await page.locator('#companion-loading [data-action="retry-companion"]').waitFor({state:'visible',timeout:3500});
        assert(held.length>0,'the actual companion model request must have stalled');
        const failed=await page.evaluate(()=>window.__wordIsland.getCompanionDiagnostics());
        assert.match(failed.error,/超时/);
        blocked=false;
        for(const route of held)await route.abort().catch(()=>{});
        await page.locator('[data-action="retry-companion"]').click();
        await page.waitForFunction(()=>{const d=window.__wordIsland.getCompanionDiagnostics();return d?.ready&&d.id==='fox'&&!d.error;},null,{timeout:7000});
        assert(await page.locator('#companion-loading').isHidden());
      },null,{serviceWorkers:'block',setup:async context=>{
        // Configure the public constructor timeout in this fixture only; the
        // app still drives its actual selection, error overlay and retry UI.
        await context.route('**/src/app.js',async route=>{
          const response=await route.fetch(),source=await response.text();
          const constructor="new CompanionView($('#companion-preview'))";
          assert(source.includes(constructor),'the fixture must configure the actual app preview');
          await route.fulfill({response,body:source.replace(constructor,"new CompanionView($('#companion-preview'),{modelTimeoutMs:600})")});
        });
      }}),
    ]);
    console.log(JSON.stringify({results,fixtureModes:['SIMULATED unavailable worker registration/activation; exact 45000 ms deadline accelerated to 700 ms','SIMULATED active-worker CacheStorage denial with REAL local network fallback','SIMULATED hanging preview request with REAL GLB retry; constructor timeout 600 ms'],mobileEmulationOnly:true,url:base}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
