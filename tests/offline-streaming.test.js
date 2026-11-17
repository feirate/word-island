import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';

const scope='https://example.test/word-island/';
const source=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const scripts=new Map(['./assets/audio/precache.js','./assets/companions-precache.js','./assets/runtime-manifest.js'].map(file=>[file,readFileSync(new URL(`../${file}`,import.meta.url),'utf8')]));
const manifestSelf={};vm.runInNewContext(scripts.get('./assets/runtime-manifest.js'),{self:manifestSelf});
const sample=Uint8Array.from({length:128},(_,i)=>i);
manifestSelf.WORD_ISLAND_RUNTIME.resources=Object.fromEntries(Object.keys(manifestSelf.WORD_ISLAND_RUNTIME.resources).map(path=>[path,createHash('sha256').update(sample).digest('hex')]));
scripts.set('./assets/runtime-manifest.js',`self.WORD_ISLAND_RUNTIME=${JSON.stringify(manifestSelf.WORD_ISLAND_RUNTIME)};`);

function worker({writeFailure=false,networkStatus=200,cached=false,offline=false}={}){
  const listeners=new Map(),entries=new Map(),lifetime=[],requests=[],writes=[];
  let release;const writeGate=new Promise(resolve=>{release=resolve;});
  const urlOf=request=>typeof request==='string'?request:request.url;
  if(cached)entries.set(`${new URL('assets/models/home.glb',scope).href}?asset=${manifestSelf.WORD_ISLAND_RUNTIME.resources['assets/models/home.glb']}`,new Response(sample));
  const cache={
    async match(key){return entries.get(urlOf(key))?.clone();},
    async put(key,response){
      writes.push(urlOf(key));await writeGate;
      if(writeFailure)throw new Error('Fixture cache write failed');
      const bytes=await response.arrayBuffer();entries.set(urlOf(key),new Response(bytes,{status:response.status,headers:response.headers}));
    },
  };
  const self={registration:{scope},location:{origin:new URL(scope).origin},addEventListener:(type,handler)=>listeners.set(type,handler)};
  const context=vm.createContext({self,URL,Request,Response,Headers,crypto:webcrypto,caches:{async open(){return cache;}},fetch:async request=>{
    requests.push(request);if(offline)throw new Error('Network offline');return new Response(sample,{status:networkStatus});
  }});
  context.importScripts=(...files)=>{for(const file of files)vm.runInContext(scripts.get(file),context);};
  vm.runInContext(source,context);
  return {entries,lifetime,requests,writes,release,goOffline(){offline=true;},async request(path,range){
    const request=new Request(new URL(path,scope),{headers:range?{Range:range}:{}});let response;
    listeners.get('fetch')({request,respondWith:promise=>{response=Promise.resolve(promise);},waitUntil:promise=>lifetime.push(Promise.resolve(promise))});
    return await response;
  }};
}

async function promptly(promise){
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The response was blocked by the cache write')),40);})]);}
  finally{clearTimeout(timer);}
}

test('a cold model response and body arrive while persistence is still pending, then the full cached model works offline',async()=>{
  const sw=worker();
  try{
    const response=await promptly(sw.request('assets/models/home.glb'));
    assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),sample);
    assert.equal(sw.entries.size,0,'the controlled cache write must still be pending');
    assert.equal(sw.lifetime.length,1,'background persistence must extend the actual fetch-event lifetime');
    sw.release();await Promise.all(sw.lifetime);sw.goOffline();
    const cached=await sw.request('assets/models/home.glb');assert.deepEqual(new Uint8Array(await cached.arrayBuffer()),sample);
    assert.equal(sw.requests.length,1,'the completed full-file cache must serve the offline request');
  }finally{sw.release();}
});

test('a failed background cache write cannot delay or reject an online model response',async()=>{
  const sw=worker({writeFailure:true});
  try{
    const response=await promptly(sw.request('assets/models/home.glb'));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()),sample);
    sw.release();await Promise.all(sw.lifetime);
    assert.equal(sw.entries.size,0);assert.equal(sw.requests.length,1);
  }finally{sw.release();}
});

test('a cache hit never starts a network download or a duplicate cache write',async()=>{
  const sw=worker({cached:true,offline:true});
  const response=await sw.request('assets/models/home.glb');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),sample);
  assert.equal(sw.requests.length,0);assert.equal(sw.writes.length,0);assert.equal(sw.lifetime.length,0);
});

test('a failed network request is still rejected rather than marked available offline',async()=>{
  const sw=worker({offline:true});await assert.rejects(sw.request('assets/models/home.glb'),/Network offline/);
  assert.equal(sw.writes.length,0);assert.equal(sw.entries.size,0);
});

test('partial model and media responses cannot replace complete cached files',async()=>{
  for(const [path,range]of [['assets/models/home.glb',undefined],['assets/audio/word-milk.m4a','bytes=0-1']]){
    const sw=worker({networkStatus:206});
    const response=await sw.request(path,range);assert.equal(response.status,206);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()),sample);assert.equal(sw.writes.length,0);assert.equal(sw.entries.size,0);
    if(range)assert.equal(sw.requests[0].headers.get('Range'),range);
  }
});
