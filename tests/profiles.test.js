import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { loadProfiles,createProfile,deleteProfile,getProfile,profileStorageKey,normalizeProfileName } from '../src/profiles.js';
import { loadProgress,saveProgress,getClip,putClip } from '../src/storage.js';
import { createInitialProgress,selectUnit } from '../src/learning.js';

let values,audio,failWrites,failAudio,descriptors;
beforeEach(()=>{
  descriptors=Object.fromEntries(['localStorage','indexedDB'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  values=new Map();audio=new Map();failWrites=false;failAudio=false;
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:key=>values.get(key)??null,
    setItem(key,value){if(failWrites)throw new Error('QuotaExceededError');values.set(key,String(value));},
    removeItem:key=>values.delete(key),key:index=>[...values.keys()][index]??null,get length(){return values.size;},
  }});
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){
    const request={};queueMicrotask(()=>{request.result={close(){},objectStoreNames:{contains:()=>true},transaction(name,mode){
      const tx={},working=new Map(audio);let pending=0,finished=false;
      const commit=()=>queueMicrotask(()=>{if(!finished&&pending===0){finished=true;if(mode==='readwrite'){audio.clear();for(const [k,v]of working)audio.set(k,v);}tx.oncomplete?.();}});
      const operation=fn=>{const r={};pending++;queueMicrotask(()=>{
        if(finished)return;
        try {if(failAudio&&mode==='readwrite')throw new Error('simulated audio failure');r.result=fn();r.onsuccess?.();}
        catch(error){finished=true;tx.error=error;tx.onabort?.();}
        finally {pending--;commit();}
      });return r;};
      tx.objectStore=()=>({get:key=>operation(()=>working.get(key)),put:(value,key)=>operation(()=>{working.set(key,value);return key;}),delete:key=>operation(()=>working.delete(key)),getAllKeys:()=>operation(()=>[...working.keys()])});
      tx.abort=()=>{if(!finished){finished=true;tx.onabort?.();}};return tx;
    }};request.onsuccess?.();});return request;
  }}});
});
afterEach(()=>{for(const [key,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});

test('names accept only Chinese and English, normalize full-width letters and reject empty or long names',()=>{
  assert.equal(normalizeProfileName(' 小明Alice '),'小明Alice');
  assert.equal(normalizeProfileName('Ａlice'),'Alice');
  for(const name of ['', '   ','小 明','Alice Bob','小明1','Amy!','🦊','é','A'.repeat(13),null])assert.throws(()=>normalizeProfileName(name));
});

test('up to three unique users get stable random identifiers; casing cannot create a duplicate',async()=>{
  assert.deepEqual(loadProfiles(),{profiles:[],error:null,legacyAvailable:false});
  const first=await createProfile('Alice');
  assert.equal(getProfile(first.id).name,'Alice');assert(!first.id.toLowerCase().includes('alice'));
  await assert.rejects(createProfile('ALICE'),/已经|重名|存在/);
  const second=await createProfile('小明'),third=await createProfile('小红');
  assert.equal(new Set([first.id,second.id,third.id]).size,3);
  await assert.rejects(createProfile('第四位'),/最多|3/);
  assert.equal(loadProfiles().profiles.length,3);
});

test('concurrent creates cannot bypass the three-user limit',async()=>{
  const results=await Promise.allSettled(['甲','乙','丙','丁'].map(createProfile));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,3);
  assert.equal(loadProfiles().profiles.length,3);
});

test('progress, reading, guide and backups are independent while imported lesson audio is shared',async()=>{
  const a=await createProfile('小明'),b=await createProfile('小红');
  saveProgress(selectUnit(createInitialProgress(),'kb3-u3'),a.id);
  assert.equal(loadProgress(a.id).progress.selectedUnitId,'kb3-u3');
  assert.equal(loadProgress(b.id).progress.selectedUnitId,'kb3-hello');
  for(const kind of ['reading','guide','before-import','unreadable-backup']){
    localStorage.setItem(profileStorageKey(a.id,kind),'A only');
    assert.equal(localStorage.getItem(profileStorageKey(b.id,kind)),null);
  }
  const clip=new Blob(['recording A'],{type:'audio/webm'}),lesson=new Blob(['lesson'],{type:'audio/mp4'});
  await putClip('recording:2026-11-16:kb3-hello-1',clip,a.id);
  assert.equal((await getClip('recording:2026-11-16:kb3-hello-1',a.id)).size,clip.size);
  assert.equal(await getClip('recording:2026-11-16:kb3-hello-1',b.id),null);
  await putClip('word:milk',lesson,a.id);
  assert.equal((await getClip('word:milk',b.id)).size,lesson.size);
});

test('deleting one user clears all its data and recordings, preserving other users and shared lesson clips',async()=>{
  const a=await createProfile('小明'),b=await createProfile('小红');
  for(const p of [a,b]){
    saveProgress(createInitialProgress(),p.id);
    for(const kind of ['reading','guide','before-import','unreadable-backup'])localStorage.setItem(profileStorageKey(p.id,kind),'saved');
    await putClip('recording:2026-11-16:kb3-hello-1',new Blob([p.name],{type:'audio/webm'}),p.id);
  }
  await putClip('word:milk',new Blob(['shared'],{type:'audio/mp4'}),a.id);
  await deleteProfile(a.id);
  assert.equal(getProfile(a.id),null);assert.equal(getProfile(b.id).name,'小红');
  assert.equal([...values.keys()].some(key=>key.includes(a.id)),false);
  assert.equal([...audio.keys()].some(key=>key.includes(a.id)),false);
  assert((await getClip('recording:2026-11-16:kb3-hello-1',b.id)).size>0);
  assert((await getClip('word:milk',b.id)).size>0);
  await assert.rejects(putClip('recording:2026-11-16:kb3-hello-1',new Blob(['late'],{type:'audio/webm'}),a.id));
});

test('the first named user receives legacy progress, flags, backups and recordings exactly once',async()=>{
  const old=selectUnit(createInitialProgress(),'kb3-u4');
  values.set('word-island:progress:v1',JSON.stringify(old));
  values.set('word-island:reading:v1','["2026-11-16:kb3-u4"]');
  values.set('word-island:guide:v1','{"version":1,"status":"finished","intro":4}');
  values.set('word-island:before-import','backup');
  values.set('word-island:unreadable-backup','raw backup');
  audio.set('recording:2026-11-16:kb3-u4-1',new Blob(['legacy'],{type:'audio/webm'}));
  audio.set('word:milk',new Blob(['shared'],{type:'audio/mp4'}));
  assert.equal(loadProfiles().legacyAvailable,true);
  const first=await createProfile('小明'),second=await createProfile('小红');
  assert.equal(loadProgress(first.id).progress.selectedUnitId,'kb3-u4');
  assert.equal(loadProgress(second.id).progress.selectedUnitId,'kb3-hello');
  assert.equal(localStorage.getItem(profileStorageKey(first.id,'reading')),'["2026-11-16:kb3-u4"]');
  assert.equal(localStorage.getItem(profileStorageKey(first.id,'before-import')),'backup');
  assert((await getClip('recording:2026-11-16:kb3-u4-1',first.id)).size>0);
  assert.equal(await getClip('recording:2026-11-16:kb3-u4-1',second.id),null);
  assert.equal(audio.has('recording:2026-11-16:kb3-u4-1'),false);
  assert.equal(loadProfiles().legacyAvailable,false);
  await deleteProfile(first.id);
  const third=await createProfile('小刚');
  assert.equal(loadProgress(third.id).progress.selectedUnitId,'kb3-hello');
});

test('legacy recordings without text progress belong only to the first named user and are removed with that user',async()=>{
  const key='recording:2026-11-16:kb3-hello-1';
  audio.set(key,new Blob(['legacy recording'],{type:'audio/webm'}));
  audio.set('word:milk',new Blob(['shared word'],{type:'audio/mp4'}));
  audio.set('phrase:hello',new Blob(['shared phrase'],{type:'audio/mp4'}));
  const first=await createProfile('小明'),second=await createProfile('小红');
  assert((await getClip(key,first.id))?.size>0);
  assert.equal(await getClip(key,second.id),null);
  assert.equal(audio.has(key),false);
  await deleteProfile(first.id);
  assert.equal([...audio.keys()].some(key=>key.includes(first.id)),false);
  assert.deepEqual([...audio.keys()].sort(),['phrase:hello','word:milk']);
  const third=await createProfile('小刚');
  assert.equal(await getClip(key,third.id),null);
  assert((await getClip('word:milk',second.id)).size>0);
  assert((await getClip('phrase:hello',third.id)).size>0);
});

test('naming valid v1 progress commits the complete history in the current v3 schema',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/kb2-v1-progress.json',import.meta.url),'utf8'));
  values.set('word-island:progress:v1',JSON.stringify(fixture));
  const profile=await createProfile('小明');
  const migrated=JSON.parse(localStorage.getItem(profileStorageKey(profile.id,'progress')));
  assert.equal(migrated.version,3);
  assert.deepEqual(migrated.words,fixture.words);assert.deepEqual(migrated.rewardDates,fixture.rewardDates);assert.deepEqual(migrated.companions,fixture.companions);
  for(const [date,day]of Object.entries(fixture.days))assert.deepEqual(migrated.days[date],{...day,plan:{...day.plan,unitId:'kb2-u6'}});
});

