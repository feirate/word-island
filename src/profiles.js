import {validateProgress} from './learning.js';

export const MAX_PROFILES = 3;
export const PROFILE_REGISTRY_KEY = 'word-island:profiles:v1';
const KINDS = ['progress','reading','guide','before-import','unreadable-backup'];
const LEGACY_KEYS = {
  progress:'word-island:progress:v1', reading:'word-island:reading:v1', guide:'word-island:guide:v1',
  'before-import':'word-island:before-import', 'unreadable-backup':'word-island:unreadable-backup',
};
let operations = Promise.resolve();

export function normalizeProfileName(value) {
  if(typeof value!=='string')throw new Error('请输入你的名字。');
  const name=value.normalize('NFKC').trim();
  if(!name||Array.from(name).length>12||! /^[\p{Script=Han}A-Za-z]+$/u.test(name))throw new Error('名字只能使用中文和英文字母，长度为 1–12 个字，不能包含数字、空格或符号。');
  return name;
}

function checkId(id) {
  if(typeof id!=='string'||!/^p_[a-f0-9]{32}$/.test(id))throw new Error('本地用户标识无效，请重新选择用户。');
  return id;
}

export function profileStorageKey(id,kind) {
  checkId(id);
  if(!KINDS.includes(kind))throw new Error('本地用户数据类型无效。');
  return `word-island:profile:${id}:${kind}`;
}

function readRegistry() {
  let text;
  try {text=globalThis.localStorage.getItem(PROFILE_REGISTRY_KEY);}catch {throw new Error('本机用户列表无法读取，请检查浏览器是否允许本地存储。');}
  if(text===null)return {version:1,profiles:[],legacyClaimed:false,legacyOwnerId:null};
  try {
    const value=JSON.parse(text);
    if(!value||value.version!==1||!Array.isArray(value.profiles)||value.profiles.length>MAX_PROFILES||typeof value.legacyClaimed!=='boolean'||!Object.keys(value).every(key=>['version','profiles','legacyClaimed','legacyOwnerId'].includes(key)))throw new Error();
    const ids=new Set(),names=new Set();
    for(const profile of value.profiles){
      if(!profile||!Object.keys(profile).every(key=>['id','name','createdAt'].includes(key))||typeof profile.createdAt!=='string'||!Number.isFinite(Date.parse(profile.createdAt)))throw new Error();
      checkId(profile.id);
      if(normalizeProfileName(profile.name)!==profile.name||ids.has(profile.id)||names.has(profile.name.toLowerCase()))throw new Error();
      ids.add(profile.id);names.add(profile.name.toLowerCase());
    }
    if(value.legacyOwnerId!==null&&(!value.legacyClaimed||!ids.has(value.legacyOwnerId)))throw new Error();
    return value;
  }catch {throw new Error('本机用户列表已损坏，原记录尚未删除，请先保留网站数据。');}
}

function writeRegistry(value) {
  try {globalThis.localStorage.setItem(PROFILE_REGISTRY_KEY,JSON.stringify(value));}
  catch {throw new Error('本机用户列表保存失败，可能存储空间不足或浏览器禁用了存储。');}
}

function legacyEntries() {
  return Object.entries(LEGACY_KEYS).map(([kind,key])=>({kind,key,text:globalThis.localStorage.getItem(key)})).filter(entry=>entry.text!==null);
}

export function loadProfiles() {
  try {
    const registry=readRegistry();
    return {profiles:structuredClone(registry.profiles),error:null,legacyAvailable:!registry.legacyClaimed&&registry.profiles.length===0&&legacyEntries().length>0};
  }catch(error){return {profiles:[],error:error.message,legacyAvailable:false};}
}

export function getProfile(id) {
  checkId(id);
  const profile=readRegistry().profiles.find(profile=>profile.id===id);
  return profile?{...profile}:null;
}

