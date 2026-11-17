// A real local SW update across two app versions, using unchanged asset bytes.
// The server changes only the release version; it does not mock cache results.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const vm=require('node:vm');
const root=path.resolve(process.env.ARTIFACT_ROOT||process.cwd());
const prefix='/word-island/';

(async()=>{
  let version='0.7.0';const requests=[];
  const self={};vm.runInNewContext(await fs.readFile(path.join(root,'assets/runtime-manifest.js'),'utf8'),{self});
  const resources=Object.keys(self.WORD_ISLAND_RUNTIME.resources);
  const server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(!pathname.startsWith(prefix)){res.writeHead(404).end();return;}
    const relative=decodeURIComponent(pathname.slice(prefix.length));requests.push(relative);
    if(relative==='__cache-upgrade.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated upgrade check</title>');return;}
    const file=path.resolve(root,relative||'index.html');
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    try{
      let bytes=await fs.readFile(file);
      if(relative==='sw.js')bytes=Buffer.from(bytes.toString().replace(/const VERSION = 'v[^']+';/,`const VERSION = 'v${version}';`));
      if(relative==='assets/runtime-manifest.js')bytes=Buffer.from(bytes.toString().replace(/"version":\s*"[^"]+"/,`"version": "${version}"`));
      const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.m4a':'audio/mp4','.glb':'model/gltf-binary','.webmanifest':'application/manifest+json'}[path.extname(file)]||'application/octet-stream';
      res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(bytes);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    const base=`http://127.0.0.1:${server.address().port}${prefix}`;
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
    const context=await browser.newContext(),page=await context.newPage();
    await page.goto(`${base}__cache-upgrade.html`);
    await page.evaluate(async base=>{await navigator.serviceWorker.register(new URL('sw.js',base),{updateViaCache:'none'});await navigator.serviceWorker.ready;},base);
    await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated',null,{timeout:20000});
    const prepared=await page.evaluate(()=>{
      const channel=new MessageChannel();return new Promise(resolve=>{channel.port1.onmessage=event=>{if(event.data.type==='MODELS_CACHED'){channel.port1.close();resolve(event.data);}};navigator.serviceWorker.controller.postMessage({type:'CACHE_MODELS'},[channel.port2]);});
    });
    assert.equal(prepared.ok,true);assert.equal(prepared.version,'0.7.0');
    version='0.7.1';requests.length=0;
    await page.evaluate(async()=>{
      const previous=navigator.serviceWorker.controller;
      const changed=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}));
      const registration=await navigator.serviceWorker.getRegistration();await registration.update();
      if(navigator.serviceWorker.controller===previous)await changed;
    });
    const requestedAssets=requests.filter(file=>resources.includes(file));
    assert.deepEqual(requestedAssets,[],'an unchanged asset or hashed chunk must not be downloaded by a code-only update');
    const upgradeRequestCount=requests.length;
    await context.setOffline(true);
    const offline=await page.evaluate(async({base,resources})=>{
      let files=0;for(const file of resources){const response=await fetch(new URL(file,base));if(response.status!==200)throw new Error(`offline miss: ${file}`);await response.arrayBuffer();files++;}
      const channel=new MessageChannel();const lesson=await new Promise(resolve=>{channel.port1.onmessage=event=>{if(event.data.type==='LESSON_CACHED'){channel.port1.close();resolve(event.data);}};navigator.serviceWorker.controller.postMessage({type:'CACHE_LESSON',paths:['assets/audio/word-milk.m4a']},[channel.port2]);});
      const range=await fetch(new URL('assets/audio/word-milk.m4a',base),{headers:{Range:'bytes=0-9'}});
      return {files,lessonVersion:lesson.version,lessonReady:lesson.ok,rangeStatus:range.status,rangeBytes:(await range.arrayBuffer()).byteLength};
    },{base,resources});
    assert.equal(offline.lessonVersion,'0.7.1');assert.equal(offline.lessonReady,true);assert.equal(offline.rangeStatus,206);assert.equal(offline.rangeBytes,10);
    console.log(JSON.stringify({engine:'Chrome real local SW update; not physical iOS',artifactRoot:root,from:'0.7.0',to:'0.7.1',upgradeRequestCount,unchangedResourceDownloads:0,offline,hashedCodeResources:resources.filter(file=>/\.(js|css)$/.test(file)).length},null,2));
    await context.close();
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
