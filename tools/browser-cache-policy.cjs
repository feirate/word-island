// Real CacheStorage/Service Worker migration and offline media verification.
// Uses an isolated blank page, never an existing child's browser profile.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const base=(process.env.PREVIEW_URL||'http://127.0.0.1:4173').replace(/\/$/,'')+'/';
const artifactRoot=process.env.ARTIFACT_ROOT||process.cwd();

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await page.route('**/__cache-policy.html',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated cache policy check</title>'}));
    await page.goto(`${base}__cache-policy.html`);
    const model='assets/models/home.glb',audio='assets/audio/word-milk.m4a';
    await page.evaluate(async({base,model,audio})=>{
      const prefix=`word-island:${base}`;
      const oldModel=await caches.open(`${prefix}models:v0.6.4`),oldShell=await caches.open(`${prefix}shell:v0.6.4`);
      await oldModel.put(new URL(model,base),await fetch(new URL(model,base)));
      await oldShell.put(new URL(audio,base),await fetch(new URL(audio,base)));
    },{base,model,audio});
    const requests=[];context.on('request',request=>requests.push(request.url()));
    await page.evaluate(async base=>{await navigator.serviceWorker.register(new URL('sw.js',base));await navigator.serviceWorker.ready;},base);
    await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated',null,{timeout:20000});
    assert.equal(requests.some(url=>/\.(?:m4a|glb)$|\/vendor\/|\/world\.js$/.test(url)),false,'installation and verified migration must not download 3D or audio');
    const installRequestCount=requests.length;
    await context.setOffline(true);
    const offline=await page.evaluate(async({base,model,audio})=>{
      const response=await fetch(new URL(model,base)),bytes=new Uint8Array(await response.arrayBuffer());
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      const media=await fetch(new URL(audio,base),{headers:{Range:'bytes=0-9'}});
      return {modelBytes:bytes.length,modelHash:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join(''),rangeStatus:media.status,rangeBytes:(await media.arrayBuffer()).byteLength,range:media.headers.get('Content-Range'),keys:await caches.keys()};
    },{base,model,audio});
    assert.equal(offline.modelBytes,fs.statSync(path.resolve(artifactRoot,model)).size);
    assert.equal(offline.modelHash,createHash('sha256').update(fs.readFileSync(path.resolve(artifactRoot,model))).digest('hex'));
    assert.equal(offline.rangeStatus,206);assert.equal(offline.rangeBytes,10);
    assert.equal(offline.keys.some(key=>key.endsWith('models:v0.6.4')||key.endsWith('shell:v0.6.4')),false);
    await context.setOffline(false);
    const lesson=await page.evaluate(async base=>{
      const paths=['assets/audio/word-rice.m4a','assets/audio/word-rice-slow.m4a'];
      async function prepare(){const channel=new MessageChannel();return new Promise(resolve=>{const messages=[];channel.port1.onmessage=event=>{messages.push(event.data);if(event.data.type==='LESSON_CACHED'){channel.port1.close();resolve(messages);}};navigator.serviceWorker.controller.postMessage({type:'CACHE_LESSON',paths},[channel.port2]);});}
      return {first:await prepare(),second:await prepare()};
    },base);
    assert.equal(lesson.first.at(-1).ok,true);assert.equal(lesson.second.at(-1).ok,true);
    for(const file of ['word-rice.m4a','word-rice-slow.m4a'])assert.equal(requests.filter(url=>url.endsWith(`/assets/audio/${file}`)).length,1,'the second preparation must reuse complete files');
    const worker=context.serviceWorkers()[0];assert(worker);
    await worker.evaluate(()=>{
      const nativeFetch=self.fetch.bind(self);
      self.__cacheProbe={fail:true,requests:[],path:'assets/audio/phrase-kb3-u8-2-slow.m4a'};
      self.fetch=(input,options)=>{
        const url=typeof input==='string'?input:input.url;
        self.__cacheProbe.requests.push(url);
        if(self.__cacheProbe.fail&&url===new URL(self.__cacheProbe.path,self.registration.scope).href)return Promise.resolve(new Response('controlled unavailable clip',{status:503}));
        return nativeFetch(input,options);
      };
    });
    async function fullPack(){return page.evaluate(()=>{
      const channel=new MessageChannel();return new Promise(resolve=>{const messages=[];channel.port1.onmessage=event=>{messages.push(event.data);if(event.data.type==='MODELS_CACHED'){channel.port1.close();resolve(messages);}};navigator.serviceWorker.controller.postMessage({type:'CACHE_MODELS'},[channel.port2]);});
    });}
    const partial=await fullPack();assert.equal(partial.at(-1).ok,false);
    assert.deepEqual(partial.at(-1).failed,['assets/audio/phrase-kb3-u8-2-slow.m4a']);
    await worker.evaluate(()=>{self.__cacheProbe.fail=false;self.__cacheProbe.requests=[];});
    const retried=await fullPack();assert.equal(retried.at(-1).ok,true);
    const retriedDownloads=await worker.evaluate(()=>self.__cacheProbe.requests);
    assert.deepEqual(retriedDownloads,[`${base}assets/audio/phrase-kb3-u8-2-slow.m4a`],'a complete-pack retry must only download the one failed clip');
    await context.setOffline(true);
    const fullOffline=await page.evaluate(async base=>{
      const manifest=await fetch(new URL('assets/runtime-manifest.js',base)).then(response=>response.text());
      const target={};new Function('self',manifest)(target);
      const paths=[...new Set([...(target.WORD_ISLAND_RUNTIME.code||['src/world.js','vendor/three.module.js']),...Object.keys(target.WORD_ISLAND_RUNTIME.resources)])];
      let count=0;for(const path of paths){const response=await fetch(new URL(path,base));if(response.status!==200)throw new Error(`offline miss: ${path}`);await response.arrayBuffer();count++;}return count;
    },base);
    console.log(JSON.stringify({engine:'Chrome, real local SW; not physical iOS',installRequestCount,installAudioOrModelDownloads:0,offline,lessonProgress:lesson.first.filter(x=>x.type==='CACHE_PROGRESS').length,repeatedLessonRequestsReused:true,fullPackFailureCorrectlyReported:true,fullPackRetryDownloads:retriedDownloads.length,fullOfflineVerifiedFiles:fullOffline},null,2));
    await context.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