// The same lock serializes recording writes and profile removal, including across
// tabs when Web Locks is available. No active-user preference is persisted.
export function withProfileStorageLock(operation) {
  const pending=operations.catch(()=>{}).then(()=>{
    const locks=globalThis.navigator?.locks;
    return locks?.request?locks.request('word-island:profiles',{mode:'exclusive'},operation):operation();
  });
  operations=pending.then(()=>{},()=>{});
  return pending;
}

function newId() {
  if(globalThis.crypto?.randomUUID)return `p_${globalThis.crypto.randomUUID().replaceAll('-','')}`;
  if(globalThis.crypto?.getRandomValues)return `p_${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('')}`;
  throw new Error('这个浏览器暂时无法创建本地用户，请换用支持本地存储的浏览器。');
}

export function createProfile(value) {
  return withProfileStorageLock(async()=>{
    const name=normalizeProfileName(value),registry=readRegistry();
    if(registry.profiles.some(profile=>profile.name.toLowerCase()===name.toLowerCase()))throw new Error('已经有这个名字了，请换一个名字。');
    if(registry.profiles.length>=MAX_PROFILES)throw new Error('最多只能创建 3 个本地用户。');
    const profile={id:newId(),name,createdAt:new Date().toISOString()};
    const claimLegacy=!registry.legacyClaimed&&registry.profiles.length===0;
    const old=claimLegacy?legacyEntries():[];
    // Check write access before copying audio; old files remain authoritative
    // until the final single registry write makes this complete user visible.
    writeRegistry(registry);
    const copied=[];
    try {
      for(const entry of old){
        const key=profileStorageKey(profile.id,entry.kind);let text=entry.text;
        if(entry.kind==='progress'){try{text=JSON.stringify(validateProgress(JSON.parse(text)));}catch{ /* Keep unreadable originals available to the existing recovery flow. */ }}
        globalThis.localStorage.setItem(key,text);copied.push(key);
      }
      if(claimLegacy){const audio=await import('./storage.js');await audio.copyLegacyRecordings(profile.id);}
      writeRegistry({...registry,profiles:[...registry.profiles,profile],legacyClaimed:true,legacyOwnerId:claimLegacy?profile.id:registry.legacyOwnerId});
    }catch(error){
      for(const key of copied){try{globalThis.localStorage.removeItem(key);}catch{}}
      if(claimLegacy){try{const audio=await import('./storage.js');await audio.deleteProfileRecordings(profile.id);}catch{}}
      throw new Error(`用户尚未创建，原有数据仍保留。${error.message}`);
    }
    // Cleanup is after commitment. If it is interrupted, the owner marker stops
    // another user claiming old data and deletion also removes these remnants.
    if(claimLegacy){
      try {
        const audio=await import('./storage.js');await audio.deleteLegacyRecordings();
        for(const entry of old)globalThis.localStorage.removeItem(entry.key);
      }catch { /* A complete scoped copy exists; retain old sources for recovery. */ }
    }
    return {...profile};
  });
}

export function deleteProfile(id) {
  checkId(id);
  return withProfileStorageLock(async()=>{
    const registry=readRegistry();
    if(!registry.profiles.some(profile=>profile.id===id))return false;
    writeRegistry(registry);
    const audio=await import('./storage.js');
    await audio.deleteProfileRecordings(id,{includeLegacy:registry.legacyOwnerId===id});
    try {
      const prefix=`word-island:profile:${id}:`,storage=globalThis.localStorage;
      const keys=Array.from({length:storage.length},(_,index)=>storage.key(index)).filter(key=>key?.startsWith(prefix));
      for(const kind of KINDS)keys.push(profileStorageKey(id,kind));
      for(const key of new Set(keys))storage.removeItem(key);
      if(registry.legacyOwnerId===id)for(const key of Object.values(LEGACY_KEYS))storage.removeItem(key);
      writeRegistry({...registry,profiles:registry.profiles.filter(profile=>profile.id!==id),legacyOwnerId:registry.legacyOwnerId===id?null:registry.legacyOwnerId});
    }catch(error){throw new Error(`用户删除未完成，请重试。${error.message}`);}
    return true;
  });
}
