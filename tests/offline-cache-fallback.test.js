import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const scope='https://example.test/word-island/';
const source=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const scripts=new Map(['./assets/audio/precache.js','./assets/companions-precache.js'].map(file=>[file,readFileSync(new URL(`../${file}`,import.meta.url),'utf8')]));

function worker({failure,offline=false,cached=false,networkStatus=200}={}) {
  const listeners=new Map(),requests=[];let skipped=false;
  const response=()=>new Response('cached complete body',{status:200,headers:{'Content-Type':'audio/mp4'}});
  const cache={
    async match(){
      if(failure==='match')throw new Error('Cache match blocked');
      if(!cached)return undefined;
      const result=response();if(failure==='body')result.arrayBuffer=()=>Promise.reject(new Error('Cache body unavailable'));
      return result;
    },
    async put(){if(failure==='put')throw new Error('QuotaExceededError');},
    async addAll(){if(failure==='addAll')throw new Error('Cache install failed');},
  };
  const self={registration:{scope},location:{origin:new URL(scope).origin},clients:{async claim(){}},async skipWaiting(){skipped=true;},addEventListener:(type,fn)=>listeners.set(type,fn)};
  const context=vm.createContext({self,URL,Request,Response,Headers,caches:{
    async open(){if(failure==='open')throw new Error('CacheStorage blocked');return cache;},
    async keys(){return [];},async delete(){return true;},
  },fetch:async request=>{requests.push(request);if(offline)throw new Error('Network offline');return new Response('real online response',{status:networkStatus});}});
  context.importScripts=(...files)=>{for(const file of files)vm.runInContext(scripts.get(file),context);};
  vm.runInContext(source,context);
  return {
    requests,
    async fetch(path,{range}={}){
      const request=new Request(new URL(path,scope),{headers:range?{Range:range}:{}});let pending;
      listeners.get('fetch')({request,respondWith:value=>{pending=value;}});
      return await pending;
    },
    async install(){let pending;listeners.get('install')({waitUntil:value=>{pending=value;}});await pending;},
    get skipped(){return skipped;},
  };
}

test('CacheStorage open or match denial falls back to online core and model files',async()=>{
  for(const failure of ['open','match'])for(const path of ['index.html','src/app.js','assets/models/home.glb']){
    const sw=worker({failure});const result=await sw.fetch(path);
    assert.equal(result.status,200);assert.equal(await result.text(),'real online response');
    assert.equal(sw.requests.length,1,`${failure} ${path} must make one real network request`);
    assert.equal(sw.requests[0].url,new URL(path,scope).href);
  }
});

test('cache write denial cannot turn a successful online response into a failed page',async()=>{
  const sw=worker({failure:'put'}),result=await sw.fetch('src/app.js');
  assert.equal(result.status,200);assert.equal(await result.text(),'real online response');assert.equal(sw.requests.length,1);
});

test('blocked range-cache lookup or body read forwards the original media request',async()=>{
  for(const failure of ['open','match','body']){
    const sw=worker({failure,cached:failure==='body',networkStatus:206});
    const result=await sw.fetch('assets/audio/word-milk.m4a',{range:'bytes=2-5'});
    assert.equal(result.status,206);assert.equal(await result.text(),'real online response');
    assert.equal(sw.requests.length,1);assert.equal(sw.requests[0].headers.get('Range'),'bytes=2-5');
  }
});

test('unavailable cache plus unavailable network stays a real failure without a fabricated offline result',async()=>{
  for(const failure of ['open','match'])for(const [path,range]of [['src/app.js',undefined],['assets/audio/word-milk.m4a','bytes=0-1']]){
    const sw=worker({failure,offline:true});await assert.rejects(sw.fetch(path,{range}),/Network offline/);assert.equal(sw.requests.length,1);
  }
});

test('valid complete and ranged cached responses still work with no network',async()=>{
  const sw=worker({cached:true,offline:true});
  assert.equal(await(await sw.fetch('src/app.js')).text(),'cached complete body');
  const range=await sw.fetch('assets/audio/word-milk.m4a',{range:'bytes=0-5'});
  assert.equal(range.status,206);assert.equal(await range.text(),'cached');assert.equal(sw.requests.length,0);
});

test('cache-install failure still rejects installation rather than announcing false offline readiness',async()=>{
  for(const failure of ['open','addAll']){
    const sw=worker({failure});await assert.rejects(sw.install(),/Cache/);assert.equal(sw.skipped,false);
  }
});
