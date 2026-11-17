import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {fetchModelData} from '../src/model-loader.js';

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