test('unreadable legacy progress remains recoverable in the named profile instead of being discarded',async()=>{
  values.set('word-island:progress:v1','{unreadable original');
  const profile=await createProfile('小明');
  assert.equal(localStorage.getItem(profileStorageKey(profile.id,'progress')),'{unreadable original');
  assert(loadProgress(profile.id).error);
  assert.equal(loadProfiles().profiles.length,1);
});

test('failed migration or registration retains legacy sources and does not create a half user',async()=>{
  const original=JSON.stringify(createInitialProgress());values.set('word-island:progress:v1',original);
  audio.set('recording:2026-11-16',new Blob(['legacy'],{type:'audio/webm'}));
  failAudio=true;await assert.rejects(createProfile('小明'));
  assert.equal(loadProfiles().profiles.length,0);assert.equal(values.get('word-island:progress:v1'),original);assert(audio.has('recording:2026-11-16'));
  failAudio=false;failWrites=true;await assert.rejects(createProfile('小明'));
  assert.equal(values.get('word-island:progress:v1'),original);assert.equal(audio.size,1);
});

test('corrupt registry is reported and never replaced by creating a new user',async()=>{
  values.set('word-island:profiles:v1','{broken');
  assert(loadProfiles().error);
  await assert.rejects(createProfile('小明'));
  assert.equal(values.get('word-island:profiles:v1'),'{broken');
});

