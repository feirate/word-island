import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';

const source=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
const scope='https://example.test/word-island/';
const prefix=`word-island:${scope}`;
const bytes=Uint8Array.from([1,2,3,4,5,6]);
const revision=createHash('sha256').update(bytes).digest('hex');
const audio='assets/audio/word-milk.m4a',model='assets/models/home.glb';
const scripts=new Map(['./assets/audio/precache.js','./assets/companions-precache.js'].map(path=>[path,readFileSync(new URL(`../${path}`,import.meta.url),'utf8')]));
const manifestSelf={};for(const script of scripts.values())vm.runInNewContext(script,{self:manifestSelf});
const paths=[...manifestSelf.WORD_ISLAND_AUDIO_FILES,'assets/models/home.glb','assets/models/camp.glb','assets/models/hero.glb','assets/models/child.glb','assets/models/child-portrait.png',...manifestSelf.WORD_ISLAND_COMPANION_FILES];

function worker({buckets=new Map(),version='0.7.0',changed=[],gate=null,failPaths=[],bundle=false}={}){
  const listeners=new Map(),requests=[],writes=[];let active=0,peak=0,offline=false;
  const urlOf=input=>typeof input==='string'?input:input.url;
  const runtime={version,resources:Object.fromEntries(paths.map(path=>[path,changed.includes(path)?'f'.repeat(64):revision])),shell:['index.html','src/app.js','src/deferred-world.js'],code:['src/world.js','vendor/three.module.js']};
  if(bundle){
    const app='assets/chunks/app-ABC123.js',three='assets/chunks/three-DEF456.js',css='assets/chunks/app-ABC123.css';
    runtime.shell=['index.html',app,css];runtime.code=[app,three];
    for(const path of [app,three,css])runtime.resources[path]=revision;
  }
  const caches={
    async open(name){
      if(!buckets.has(name))buckets.set(name,new Map());const entries=buckets.get(name);
      return {
        async match(input){return entries.get(urlOf(input))?.clone();},
        async put(input,response){writes.push({name,key:urlOf(input)});entries.set(urlOf(input),new Response(await response.arrayBuffer(),{status:response.status,headers:response.headers}));},
        async keys(){return [...entries.keys()].map(url=>new Request(url));},
        async delete(input){return entries.delete(urlOf(input));},
        async addAll(inputs){for(const input of inputs){const response=await fetch(input);if(!response.ok)throw new Error('install failed');entries.set(urlOf(input),response);}},
      };
    },async keys(){return [...buckets.keys()];},async delete(name){return buckets.delete(name);},
  };
  async function fetch(input){
    const url=urlOf(input),path=url.slice(scope.length);requests.push(url);
    if(offline)throw new Error('offline');
    active++;peak=Math.max(peak,active);
    try{await gate?.(path);return new Response(bytes,{status:failPaths.includes(path)?503:200});}finally{active--;}
  }
  const self={registration:{scope},location:{origin:new URL(scope).origin},clients:{async claim(){}},async skipWaiting(){},addEventListener:(name,fn)=>listeners.set(name,fn)};
  const context=vm.createContext({self,caches,fetch,URL,Request,Response,Headers,crypto:webcrypto,Uint8Array});
  context.importScripts=(...files)=>{for(const path of files){const script=path==='./assets/runtime-manifest.js'?`self.WORD_ISLAND_RUNTIME=${JSON.stringify(runtime)};`:scripts.get(path);assert.ok(script,`unknown import ${path}`);vm.runInContext(script,context);}};
  vm.runInContext(source.replace(/const VERSION = 'v[^']+';/,`const VERSION = 'v${version}';`),context);
  async function lifecycle(name){const pending=[];listeners.get(name)({waitUntil:value=>pending.push(value)});await Promise.all(pending);}
  return {buckets,requests,writes,get peak(){return peak;},install:()=>lifecycle('install'),activate:()=>lifecycle('activate'),goOffline(){offline=true;},async request(path){
    const pending=[];let response;listeners.get('fetch')({request:new Request(new URL(path,scope)),waitUntil:value=>pending.push(value),respondWith:value=>{response=value;}});const result=await response;await Promise.all(pending);return result;
  },async message(data){
    const messages=[],pending=[];listeners.get('message')({data,ports:[{postMessage:message=>messages.push(message)}],waitUntil:value=>pending.push(value)});await Promise.all(pending);return messages;
  }};
}

test('install prepares the learning shell without downloading audio, models or 3D code',async()=>{
  const sw=worker();await sw.install();assert.ok(sw.requests.length>0);
  assert.equal(sw.requests.some(url=>/\.m4a$|\.glb$|\/vendor\/|\/world\.js$/.test(url)),false);
});

test('a lesson prepares only requested built-in audio and reports progress before completion',async()=>{
  const sw=worker(),messages=await sw.message({type:'CACHE_LESSON',paths:[audio,audio]});
  assert.deepEqual(sw.requests,[`${scope}${audio}`]);
  assert.equal(messages[0]?.type,'CACHE_PROGRESS');assert.equal(messages[0].completed,1);assert.equal(messages[0].total,1);
  assert.equal(messages.at(-1)?.type,'LESSON_CACHED');assert.equal(messages.at(-1).ok,true);
  assert.equal(messages.at(-1).version,'0.7.0');
  sw.goOffline();assert.deepEqual(new Uint8Array(await(await sw.request(audio)).arrayBuffer()),bytes);
});

test('lesson preparation rejects foreign, model and unknown paths without network requests',async()=>{
  for(const path of ['https://foreign.test/a.m4a',model,'assets/audio/user-import.m4a']){
    const sw=worker(),messages=await sw.message({type:'CACHE_LESSON',paths:[path]});
    assert.equal(messages.at(-1)?.ok,false,path);assert.equal(sw.requests.length,0,path);
  }
});

test('unchanged model and audio cache survive application updates, changed files miss',async()=>{
  const first=worker();await first.message({type:'CACHE_LESSON',paths:[audio]});await first.message({type:'CACHE_MODELS',paths:[model]});
  const next=worker({buckets:first.buckets,version:'0.7.1'});await next.activate();next.goOffline();
  for(const path of [audio,model])assert.deepEqual(new Uint8Array(await(await next.request(path)).arrayBuffer()),bytes);
  assert.equal(next.requests.length,0);
  const changed=worker({buckets:first.buckets,version:'0.7.2',changed:[model]});await changed.activate();
  await changed.request(model);assert.deepEqual(changed.requests,[`${scope}${model}`]);
});

test('legacy assets migrate only after their bytes match the current content fingerprint',async()=>{
  const legacy=new Map([[`${scope}${model}`,new Response(bytes)],[`${scope}${audio}`,new Response('stale wrong audio')]]);
  const buckets=new Map([[`${prefix}models:v0.6.4`,legacy],[`${prefix}shell:v0.6.4`,new Map([[`${scope}${audio}`,new Response(bytes)]])]]);
  const sw=worker({buckets});await sw.activate();sw.goOffline();
  assert.deepEqual(new Uint8Array(await(await sw.request(model)).arrayBuffer()),bytes);
  assert.deepEqual(new Uint8Array(await(await sw.request(audio)).arrayBuffer()),bytes);
  assert.equal(sw.requests.length,0);
});

test('wrong legacy bytes do not become a valid current cache entry',async()=>{
  const buckets=new Map([[`${prefix}models:v0.6.4`,new Map([[`${scope}${model}`,new Response('old model')]])]]);
  const sw=worker({buckets});await sw.activate();sw.goOffline();await assert.rejects(sw.request(model),/offline/);
});

test('full preparation includes 3D code and all audio with at most two concurrent transfers',async()=>{
  const sw=worker({gate:()=>new Promise(resolve=>setTimeout(resolve,1))});
  const messages=await sw.message({type:'CACHE_MODELS'}),final=messages.at(-1);
  assert.equal(final?.type,'MODELS_CACHED');assert.equal(final.ok,true);
  assert.equal(final.version,'0.7.0');
  assert.ok(sw.requests.includes(`${scope}${audio}`));assert.ok(sw.requests.includes(`${scope}src/world.js`));
  assert.ok(sw.requests.includes(`${scope}vendor/three.module.js`));assert.ok(sw.peak<=2,`observed ${sw.peak} transfers`);
  assert.equal(messages.filter(message=>message.type==='CACHE_PROGRESS').length,sw.requests.length);
});

test('partial preparation failures remain failures and a retry only downloads missing files',async()=>{
  const failPaths=[audio],sw=worker({failPaths});
  let messages=await sw.message({type:'CACHE_LESSON',paths:[audio,'assets/audio/word-milk-slow.m4a']});
  assert.equal(messages.at(-1)?.ok,false);assert.deepEqual(Array.from(messages.at(-1).failed),[audio]);
  failPaths.length=0;const before=sw.requests.length;messages=await sw.message({type:'CACHE_LESSON',paths:[audio,'assets/audio/word-milk-slow.m4a']});
  assert.equal(messages.at(-1).ok,true);assert.deepEqual(sw.requests.slice(before),[`${scope}${audio}`]);
});

test('overlapping lesson requests share complete-file work and the same two transfer slots',async()=>{
  const sw=worker({gate:()=>new Promise(resolve=>setTimeout(resolve,2))});
  const second='assets/audio/word-milk-slow.m4a',third='assets/audio/word-rice.m4a';
  const results=await Promise.all([
    sw.message({type:'CACHE_LESSON',paths:[audio,second]}),
    sw.message({type:'CACHE_LESSON',paths:[audio,third]}),
  ]);
  for(const messages of results)assert.equal(messages.at(-1).ok,true);
  assert.equal(sw.peak,2);assert.equal(sw.requests.length,3);
  assert.equal(sw.requests.filter(url=>url===`${scope}${audio}`).length,1);
});

test('a full pack cannot announce offline readiness while any audio is missing',async()=>{
  const sw=worker({failPaths:[audio]}),messages=await sw.message({type:'CACHE_MODELS'});
  assert.equal(messages.at(-1).ok,false);assert.deepEqual(Array.from(messages.at(-1).failed),[audio]);
});

test('a stale 200 response at an updated asset URL is never stored under the new fingerprint',async()=>{
  const sw=worker({changed:[model]});
  assert.deepEqual(new Uint8Array(await(await sw.request(model)).arrayBuffer()),bytes,'online response still arrives without waiting for persistence');
  assert.equal(sw.writes.length,0,'old bytes must not be labelled with the new revision');
  sw.goOffline();await assert.rejects(sw.request(model),/offline/);
});

test('explicit preparation checks actual bytes before announcing a resource is offline-ready',async()=>{
  const sw=worker({changed:[audio]}),messages=await sw.message({type:'CACHE_LESSON',paths:[audio]});
  assert.equal(messages.at(-1).ok,false);assert.deepEqual(Array.from(messages.at(-1).failed),[audio]);
  assert.equal(sw.writes.length,0);
});

test('hashed JS and CSS survive a code-only release without being downloaded by installation again',async()=>{
  const first=worker({bundle:true});await first.install();await first.message({type:'CACHE_MODELS'});
  const next=worker({bundle:true,buckets:first.buckets,version:'0.7.1'});await next.install();await next.activate();
  assert.equal(next.requests.some(url=>url.includes('/assets/chunks/')),false,'unchanged hashed chunks must be reused even during installation');
  next.goOffline();
  for(const path of ['assets/chunks/app-ABC123.js','assets/chunks/three-DEF456.js','assets/chunks/app-ABC123.css']){
    assert.deepEqual(new Uint8Array(await(await next.request(path)).arrayBuffer()),bytes);
    assert.deepEqual(new Uint8Array(await(await next.request(`${path}?v=0.7.1`)).arrayBuffer()),bytes);
    assert.equal(await next.request(`${path}?v=0.6.4`),undefined,'a foreign version remains a browser request');
  }
});
