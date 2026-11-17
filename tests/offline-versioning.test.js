import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const scope='https://example.test/word-island/';
const source=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const version=/const VERSION = 'v([^']+)';/.exec(source)[1];
const scripts=new Map(['./assets/audio/precache.js','./assets/companions-precache.js','./assets/runtime-manifest.js'].map(file=>[file,readFileSync(new URL(`../${file}`,import.meta.url),'utf8')]));

function worker({offline=false,networkStatus=200,cacheDenied=false,holdWrites=false}={}){
  const entries=new Map(),requests=[],lifetime=[],writes=[],listeners=new Map();
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const keyOf=input=>typeof input==='string'?input:input.url;
  const cache={async match(input){return entries.get(keyOf(input))?.clone();},async put(input,response){
    const key=keyOf(input);writes.push(key);if(holdWrites)await gate;entries.set(key,new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));
  }};
  const self={registration:{scope},location:{origin:new URL(scope).origin},addEventListener:(type,handler)=>listeners.set(type,handler)};
  const context=vm.createContext({self,URL,Request,Response,Headers,caches:{async open(){if(cacheDenied)throw new Error('Cache denied');return cache;}},fetch:async(request,options)=>{
    requests.push({request,options});if(offline)throw new Error('Network offline');return new Response('new online content',{status:networkStatus});
  }});
  context.importScripts=(...files)=>{for(const file of files)vm.runInContext(scripts.get(file),context);};vm.runInContext(source,context);
  return {entries,requests,lifetime,writes,release,goOffline(){offline=true;},seed(path,text){entries.set(new URL(path,scope).href,new Response(text));},async request(path,{navigate=false,range}={}){
    const request=new Request(new URL(path,scope),{headers:range?{Range:range}:{}});if(navigate)Object.defineProperty(request,'mode',{value:'navigate'});
    let response;listeners.get('fetch')({request,respondWith:promise=>{response=Promise.resolve(promise);},waitUntil:promise=>lifetime.push(Promise.resolve(promise))});
    return response?await response:undefined;
  }};
}

test('current-version JS and CSS read the canonical current cache while offline',async()=>{
  const sw=worker({offline:true});
  for(const path of ['src/app.js','src/model-loader.js','vendor/three.module.js','src/styles.css']){
    sw.seed(path,`cached ${path}`);
    assert.equal(await(await sw.request(`${path}?v=${version}`)).text(),`cached ${path}`);
    assert.equal(await(await sw.request(path)).text(),`cached ${path}`);
  }
  assert.equal(sw.requests.length,0);
});

test('foreign, duplicate and extra version queries bypass an old worker cache',async()=>{
  const sw=worker();sw.seed('src/app.js','old app');
  for(const query of ['v=999.0.0',`v=${version}&v=${version}`,`v=${version}&debug=1`,'debug=1','v=','V='+version]){
    assert.equal(await sw.request(`src/app.js?${query}`),undefined,query);
  }
  assert.equal(sw.requests.length,0,'bypassed requests belong to the browser network, not an old worker fetch');
});

test('versioned module cache misses persist under canonical keys without blocking the network response',async()=>{
  const sw=worker({holdWrites:true});
  try{
    const response=await sw.request(`src/app.js?v=${version}`);assert(response);assert.equal(await response.text(),'new online content');
    assert.deepEqual(sw.writes,[new URL('src/app.js',scope).href]);assert.equal(sw.lifetime.length,1);assert.equal(sw.entries.size,0);
    sw.release();await Promise.all(sw.lifetime);sw.goOffline();
    assert.equal(await(await sw.request(`src/app.js?v=${version}`)).text(),'new online content');
  }finally{sw.release();}
});

test('online navigation revalidates and returns new HTML before the background cache write finishes',async()=>{
  const sw=worker({holdWrites:true});sw.seed('index.html','old cached entry');
  try{
    const response=await sw.request('./',{navigate:true});assert.equal(await response.text(),'new online content');
    assert.equal(sw.requests.length,1);assert.equal(sw.requests[0].options?.cache,'no-cache');assert.equal(sw.lifetime.length,1);
    assert.equal(await sw.entries.get(new URL('index.html',scope).href).clone().text(),'old cached entry');
    sw.release();await Promise.all(sw.lifetime);sw.goOffline();
    assert.equal(await(await sw.request('index.html?from=homescreen',{navigate:true})).text(),'new online content');
  }finally{sw.release();}
});

test('offline navigation falls back to an existing canonical entry, but cannot invent a missing entry',async()=>{
  const sw=worker({offline:true});sw.seed('index.html','available offline');
  assert.equal(await(await sw.request('./?launch=1',{navigate:true})).text(),'available offline');
  await assert.rejects(worker({offline:true}).request('./',{navigate:true}),/Network offline/);
});

test('the fresh start entry uses the canonical index cache when offline',async()=>{
  const sw=worker({offline:true});sw.seed('index.html','same origin offline entry');
  const response=await sw.request('start.html',{navigate:true});assert(response);
  assert.equal(await response.text(),'same origin offline entry');assert.equal(sw.requests.length,1);
  assert.equal(sw.entries.has(new URL('start.html',scope).href),false,'the alternate entry must share the canonical index cache');
});

test('an HTTP error is not replaced with stale HTML, and unavailable storage still permits online navigation',async()=>{
  const sw=worker({networkStatus:503});sw.seed('index.html','stale entry');
  assert.equal((await sw.request('./',{navigate:true})).status,503);assert.equal(sw.writes.length,0);
  const denied=worker({cacheDenied:true});const response=await denied.request('./',{navigate:true});assert.equal(await response.text(),'new online content');
  await Promise.all(denied.lifetime);
});

test('audio and model query matching remains exact, including Range requests',async()=>{
  const sw=worker({offline:true});
  for(const path of ['assets/audio/word-milk.m4a','assets/models/home.glb'])for(const range of [undefined,'bytes=0-1']){
    assert.equal(await sw.request(`${path}?v=${version}`,{range}),undefined);
  }
  assert.equal(sw.requests.length,0);
});
