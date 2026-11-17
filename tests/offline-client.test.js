import test from 'node:test';
import assert from 'node:assert/strict';
const moduleURL=new URL('../src/offline-client.js',import.meta.url);

test('a lesson prepares only its own normal/slow examples plus due review words',async()=>{
  const {lessonAudioFiles}=await import(moduleURL);
  const files=lessonAudioFiles({unitIds:['kb3-hello','kb3-hello'],wordIds:['milk','comic']});
  assert.equal(files.length,22);assert.equal(new Set(files).size,22);
  assert(files.includes('assets/audio/word-milk-slow.m4a'));assert(files.includes('assets/audio/phrase-kb3-hello-1.m4a'));
  assert.equal(files.some(file=>file.includes('kb3-u8')),false);
});

function channelFixture(){
  let closed=0,receive;const channel={port1:{set onmessage(value){receive=value;},close(){closed++;}},port2:{close(){closed++;}}};
  return {channel,send:data=>receive?.({data}),closed:()=>closed};
}
test('progress does not claim completion; the final worker reply closes the message channel',async()=>{
  const {requestPreparation}=await import(moduleURL);const f=channelFixture(),progress=[],posted=[];let done=false;
  const result=requestPreparation({postMessage:message=>posted.push(message)},{type:'CACHE_LESSON',paths:['one'],onProgress:value=>progress.push(value),createChannel:()=>f.channel});
  result.then(()=>{done=true;});await Promise.resolve();f.send({type:'CACHE_PROGRESS',completed:1,total:2});await Promise.resolve();assert.equal(done,false);
  f.send({type:'LESSON_CACHED',version:'0.7.0',ok:true});assert.equal((await result).ok,true);assert.equal(progress.length,1);assert.equal(f.closed(),2);
  assert.deepEqual(posted,[{type:'CACHE_LESSON',paths:['one']}]);
});
test('missing worker progress times out, cleans ports, and a late registration sends no request',async()=>{
  const {requestPreparation}=await import(moduleURL);const f=channelFixture();let release,sent=0;
  const worker=new Promise(resolve=>{release=resolve;});
  await assert.rejects(requestPreparation(worker,{type:'CACHE_MODELS',idleMs:20,totalMs:200,createChannel:()=>f.channel}),/没有新进度/);
  release({postMessage:()=>sent++});await Promise.resolve();assert.equal(sent,0);assert.equal(f.closed(),2);
});
test('continuous file progress can outlast the idle deadline, with a separate total limit',async()=>{
  const {requestPreparation}=await import(moduleURL);const f=channelFixture();
  const result=requestPreparation({postMessage(){}},{type:'CACHE_MODELS',idleMs:40,totalMs:300,createChannel:()=>f.channel});
  let completed=0;const timer=setInterval(()=>f.send({type:'CACHE_PROGRESS',completed:++completed,total:20}),10);
  try{await new Promise(resolve=>setTimeout(resolve,90));f.send({type:'MODELS_CACHED',ok:true,version:'0.7.0'});assert.equal((await result).ok,true);}finally{clearInterval(timer);}
  const g=channelFixture();const capped=requestPreparation({postMessage(){}},{type:'CACHE_MODELS',idleMs:100,totalMs:30,createChannel:()=>g.channel});
  await assert.rejects(capped,/用时较长/);assert.equal(g.closed(),2);
});

test('lesson preparation ignores stale replies and deduplicates the current lesson',async()=>{
  const {createLessonPreparer}=await import(moduleURL);const pending=[],ready=[];
  const lessons=createLessonPreparer({version:'0.7.0',prepare:paths=>new Promise(resolve=>pending.push({paths,resolve})),onReady:paths=>ready.push(paths)});
  const first=lessons.prepare(['hello']);assert.equal(await lessons.prepare(['hello']),false);
  const next=lessons.prepare(['family']);pending[0].resolve({ok:true,version:'0.7.0'});await first;assert.deepEqual(ready,[]);
  pending[1].resolve({ok:true,version:'0.7.0'});await next;assert.deepEqual(ready,[['family']]);
});

test('a failed lesson can retry after a cooldown, and a profile/network reset permits an immediate retry',async()=>{
  const {createLessonPreparer}=await import(moduleURL);let now=0,calls=0,ready=0;
  const lessons=createLessonPreparer({version:'0.7.0',now:()=>now,prepare:async()=>({ok:++calls>1,version:'0.7.0'}),onReady:()=>ready++});
  assert.equal(await lessons.prepare(['hello']),false);now=1000;assert.equal(await lessons.prepare(['hello']),false);assert.equal(calls,1);
  now=31000;assert.equal(await lessons.prepare(['hello']),true);assert.equal(calls,2);assert.equal(ready,1);
  lessons.reset();assert.equal(await lessons.prepare(['hello']),true);assert.equal(calls,3);
});

test('old worker versions and replies from a departed profile cannot claim the current unit is ready',async()=>{
  const {createLessonPreparer}=await import(moduleURL);let release,ready=0;
  const lessons=createLessonPreparer({version:'0.7.0',prepare:()=>new Promise(resolve=>{release=resolve;}),onReady:()=>ready++});
  const old=lessons.prepare(['hello']);lessons.reset();release({ok:true,version:'0.7.0'});await old;assert.equal(ready,0);
  const wrong=lessons.prepare(['hello']);release({ok:true,version:'0.6.4'});await wrong;assert.equal(ready,0);
});
