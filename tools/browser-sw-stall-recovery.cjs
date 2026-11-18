// Real production SW + real camp bytes. No mocked successful model responses.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const root=process.cwd(),artifact=path.resolve(process.env.ARTIFACT_ROOT||'_site');
const modelFile='assets/models/camp.glb',bytes=fs.readFileSync(path.join(artifact,modelFile));
const expectedHash=crypto.createHash('sha256').update(bytes).digest('hex');
const connections=[];let live=0,peak=0,modelRequests=0;
const reportPath='/private/tmp/word-island-sw-stall-recovery-report.json';
const mime={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.glb':'model/gltf-binary'};

(async()=>{
  const server=http.createServer((request,response)=>{
    const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
    if(pathname==='/'+modelFile){
      const entry={attempt:++modelRequests,closed:false,forcedIncompleteEnd:false,response};connections.push(entry);live++;peak=Math.max(peak,live);
      response.on('close',()=>{if(!entry.closed){entry.closed=true;live--;}});
      response.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':bytes.length,'Cache-Control':'no-store'});response.flushHeaders();
      if(entry.attempt===1)response.write(bytes.subarray(0,Math.floor(bytes.length/2)));
      else response.end(bytes);
      return;
    }
    if(pathname==='/fixture.html'){
      response.writeHead(200,{'Content-Type':'text/html'});
      response.end('<!doctype html><title>Controlled model recovery</title><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>');return;
    }
    // Execute the current unbundled helper with a short test budget; the SW,
    // content manifest and all installed shell files are actual build output.
    const sourceModule=pathname==='/src/model-loader.js'||pathname.startsWith('/vendor/');
    const file=path.resolve(sourceModule?root:artifact,'.'+(pathname==='/'?'/index.html':pathname));
    const permitted=sourceModule?root:artifact;
    if(!file.startsWith(permitted+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});response.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--disable-background-networking']});
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await page.goto(base+'/fixture.html');
    await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'});await navigator.serviceWorker.ready;});
    await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated',null,{timeout:15000});
    assert.equal(modelRequests,0,'minimal installation must leave this model genuinely cold');
    const worker=context.serviceWorkers()[0];assert(worker);
    const identity=await worker.evaluate(file=>({version:self.WORD_ISLAND_RUNTIME.version,revision:self.WORD_ISLAND_RUNTIME.resources[file],key:new URL(file,self.registration.scope).href+'?asset='+self.WORD_ISLAND_RUNTIME.resources[file]}),modelFile);
    assert.equal(identity.revision,expectedHash);assert.equal(await page.evaluate(async key=>Boolean(await caches.match(key)),identity.key),false);
    await worker.evaluate(()=>{
      self.__campWrites=[];const seen=new WeakSet(),open=caches.open.bind(caches);
      caches.open=async name=>{
        const cache=await open(name);if(seen.has(cache))return cache;seen.add(cache);
        const put=cache.put.bind(cache);cache.put=async(key,response)=>{
          const url=typeof key==='string'?key:key.url;
          if(!new URL(url).pathname.endsWith('/assets/models/camp.glb'))return put(key,response);
          const entry={key:url,finished:false};self.__campWrites.push(entry);
          await put(key,response);entry.finished=true;
        };return cache;
      };
    });
    const recovered=await page.evaluate(async url=>{
      const {loadModel}=await import('/src/model-loader.js');const progress=[];
      const model=await loadModel(url,{timeoutMs:300,retryDelayMs:25,maxDurationMs:4000,onProgress:event=>progress.push(event)});
      let meshes=0;model.scene.traverse(object=>{if(object.isMesh)meshes++;});return {progress,meshes};
    },base+'/'+modelFile);
    assert.equal(modelRequests,2);assert(recovered.meshes>0);assert(recovered.progress.some(event=>event.phase==='retrying'&&event.attempt===2&&event.loaded>0));
    await page.waitForFunction(async key=>Boolean(await caches.match(key)),identity.key,{timeout:5000});
    const readCache=()=>page.evaluate(async key=>{const response=await caches.match(key),data=await response.arrayBuffer();return {status:response.status,bytes:data.byteLength,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('')};},identity.key);
    const beforeOldEnds=await readCache();assert.equal(beforeOldEnds.bytes,bytes.length);assert.equal(beforeOldEnds.sha256,expectedHash);
    const oldStillOpenAfterRecovery=!connections[0].closed;
    // End only our own deliberately stalled response with its existing half
    // body. Its advertised full Content-Length must not become a valid cache.
    if(oldStillOpenAfterRecovery){
      connections[0].forcedIncompleteEnd=true;
      const socket=connections[0].response.socket;
      connections[0].response.end(()=>socket?.destroy());
    }
    await page.waitForTimeout(250);
    assert.equal(connections[0].closed,true,'our incomplete first response must have ended before the cache check');
    const writes=await worker.evaluate(()=>self.__campWrites);assert.equal(writes.length,1);assert.equal(writes[0].finished,true);
    const afterOldEnds=await readCache();assert.deepEqual(afterOldEnds,beforeOldEnds);
    await context.setOffline(true);
    const offline=await page.evaluate(async url=>{
      const response=await fetch(url,{cache:'no-store'}),data=await response.arrayBuffer();
      return {status:response.status,bytes:data.byteLength,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('')};
    },base+'/'+modelFile);
    assert.equal(offline.status,200);assert.equal(offline.bytes,bytes.length);assert.equal(offline.sha256,expectedHash);assert.equal(modelRequests,2);
    const report={engine:'Chrome native XHR and real production SW; not physical iOS/WeChat',version:identity.version,asset:{bytes:bytes.length,sha256:expectedHash},modelRequests,serverPeakActiveModelTransfers:peak,oldStillOpenAfterRecovery,connections:connections.map(({response,...entry})=>entry),meshes:recovered.meshes,progress:recovered.progress,cacheWrites:writes,beforeOldEnds,afterOldEnds,offline};
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:['real SW cold half-body idle reconnect','complete GLB parsed','only complete verified cache write','old incomplete response cannot poison cache','offline exact bytes/hash'],modelRequests,serverPeakActiveModelTransfers:peak,oldStillOpenAfterRecovery,bytes:offline.bytes,report:reportPath}));
    await context.close();
  }finally{
    for(const entry of connections)if(!entry.closed)entry.response.destroy();
    await browser.close();await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
