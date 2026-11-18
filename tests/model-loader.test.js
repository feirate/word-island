import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {fetchModelData,fetchModelDataWithRetry} from '../src/model-loader.js';

const nativeFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=nativeFetch;});
const url='https://island.test/assets/home.glb';

test('model bytes and progress come from a successful complete response',async()=>{
  globalThis.fetch=async()=>new Response(new Uint8Array([1,2,3,4]),{headers:{'Content-Length':'4'}});
  const progress=[];
  const bytes=await fetchModelData(url,{onProgress:event=>progress.push(event)});
  assert.deepEqual([...new Uint8Array(bytes)],[1,2,3,4]);
  assert.deepEqual({loaded:progress.at(-1).loaded,total:progress.at(-1).total},{loaded:4,total:4});
});

test('HTTP errors cannot become a successfully loaded model',async()=>{
  globalThis.fetch=async()=>new Response('not found',{status:404});
  await assert.rejects(fetchModelData(url),/404/);
});

test('a request that never settles has a deadline and its network signal is aborted',async()=>{
  let signal;
  globalThis.fetch=(_url,options)=>{signal=options.signal;return new Promise(()=>{});};
  await assert.rejects(fetchModelData(url,{timeoutMs:20}),error=>error.name==='TimeoutError');
  assert.equal(signal.aborted,true);
});

test('a body stalled after response headers also times out and is cancelled',async()=>{
  let cancelled=false;
  globalThis.fetch=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}));
  await assert.rejects(fetchModelData(url,{timeoutMs:20}),error=>error.name==='TimeoutError');
  assert.equal(cancelled,true);
});

test('external cancellation stops an in-flight request without waiting for its deadline',async()=>{
  let networkSignal;
  globalThis.fetch=(_url,options)=>{networkSignal=options.signal;return new Promise(()=>{});};
  const controller=new AbortController();
  const pending=fetchModelData(url,{signal:controller.signal,timeoutMs:1000});
  controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');
  assert.equal(networkSignal.aborted,true);
});

test('an already cancelled view never starts another download',async()=>{
  let requests=0;globalThis.fetch=async()=>{requests++;return new Response('unused');};
  const controller=new AbortController();controller.abort();
  await assert.rejects(fetchModelData(url,{signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(requests,0);
});

test('late responses after a timeout do not publish stale progress',async()=>{
  let release;const progress=[];
  globalThis.fetch=()=>new Promise(resolve=>{release=resolve;});
  await assert.rejects(fetchModelData(url,{timeoutMs:20,onProgress:event=>progress.push(event)}),error=>error.name==='TimeoutError');
  release(new Response(new Uint8Array([1,2,3])));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(progress,[]);
});

test('continued byte progress can finish after the inactivity budget',async()=>{
  let interval;
  globalThis.fetch=async()=>new Response(new ReadableStream({
    start(controller){let n=0;interval=setInterval(()=>{controller.enqueue(new Uint8Array([++n]));if(n===8){clearInterval(interval);controller.close();}},50);},
    cancel(){clearInterval(interval);},
  }));
  const bytes=await fetchModelData(url,{timeoutMs:250,maxDurationMs:2000});
  assert.deepEqual([...new Uint8Array(bytes)],[1,2,3,4,5,6,7,8]);
});

test('a stalled body reports the last bytes and the inactivity reason',async()=>{
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));}}));
  await assert.rejects(fetchModelData(url,{timeoutMs:30,maxDurationMs:1000}),error=>{
    assert.equal(error.name,'TimeoutError');assert.equal(error.details.reason,'idle-timeout');
    assert.equal(error.details.loaded,3);assert.equal(error.details.phase,'receiving');return true;
  });
});

test('the separate overall limit bounds even a continually active download',async()=>{
  let interval;
  globalThis.fetch=async()=>new Response(new ReadableStream({
    start(controller){interval=setInterval(()=>controller.enqueue(new Uint8Array([1])),20);},
    cancel(){clearInterval(interval);},
  }));
  await assert.rejects(fetchModelData(url,{timeoutMs:200,maxDurationMs:100}),error=>{
    assert.equal(error.name,'TimeoutError');assert.equal(error.details.reason,'overall-timeout');
    assert(error.details.loaded>0);return true;
  });
});

test('one partial idle failure automatically reconnects and returns complete bytes',async()=>{
  let calls=0,cancelled=false;const updates=[];
  globalThis.fetch=async()=>++calls===1?new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2]));},cancel(){cancelled=true;}})):new Response(new Uint8Array([1,2,3,4]));
  const bytes=await fetchModelDataWithRetry(url,{timeoutMs:25,retryDelayMs:1,maxDurationMs:1000,onProgress:event=>updates.push(event)});
  assert.deepEqual([...new Uint8Array(bytes)],[1,2,3,4]);assert.equal(calls,2);assert.equal(cancelled,true);
  const retry=updates.find(event=>event.phase==='retrying');assert.equal(retry.loaded,2);assert.equal(retry.attempt,2);assert.equal(retry.maxAttempts,2);
  assert.equal(updates.at(-1).attempt,2);assert(updates.at(-1).elapsedMs>=25);
});

