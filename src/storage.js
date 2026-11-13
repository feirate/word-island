import { createInitialProgress, validateProgress } from './learning.js';

const PROGRESS_KEY = 'word-island:progress:v1';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CLIP_BYTES = 15 * 1024 * 1024;
const AUDIO_DB = 'word-island-audio';
const AUDIO_STORE = 'clips';

function checkTextSize(text) {
  if (typeof text !== 'string') throw new Error('请选择包含学习进度的 JSON 文本文件。');
  if (text.length >= MAX_JSON_BYTES || new TextEncoder().encode(text).byteLength >= MAX_JSON_BYTES) {
    throw new Error('学习进度文件过大，请使用小于 1 MiB 的 JSON 文件。');
  }
}

export function loadProgress() {
  try {
    const text = globalThis.localStorage.getItem(PROGRESS_KEY);
    if (text === null) return { progress: createInitialProgress(), error: null };
    checkTextSize(text);
    return { progress: validateProgress(JSON.parse(text)), error: null };
  } catch {
    return {
      progress: createInitialProgress(),
      error: '本机学习进度读取失败，可能已损坏或浏览器禁用了存储。原记录尚未删除，可从导出的进度文件恢复。',
    };
  }
}

export function saveProgress(progress) {
  let text;
  try {
    text = JSON.stringify(validateProgress(progress));
    checkTextSize(text);
  } catch (error) {
    throw new Error(`学习进度未保存：${error.message}`);
  }
  try {
    globalThis.localStorage.setItem(PROGRESS_KEY, text);
  } catch {
    throw new Error('本机学习进度保存失败，可能是存储空间不足或浏览器禁用了存储。请先导出进度文件备份。');
  }
}

export function exportProgress(progress) {
  const text = JSON.stringify({
    app: 'word-island', version: 1, exportedAt: new Date().toISOString(), progress: validateProgress(progress),
  }, null, 2);
  checkTextSize(text);
  return text;
}

export function importProgress(text) {
  checkTextSize(text);
  let envelope;
  try { envelope = JSON.parse(text); }
  catch { throw new Error('进度文件不是有效的 JSON，请重新选择导出的文件。'); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).some(key => !['app', 'version', 'exportedAt', 'progress'].includes(key))
    || envelope.app !== 'word-island' || envelope.version !== 1
    || typeof envelope.exportedAt !== 'string' || !Number.isFinite(Date.parse(envelope.exportedAt))) {
    throw new Error('进度文件格式或版本不兼容，请使用词遇岛导出的进度文件。');
  }
  // Import only parses: the caller can review before explicitly saving.
  return validateProgress(envelope.progress);
}

function checkClipKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 100 || !/^[A-Za-z0-9:_-]+$/.test(key)) {
    throw new Error('音频标识名称无效：请使用不超过 100 位的字母、数字、冒号、短横线或下划线。');
  }
}

function audioError(error) {
  return new Error(error?.name === 'QuotaExceededError'
    ? '音频保存失败，本机存储空间不足。请检查浏览器存储空间。'
    : '本机音频库无法读取或保存，请检查浏览器是否允许本地存储。');
}

function openAudioDb() {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const fail = error => {
      if (!settled) { settled = true; reject(error); }
    };
    try {
      if (!globalThis.indexedDB) throw new Error('IndexedDB unavailable');
      request = globalThis.indexedDB.open(AUDIO_DB, 1);
    } catch (error) { fail(audioError(error)); return; }
    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(AUDIO_STORE)) request.result.createObjectStore(AUDIO_STORE);
      } catch (error) {
        request.transaction?.abort();
        fail(audioError(error));
      }
    };
    request.onerror = () => fail(audioError(request.error));
    request.onblocked = () => fail(new Error('音频库正在被其他窗口使用，请关闭其他词遇岛窗口后重试。'));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function audioRequest(mode, operation) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    let settled = false;
    let value;
    const finish = error => {
      if (settled) return;
      settled = true;
      db.close();
      if (error) reject(audioError(error));
      else resolve(value);
    };
    try {
      const transaction = db.transaction(AUDIO_STORE, mode);
      transaction.oncomplete = () => finish(null);
      transaction.onerror = () => finish(transaction.error ?? new Error('Audio transaction failed'));
      transaction.onabort = () => finish(transaction.error ?? new Error('Audio transaction aborted'));
      const request = operation(transaction.objectStore(AUDIO_STORE));
      request.onsuccess = () => { value = request.result; };
      // A successful request alone is insufficient: resolve after transaction commit.
    } catch (error) { finish(error); }
  });
}

export async function getClip(key) {
  checkClipKey(key);
  const clip = await audioRequest('readonly', store => store.get(key));
  if (clip === undefined || clip === null) return null;
  if (!(clip instanceof Blob) || !clip.type.startsWith('audio/')) throw new Error('本机保存的音频格式无效，请重新导入或录音。');
  return clip;
}

export async function putClip(key, blob) {
  checkClipKey(key);
  if (!(blob instanceof Blob) || !blob.type.startsWith('audio/') || blob.size === 0) {
    throw new Error('请选择有内容的音频文件，文件类型须为 audio/ 开头。');
  }
  if (blob.size > MAX_CLIP_BYTES) throw new Error('单个音频文件过大，请选择不超过 15 MiB 的文件。');
  await audioRequest('readwrite', store => store.put(blob, key));
}