test('a failed final registration rolls back staged audio and private flags without touching legacy data',async()=>{
  values.set('word-island:progress:v1',JSON.stringify(createInitialProgress()));
  values.set('word-island:guide:v1','old guide');
  audio.set('recording:2026-11-16',new Blob(['legacy'],{type:'audio/webm'}));
  const nativeSet=localStorage.setItem;let registryWrites=0;
  localStorage.setItem=(key,value)=>{if(key==='word-island:profiles:v1'&&++registryWrites===2)throw new Error('simulated final quota failure');nativeSet(key,value);};
  await assert.rejects(createProfile('小明'),/原有数据仍保留/);
  assert.equal(loadProfiles().profiles.length,0);
  assert.equal([...values.keys()].some(key=>key.startsWith('word-island:profile:')),false);
  assert.deepEqual([...audio.keys()],['recording:2026-11-16']);
  assert.equal(values.get('word-island:guide:v1'),'old guide');
});

test('a failed audio deletion does not silently remove the user or its progress',async()=>{
  const profile=await createProfile('小明');saveProgress(createInitialProgress(),profile.id);
  await putClip('recording:2026-11-16',new Blob(['keep on failure'],{type:'audio/webm'}),profile.id);
  const oldProgress=localStorage.getItem(profileStorageKey(profile.id,'progress'));
  failAudio=true;await assert.rejects(deleteProfile(profile.id));failAudio=false;
  assert.equal(getProfile(profile.id).name,'小明');
  assert.equal(localStorage.getItem(profileStorageKey(profile.id,'progress')),oldProgress);
  assert((await getClip('recording:2026-11-16',profile.id)).size>0);
});

test('a recording callback queued after deletion cannot recreate data for the deleted identifier',async()=>{
  const profile=await createProfile('小明');
  const result=await Promise.allSettled([deleteProfile(profile.id),putClip('recording:2026-11-16',new Blob(['late'],{type:'audio/webm'}),profile.id)]);
  assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');
  assert.equal([...audio.keys()].some(key=>key.includes(profile.id)),false);
  assert.throws(()=>saveProgress(createInitialProgress(),profile.id));
});
