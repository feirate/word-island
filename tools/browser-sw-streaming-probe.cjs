// Regression: real local Service Worker/network with a controlled persistence
// delay. The production worker must deliver the complete live response first.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
  try {
    const context=await browser.newContext();
    const page=await context.newPage();
    await page.goto(base);await chooseTestProfile(page);
    await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready,null,{timeout:20000});
    await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated',null,{timeout:20000});
    const worker=context.serviceWorkers()[0];assert(worker);
    await worker.evaluate(()=>{
      let markPutStarted,markPutFinished;
      const probe=self.__streamingProbe={events:[],putStarted:new Promise(resolve=>{markPutStarted=resolve;}),putFinished:new Promise(resolve=>{markPutFinished=resolve;})};
      const mark=(type,extra={})=>probe.events.push({type,at:performance.now(),...extra});
      const nativeFetch=self.fetch.bind(self);
      self.fetch=async(input,init)=>{
        const url=typeof input==='string'?input:input.url;
        if(!url.endsWith('/assets/models/home.glb'))return nativeFetch(input,init);
        probe.request=input;mark('worker-fetch-start',{aborted:input.signal?.aborted});
        input.signal?.addEventListener('abort',()=>mark('worker-request-aborted'));
        const response=await nativeFetch(input,init);mark('worker-network-headers',{status:response.status});return response;
      };
      const nativeOpen=caches.open.bind(caches);
      caches.open=async name=>{
        const cache=await nativeOpen(name),nativePut=cache.put.bind(cache);
        cache.put=async(key,response)=>{
          const url=typeof key==='string'?key:key.url;
          if(!url.endsWith('/assets/models/home.glb'))return nativePut(key,response);
          mark('cache-put-start');markPutStarted();
          await new Promise(resolve=>{probe.release=resolve;});
          await nativePut(key,response);mark('cache-put-finished');markPutFinished();
        };
        return cache;
      };
    });
    assert.equal(await page.evaluate(async()=>Boolean(await caches.match(new URL('assets/models/home.glb',location.href).href))),false,'a real cold model-cache request is required');
    await page.evaluate(()=>{
      const probe=window.__clientProbe={state:'pending',events:[],controller:new AbortController()};
      probe.promise=fetch(new URL('assets/models/home.glb',location.href),{signal:probe.controller.signal}).then(async response=>{
        probe.state='headers';probe.events.push({type:'client-headers',at:performance.now()});
        const bytes=await response.arrayBuffer();probe.state='complete';probe.bytes=bytes.byteLength;
      }).catch(error=>{probe.state=error.name;probe.events.push({type:error.name,at:performance.now()});});
    });
    await worker.evaluate(()=>self.__streamingProbe.putStarted);
    await page.waitForTimeout(500);
    const beforePersistenceReleased=await page.evaluate(()=>({state:window.__clientProbe.state,bytes:window.__clientProbe.bytes,events:window.__clientProbe.events}));
    assert.equal(beforePersistenceReleased.state,'complete','live headers and body must not wait for background cache persistence');
    assert.equal(beforePersistenceReleased.bytes,fs.statSync(path.resolve('assets/models/home.glb')).size);
    const cachedBeforeRelease=await page.evaluate(async()=>Boolean(await caches.match(new URL('assets/models/home.glb',location.href).href)));
    assert.equal(cachedBeforeRelease,false,'the fixture must still be holding the background cache write');
    await worker.evaluate(()=>self.__streamingProbe.release());
    await worker.evaluate(()=>self.__streamingProbe.putFinished);
    await page.waitForFunction(async()=>Boolean(await caches.match(new URL('assets/models/home.glb',location.href).href)),null,{timeout:10000});
    const final=await worker.evaluate(()=>({events:self.__streamingProbe.events}));
    console.log(JSON.stringify({beforePersistenceReleased,cachedBeforeRelease,afterPersistenceReleased:final,cachedAfterRelease:true,fixture:'real production local SW/network; cache.put delayed 500ms; live response must finish before persistence',mobileDeviceClaim:false},null,2));
    await context.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
