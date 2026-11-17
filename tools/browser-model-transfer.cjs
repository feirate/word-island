// Diagnostic only: real local/CDN bytes and an actual continuously progressing HTTP body.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const zlib=require('node:zlib');
const assert=require('node:assert/strict');
const root=process.cwd(),asset=fs.readFileSync(path.join(root,'assets/models/home.glb'));
const fullDeadline=process.argv.includes('--full-deadline'),localOnly=process.argv.includes('--local-only');
const slowChunk=fullDeadline?32768:131072,slowInterval=fullDeadline?700:100,idleBudget=fullDeadline?30000:600;
const expectedHash=crypto.createHash('sha256').update(asset).digest('hex');
const compressedAsset=zlib.gzipSync(asset,{level:9});
const helperSnapshot=fs.readFileSync(path.join(root,'src/model-loader.js'));
const report={engine:'existing Chrome; not iOS/WebKit',serviceWorkers:'blocked for transport isolation',asset:{bytes:asset.length,sha256:expectedHash},gzipFixture:{contentEncoding:'gzip',contentLength:compressedAsset.length,decodedBytes:asset.length},loaderSha256:crypto.createHash('sha256').update(helperSnapshot).digest('hex'),transfers:[],failures:[]};
const reportPath='/private/tmp/word-island-model-transfer-report.json';
const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
(async()=>{
 const fixtureModes=new Map([['continuous','slow'],['gzip','gzip-slow'],['body','body-stall'],['headers','headers-stall'],['hard','slow'],['cancel','slow'],['fallback','normal']]);
 const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname.startsWith('/fixture-model/')){
   const mode=fixtureModes.get(pathname.split('/')[2])||'normal';
   if(mode==='headers-stall')return;
   const payload=mode==='gzip-slow'?compressedAsset:asset;
   res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Length':payload.length,'Cache-Control':'no-store',...mode==='gzip-slow'?{'Content-Encoding':'gzip'}:{}});res.flushHeaders();
   if(mode==='body-stall'){res.write(asset.subarray(0,131072));return;}
   if(mode==='slow'||mode==='gzip-slow'){let offset=0;const chunk=mode==='gzip-slow'?32768:slowChunk,interval=mode==='gzip-slow'?100:slowInterval;const timer=setInterval(()=>{const end=Math.min(payload.length,offset+chunk);res.write(payload.subarray(offset,end));offset=end;if(offset===payload.length){clearInterval(timer);res.end();}},interval);res.on('close',()=>clearInterval(timer));return;}
   res.end(asset);return;
  }
  if(pathname==='/fixture.html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Local model transfer fixture</title>');return;}
  if(pathname==='/src/model-loader.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(helperSnapshot);return;}
  const file=path.resolve(root,'.'+decodeURIComponent(pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  const types={'.js':'text/javascript','.glb':'model/gltf-binary','.txt':'text/plain'};
  const bytes=fs.readFileSync(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--disable-background-networking']});
 try{
  const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
  for(const target of [{label:'local',base:origin,fixture:'/fixture.html',file:'/assets/models/home.glb'},...localOnly?[]:[{label:'github-pages',base:'https://feirate.github.io',fixture:'/word-island/vendor/THREE-LICENSE.txt',file:'/word-island/assets/models/home.glb'}]]){
   await page.goto(target.base+target.fixture,{waitUntil:'domcontentloaded',timeout:30000});
   for(const strategy of ['arrayBuffer','stream','xhr']){
    const transfer=await page.evaluate(async({url,strategy})=>{
     const start=performance.now(),result={strategy,url,status:null,headersMs:null,firstProgressMs:null,bodyMs:null,elapsedMs:null,bytes:0,chunks:0,maxProgressGapMs:0};let lastProgress=null,data;
     const progress=loaded=>{const now=performance.now();if(result.firstProgressMs===null)result.firstProgressMs=now-start;if(lastProgress!==null)result.maxProgressGapMs=Math.max(result.maxProgressGapMs,now-lastProgress);lastProgress=now;result.bytes=loaded;result.chunks++;};
     try{
      if(strategy==='xhr'){
       data=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('GET',url);xhr.responseType='arraybuffer';xhr.timeout=45000;xhr.setRequestHeader('Cache-Control','no-cache');xhr.onreadystatechange=()=>{if(xhr.readyState===2){result.status=xhr.status;result.headersMs=performance.now()-start;result.headers=xhr.getAllResponseHeaders();}};xhr.onprogress=event=>progress(event.loaded);xhr.onload=()=>resolve(xhr.response);xhr.onerror=()=>reject(new Error('XHR network error'));xhr.ontimeout=()=>reject(new Error('XHR 45s timeout'));xhr.send();});
      }else{
       const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);
       try{const response=await fetch(url,{cache:'no-store',signal:controller.signal});result.status=response.status;result.headersMs=performance.now()-start;result.headers=Object.fromEntries(response.headers.entries());if(!response.ok)throw new Error(`HTTP ${response.status}`);
        if(strategy==='arrayBuffer')data=await response.arrayBuffer();
        else{const reader=response.body.getReader(),chunks=[];let loaded=0;for(;;){const read=await reader.read();if(read.done)break;chunks.push(read.value);loaded+=read.value.byteLength;progress(loaded);}const joined=new Uint8Array(loaded);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}data=joined.buffer;}
       }finally{clearTimeout(timer);}
      }
      result.bytes=data.byteLength;const view=new DataView(data);result.glb={magic:view.getUint32(0,true).toString(16),version:view.getUint32(4,true),declaredBytes:view.getUint32(8,true)};
      result.sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),n=>n.toString(16).padStart(2,'0')).join('');
     }catch(error){result.error=`${error.name}: ${error.message}`;}
     result.elapsedMs=performance.now()-start;result.bodyMs=result.headersMs===null?null:result.elapsedMs-result.headersMs;return result;
    },{url:target.base+target.file,strategy});
    transfer.target=target.label;report.transfers.push(transfer);if(transfer.error||transfer.bytes!==asset.length||transfer.sha256!==expectedHash)report.failures.push(`${target.label}/${strategy}: ${transfer.error||'byte/hash mismatch'}`);save();console.log(JSON.stringify({target:target.label,strategy,status:transfer.status,bytes:transfer.bytes,hashMatches:transfer.sha256===expectedHash,headersMs:transfer.headersMs,bodyMs:transfer.bodyMs,chunks:transfer.chunks,error:transfer.error}));
   }
  }
  await page.goto(origin+'/fixture.html');
  await page.setContent(`<iframe name="transport-fixture" src="${origin}/fixture.html"></iframe>`);
  const frame=page.frame({name:'transport-fixture'});await frame.waitForURL(origin+'/fixture.html');
  await frame.evaluate(()=>{
   window.transferTrace={xhr:[],fetch:[]};window.nativeXHR=XMLHttpRequest;
   const open=XMLHttpRequest.prototype.open,abort=XMLHttpRequest.prototype.abort,fetchOriginal=window.fetch;
   XMLHttpRequest.prototype.open=function(method,url,...args){const trace={method,url:String(url),aborted:false};this.transferTrace=trace;window.transferTrace.xhr.push(trace);this.addEventListener('loadend',()=>{trace.status=this.status;});return open.call(this,method,url,...args);};
   XMLHttpRequest.prototype.abort=function(...args){if(this.transferTrace)this.transferTrace.aborted=true;return abort.apply(this,args);};
   window.fetch=function(...args){window.transferTrace.fetch.push(String(args[0]));return fetchOriginal.apply(this,args);};
  });
  const runHelper=async(label,{idleMs=idleBudget,hardMs=180000,abortMs=null,fallback=false}={})=>{
   const result=await frame.evaluate(async({origin,label,idleMs,hardMs,abortMs,fallback})=>{
    const {fetchModelData}=await import(origin+'/src/model-loader.js');const start=performance.now(),updates=[];let output,error;const controller=new AbortController(),timer=abortMs===null?null:setTimeout(()=>controller.abort(),abortMs),beforeXHR=window.transferTrace.xhr.length,beforeFetch=window.transferTrace.fetch.length;
    if(fallback)window.XMLHttpRequest=undefined;
    try{output=await fetchModelData(`${origin}/fixture-model/${label}/home.glb`,{signal:controller.signal,timeoutMs:idleMs,maxDurationMs:hardMs,onProgress:p=>updates.push({...p,ms:performance.now()-start})});}catch(e){error={name:e.name,message:e.message,details:e.details};}finally{if(timer)clearTimeout(timer);window.XMLHttpRequest=window.nativeXHR;}
    const nonzero=updates.filter(p=>p.loaded>0),last=nonzero.at(-1),sha256=output?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',output)),n=>n.toString(16).padStart(2,'0')).join(''):null;
    return {label,elapsedMs:performance.now()-start,bytes:output?.byteLength||last?.loaded||0,sha256,progressEvents:nonzero.length,reportedTotals:[...new Set(updates.map(p=>p.total).filter(Number.isFinite))],phases:[...new Set(updates.map(p=>p.phase).filter(Boolean))],lastProgressMs:last?.ms||null,lastProgressAgeMs:last?performance.now()-start-last.ms:null,maxProgressGapMs:nonzero.reduce((max,p,i)=>Math.max(max,i?p.ms-nonzero[i-1].ms:0),0),error,idleBudgetMs:idleMs,hardBudgetMs:hardMs,transport:{xhr:window.transferTrace.xhr.slice(beforeXHR),fetch:window.transferTrace.fetch.slice(beforeFetch)}};
   },{origin,label,idleMs,hardMs,abortMs,fallback});
   report.helperCases??=[];report.helperCases.push(result);save();console.log(JSON.stringify({helperCase:label,elapsedMs:result.elapsedMs,bytes:result.bytes,hashMatches:result.sha256===expectedHash,error:result.error,transport:result.transport}));return result;
  };
  const expectComplete=(result,label)=>{if(result.error||result.bytes!==asset.length||result.sha256!==expectedHash)report.failures.push(`${label}: full model bytes/hash did not arrive`);};
  const expectXHR=(result,label)=>{if(result.transport.xhr.length!==1||result.transport.fetch.length!==0)report.failures.push(`${label}: default transport did not use one native XHR`);};
  console.log(JSON.stringify({stage:'continuous-progress-start',intendedTransferSeconds:Math.ceil(asset.length/slowChunk)*slowInterval/1000,chunkBytes:slowChunk,chunkIntervalMs:slowInterval,idleBudget}));
  report.slow=await runHelper('continuous');expectComplete(report.slow,'continuous progress');expectXHR(report.slow,'continuous progress');
  const gzip=await runHelper('gzip',{idleMs:600});expectComplete(gzip,'gzip continuous progress');expectXHR(gzip,'gzip continuous progress');if(gzip.elapsedMs<=600||compressedAsset.length===asset.length)report.failures.push('gzip fixture did not exercise a longer progressing compressed response');
  for(const label of ['headers','body']){
   const stopped=await runHelper(label,{idleMs:600});expectXHR(stopped,label);
   if(stopped.error?.name!=='TimeoutError'||stopped.error?.details?.reason!=='idle-timeout')report.failures.push(`${label}: missing distinct idle timeout`);
   if(label==='headers'&&stopped.bytes!==0)report.failures.push('header stall invented downloaded bytes');
   if(label==='body'&&stopped.bytes<=0)report.failures.push('body stall lost its real partial progress');
   fixtureModes.set(label,'normal');expectComplete(await runHelper(label,{idleMs:600}),`${label} same-URL retry`);
  }
  const hard=await runHelper('hard',{idleMs:600,hardMs:450});expectXHR(hard,'hard deadline');if(hard.error?.name!=='TimeoutError'||hard.error?.details?.reason!=='overall-timeout')report.failures.push('hard deadline is not distinguishable from idle timeout');
  const cancelled=await runHelper('cancel',{idleMs:600,abortMs:250});expectXHR(cancelled,'cancellation');if(cancelled.error?.name!=='AbortError'||!cancelled.transport.xhr[0]?.aborted)report.failures.push('caller cancellation did not abort native XHR');fixtureModes.set('cancel','normal');expectComplete(await runHelper('cancel',{idleMs:600}),'cancel same-URL retry');
  const fallback=await runHelper('fallback',{idleMs:600,fallback:true});expectComplete(fallback,'no-XHR fetch fallback');if(fallback.transport.xhr.length!==0||fallback.transport.fetch.length!==1)report.failures.push('no-XHR runtime did not use fetch fallback');
  save();console.log(JSON.stringify({slow:report.slow,failures:report.failures,report:reportPath}));await context.close();assert.deepEqual(report.failures,[]);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{save();console.error(error);process.exitCode=1;});
