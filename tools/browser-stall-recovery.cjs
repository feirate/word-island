// Real local camp bytes: interrupted first transfer, bounded recovery, no mock file success.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const root=process.cwd();
const assetPath=fs.existsSync('_site/assets/models/camp.glb')?'_site/assets/models/camp.glb':'assets/models/camp.glb';
const bytes=fs.readFileSync(assetPath),hash=crypto.createHash('sha256').update(bytes).digest('hex');
const counts=new Map(),connections=[],results=[];
const reportFile='/private/tmp/word-island-stall-recovery-report.json';

(async()=>{
  const server=http.createServer((request,response)=>{
    const pathname=new URL(request.url,'http://localhost').pathname;
    if(pathname.startsWith('/test/')){
      const mode=pathname.split('/')[2],attempt=(counts.get(mode)||0)+1;counts.set(mode,attempt);
      const entry={mode,attempt,closed:false};connections.push(entry);response.on('close',()=>{entry.closed=true;});
      if(mode==='not-found'){response.writeHead(404);response.end('not found');return;}
      if(mode==='invalid'){const invalid=Buffer.from('this is not a glTF model');response.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':invalid.length});response.end(invalid);return;}
      response.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':bytes.length,'Cache-Control':'no-store'});response.flushHeaders();
      const interrupted=attempt===1||['always-idle','overall'].includes(mode);
      if(!interrupted){response.end(bytes);return;}
      response.write(bytes.subarray(0,Math.floor(bytes.length/2)));
      if(mode==='disconnect'||mode==='cancel'){const timer=setTimeout(()=>response.destroy(),15);response.on('close',()=>clearTimeout(timer));}
      return;
    }
    if(pathname==='/fixture.html'){
      response.writeHead(200,{'Content-Type':'text/html'});
      response.end('<!doctype html><title>Camp transfer recovery</title><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>');return;
    }
    const file=path.resolve(root,'.'+pathname);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'application/octet-stream','Cache-Control':'no-store'});response.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--disable-background-networking']});
  try{
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
    await page.goto(base+'/fixture.html');
    await page.evaluate(()=>{
      window.completedTransfers=[];
      const open=XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open=function(method,url,...rest){
        this.addEventListener('load',()=>{
          if(this.response instanceof ArrayBuffer)window.completedTransfers.push(crypto.subtle.digest('SHA-256',this.response).then(digest=>({url:String(url),bytes:this.response.byteLength,hash:Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('')})));
        });return open.call(this,method,url,...rest);
      };
    });
    const run=async(mode,options={})=>{
      const result=await page.evaluate(async({base,mode,options})=>{
        const {loadModel}=await import('/src/model-loader.js');
        const updates=[],controller=new AbortController(),started=performance.now();let model,error;
        try{
          model=await loadModel(`${base}/test/${mode}/camp.glb`,{timeoutMs:120,maxDurationMs:1500,retryDelayMs:20,...options,signal:controller.signal,onProgress:event=>{
            updates.push(event);if(mode==='cancel'&&event.phase==='retrying')setTimeout(()=>controller.abort(),5);
          }});
        }catch(cause){error={name:cause.name,message:cause.message,details:cause.details};}
        let meshes=0;model?.scene.traverse(object=>{if(object.isMesh)meshes++;});
        const transfers=(await Promise.all(window.completedTransfers)).filter(transfer=>transfer.url.includes(`/test/${mode}/`));
        return {mode,elapsedMs:performance.now()-started,updates,error,meshes,transfers};
      },{base,mode,options});
      result.requests=counts.get(mode)||0;results.push(result);return result;
    };
    async function check(name,work){try{await work();console.log(JSON.stringify({case:name,status:'PASS'}));}catch(error){results.push({case:name,status:'FAIL',message:String(error)});console.log(JSON.stringify({case:name,status:'FAIL',message:String(error)}));}}
    const complete=result=>{
      assert.equal(result.error,undefined);assert.equal(result.requests,2);assert(result.meshes>0);
      assert.equal(result.transfers.at(-1).bytes,bytes.length);assert.equal(result.transfers.at(-1).hash,hash);
      const recovery=result.updates.find(update=>update.phase==='retrying');assert(recovery&&recovery.loaded>0);assert.equal(recovery.attempt,2);
    };
    await check('half camp then idle reconnects automatically and parses a complete real GLB',async()=>complete(await run('idle')));
    await check('half camp then connection close reconnects automatically',async()=>complete(await run('disconnect')));
    await check('two stalled attempts produce one finite failure',async()=>{
      const result=await run('always-idle');assert.equal(result.requests,2);assert.equal(result.error.name,'TimeoutError');assert.equal(result.error.details.reason,'idle-timeout');assert.equal(result.error.details.attempts,2);
    });
    await check('404 is requested once',async()=>{const result=await run('not-found');assert.equal(result.requests,1);assert.equal(result.error.details.status,404);});
    await check('a complete invalid model fails parsing once without a network retry',async()=>{const result=await run('invalid');assert.equal(result.requests,1);assert.equal(result.error.details.reason,'parse');assert.equal(result.error.details.attempts,1);});
    await check('caller abort during reconnect wait starts no second transfer',async()=>{
      const result=await run('cancel',{retryDelayMs:200});assert.equal(result.requests,1);assert.equal(result.error.name,'AbortError');assert.equal(result.error.details.attempts,1);
    });
    await check('two attempts share one overall deadline',async()=>{
      const result=await run('overall',{maxDurationMs:210});assert.equal(result.requests,2);assert.equal(result.error.details.reason,'overall-timeout');assert.equal(result.error.details.attempts,2);assert(result.elapsedMs<400);
    });
    const report={engine:'Chrome native XHR; not physical WeChat/iOS',asset:{file:assetPath,bytes:bytes.length,sha256:hash},results,connections};
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
    await context.close();assert.equal(results.filter(result=>result.status==='FAIL').length,0,reportFile);
    console.log(JSON.stringify({report:reportFile,passed:7}));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