test('two temporary failures end with an explicit finite attempts count',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('connection interrupted');};
  await assert.rejects(fetchModelDataWithRetry(url,{retryDelayMs:1,maxDurationMs:1000}),error=>{
    assert.equal(error.details.reason,'network');assert.equal(error.details.attempts,2);assert.equal(error.details.maxAttempts,2);return true;
  });assert.equal(calls,2);
});

test('only selected temporary HTTP failures reconnect; permanent HTTP errors fail once',async()=>{
  for(const status of [502,503,504,404,500]){
    let calls=0;globalThis.fetch=async()=>++calls===1?new Response('unavailable',{status}):new Response(new Uint8Array([7]));
    if([502,503,504].includes(status))assert.deepEqual([...new Uint8Array(await fetchModelDataWithRetry(url,{retryDelayMs:1,maxDurationMs:1000}))],[7]);
    else await assert.rejects(fetchModelDataWithRetry(url,{retryDelayMs:1,maxDurationMs:1000}),error=>error.details.status===status&&error.details.attempts===1);
    assert.equal(calls,[502,503,504].includes(status)?2:1);
  }
});

test('an externally cancelled model never starts an automatic second attempt',async()=>{
  let calls=0;globalThis.fetch=(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));};
  const controller=new AbortController();const pending=fetchModelDataWithRetry(url,{signal:controller.signal,retryDelayMs:1});controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError'&&error.details.attempts===1);assert.equal(calls,1);
});

test('cancellation during reconnect backoff closes the wait without sending another request',async()=>{
  let calls=0;const controller=new AbortController();globalThis.fetch=async()=>{calls++;throw new TypeError('offline');};
  const pending=fetchModelDataWithRetry(url,{signal:controller.signal,retryDelayMs:1000,maxDurationMs:5000,onProgress:event=>{if(event.phase==='retrying')setTimeout(()=>controller.abort(),5);}});
  await assert.rejects(pending,error=>error.name==='AbortError'&&error.details.attempts===1);assert.equal(calls,1);
});

test('one overall budget includes the reconnect wait and cannot restart for each attempt',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('offline');};
  await assert.rejects(fetchModelDataWithRetry(url,{retryDelayMs:200,maxDurationMs:35}),error=>error.name==='TimeoutError'&&error.details.reason==='overall-timeout'&&error.details.attempts===1);
  assert.equal(calls,1);
});

test('remaining overall budget bounds a second stalled transfer rather than granting a fresh budget',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([calls]));}}));};
  await assert.rejects(fetchModelDataWithRetry(url,{timeoutMs:45,retryDelayMs:5,maxDurationMs:75}),error=>error.details.reason==='overall-timeout'&&error.details.attempts===2);
  assert.equal(calls,2);
});

test('background policy blocks a reconnect both before and after the wait',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('offline');};
  await assert.rejects(fetchModelDataWithRetry(url,{retryDelayMs:1,canRetry:()=>false}),error=>error.details.attempts===1);assert.equal(calls,1);
  calls=0;let foreground=true;
  await assert.rejects(fetchModelDataWithRetry(url,{retryDelayMs:5,canRetry:()=>foreground,onProgress:event=>{if(event.phase==='retrying')foreground=false;}}),error=>error.details.attempts===1);
  assert.equal(calls,1);
});

test('a continuously active transfer exhausting its total budget is not retried',async()=>{
  let calls=0,timer;globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(controller){timer=setInterval(()=>controller.enqueue(new Uint8Array([1])),10);},cancel(){clearInterval(timer);}}));};
  await assert.rejects(fetchModelDataWithRetry(url,{timeoutMs:100,maxDurationMs:35,retryDelayMs:1}),error=>error.details.reason==='overall-timeout'&&error.details.attempts===1);assert.equal(calls,1);
});

test('a cancelled caller sends no first request and attempt configuration cannot exceed two',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('offline');};
  const controller=new AbortController();controller.abort();
  await assert.rejects(fetchModelDataWithRetry(url,{signal:controller.signal}),error=>error.name==='AbortError'&&error.details.attempts===0);assert.equal(calls,0);
  await assert.rejects(fetchModelDataWithRetry(url,{maxAttempts:999,retryDelayMs:0}),error=>error.details.attempts===2&&error.details.maxAttempts===2);assert.equal(calls,2);
});
