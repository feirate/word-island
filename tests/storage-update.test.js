import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/storage.js';
import {PROFILE_REGISTRY_KEY,profileStorageKey,createProfile,deleteProfile,loadProfiles} from '../src/profiles.js';
import {createInitialProgress,applyAnswer,selectUnit} from '../src/learning.js';

const id=`p_${'a'.repeat(32)}`;
const dateKey='2026-11-16';
let values,descriptors,failKey;
beforeEach(()=>{
  values=new Map();failKey=null;
  descriptors=Object.fromEntries(['localStorage','indexedDB'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:key=>values.get(key)??null,
    setItem(key,value){if(key===failKey)throw new Error('QuotaExceededError');values.set(key,String(value));},
    removeItem:key=>values.delete(key),key:index=>[...values.keys()][index]??null,get length(){return values.size;},
  }});
  // Deletion still uses its real IndexedDB path; this fixture has no audio.
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){
    const request={};queueMicrotask(()=>{request.result={close(){},objectStoreNames:{contains:()=>true},transaction(){
      const tx={objectStore:()=>({getAllKeys(){const r={};queueMicrotask(()=>{r.result=[];r.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.());});return r;}})};return tx;
    }};request.onsuccess?.();});return request;
  }}});
  values.set(PROFILE_REGISTRY_KEY,JSON.stringify({version:1,profiles:[{id,name:'测试',createdAt:'2026-11-16T00:00:00Z'}],legacyClaimed:true,legacyOwnerId:null}));
});
afterEach(()=>{for(const [key,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
const answer=(progress,skill)=>applyAnswer(progress,{wordId:'comic',skill,correct:true,dateKey});

test('queued updates read the latest stored progress and keep both skills',async()=>{
  let release,started;
  const held=new Promise(resolve=>{release=resolve;});
  const entered=new Promise(resolve=>{started=resolve;});
  const first=storage.updateProgress(id,async latest=>{started();await held;return answer(latest,'listen');});
  await entered;
  const second=storage.updateProgress(id,latest=>answer(latest,'spell'));
  release();const [,result]=await Promise.all([first,second]);
  assert.equal(result.words.comic.listen.attempts,1);assert.equal(result.words.comic.spell.attempts,1);
  assert.deepEqual(storage.loadProgress(id).progress,result);
});

test('queued profile deletion prevents a late update from recreating private progress and keeps the three-user cap',async()=>{
  storage.saveProgress(createInitialProgress(),id);
  const removal=deleteProfile(id);
  const late=storage.updateProgress(id,latest=>answer(latest,'listen'));
  await removal;await assert.rejects(late,/不存在|用户/);
  assert.equal([...values.keys()].some(key=>key.includes(id)),false);
  const creations=await Promise.allSettled(['甲','乙','丙','丁'].map(createProfile));
  assert.equal(creations.filter(result=>result.status==='fulfilled').length,3);
  assert.equal(loadProfiles().profiles.length,3);
});

test('unreadable progress blocks an ordinary update without replacing the original',async()=>{
  const key=profileStorageKey(id,'progress');values.set(key,'{broken');
  await assert.rejects(storage.updateProgress(id,latest=>answer(latest,'listen')),/损坏|读取|恢复/);
  assert.equal(values.get(key),'{broken');assert.equal(values.has(profileStorageKey(id,'unreadable-backup')),false);
});

test('explicit recovery keeps the unreadable original before saving fresh progress',async()=>{
  const key=profileStorageKey(id,'progress');values.set(key,'{broken');
  const next=await storage.updateProgress(id,latest=>answer(latest,'listen'),{allowRecovery:true});
  assert.equal(values.get(profileStorageKey(id,'unreadable-backup')),'{broken');
  assert.equal(next.words.comic.listen.correct,1);assert.equal(storage.loadProgress(id).error,null);
});

test('recovery preserves an earlier unreadable backup and refuses to write if the first backup fails',async()=>{
  const key=profileStorageKey(id,'progress'),backup=profileStorageKey(id,'unreadable-backup');
  values.set(key,'{broken');failKey=backup;
  await assert.rejects(storage.updateProgress(id,latest=>answer(latest,'listen'),{allowRecovery:true}),/备份|存储/);
  assert.equal(values.get(key),'{broken');assert.equal(values.has(backup),false);
  failKey=null;values.set(backup,'{first original');
  await storage.updateProgress(id,latest=>answer(latest,'listen'),{allowRecovery:true});
  assert.equal(values.get(backup),'{first original');
});

test('import replacement backs up the latest committed progress inside the update lock',async()=>{
  const first=storage.updateProgress(id,latest=>answer(latest,'listen'));
  const replacement=selectUnit(createInitialProgress(),'kb3-u2');
  const imported=storage.updateProgress(id,()=>replacement,{beforeImportBackup:true});
  await first;await imported;
  const backup=storage.importProgress(values.get(profileStorageKey(id,'before-import')));
  assert.equal(backup.words.comic.listen.correct,1);
  assert.deepEqual(storage.loadProgress(id).progress,replacement);
});

test('failed import backup, invalid mutation and save failure preserve prior progress and release the lock',async()=>{
  const original=createInitialProgress();storage.saveProgress(original,id);
  failKey=profileStorageKey(id,'before-import');
  await assert.rejects(storage.updateProgress(id,latest=>answer(latest,'listen'),{beforeImportBackup:true}),/备份|存储/);
  assert.deepEqual(storage.loadProgress(id).progress,original);
  failKey=null;await assert.rejects(storage.updateProgress(id,()=>({version:99})));
  failKey=profileStorageKey(id,'progress');await assert.rejects(storage.updateProgress(id,latest=>answer(latest,'listen')));
  assert.deepEqual(storage.loadProgress(id).progress,original);
  failKey=null;const next=await storage.updateProgress(id,latest=>answer(latest,'spell'));
  assert.equal(next.words.comic.spell.correct,1);
});
