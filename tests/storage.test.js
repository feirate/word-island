import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialProgress } from '../src/learning.js';
import { loadProgress, saveProgress, exportProgress, importProgress, getClip, putClip } from '../src/storage.js';

const PROGRESS_KEY = 'word-island:progress:v1';
let values;
let storageDescriptor;
let dbDescriptor;

beforeEach(() => {
  storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  dbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  } });
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
});

afterEach(() => {
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else delete globalThis.localStorage;
  if (dbDescriptor) Object.defineProperty(globalThis, 'indexedDB', dbDescriptor);
  else delete globalThis.indexedDB;
});

test('missing local progress starts fresh; saved JSON round trips through validation', () => {
  assert.deepEqual(loadProgress(), { progress: createInitialProgress(), error: null });
  const progress = createInitialProgress();
  saveProgress(progress);
  assert.deepEqual(JSON.parse(values.get(PROGRESS_KEY)), progress);
  assert.deepEqual(loadProgress(), { progress, error: null });
});

test('invalid local data is reported without deleting the existing data', () => {
  values.set(PROGRESS_KEY, '{broken');
  const loaded = loadProgress();
  assert.deepEqual(loaded.progress, createInitialProgress());
  assert.match(loaded.error, /读取|损坏|恢复/);
  assert.equal(values.get(PROGRESS_KEY), '{broken');
  values.set(PROGRESS_KEY, JSON.stringify({ ...createInitialProgress(), version: 99 }));
  assert.equal(typeof loadProgress().error, 'string');
});

test('blocked localStorage and quota errors are understandable and never silently succeed', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  assert.equal(typeof loadProgress().error, 'string');
  assert.throws(() => saveProgress(createInitialProgress()), /保存|存储/);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    setItem() { throw new Error('QuotaExceededError'); },
  } });
  assert.throws(() => saveProgress(createInitialProgress()), /保存|存储/);
});

test('invalid data is rejected before writing over valid stored progress', () => {
  saveProgress(createInitialProgress());
  const original = values.get(PROGRESS_KEY);
  assert.throws(() => saveProgress({ version: 2 }));
  assert.equal(values.get(PROGRESS_KEY), original);
});

test('export has a versioned envelope and import returns progress without saving it', () => {
  const original = createInitialProgress();
  const text = exportProgress(original);
  const envelope = JSON.parse(text);
  assert.equal(envelope.app, 'word-island');
  assert.equal(envelope.version, 1);
  assert.ok(Number.isFinite(Date.parse(envelope.exportedAt)));
  assert.deepEqual(importProgress(text), original);
  assert.equal(values.has(PROGRESS_KEY), false);
  assert.deepEqual(Object.keys(envelope).sort(), ['app', 'exportedAt', 'progress', 'version']);
});

test('import rejects plain progress, wrong app/version, invalid timestamp and bad JSON', () => {
  const envelope = JSON.parse(exportProgress(createInitialProgress()));
  for (const invalid of [
    '{broken', 'null', '[]', JSON.stringify(createInitialProgress()),
    JSON.stringify({ ...envelope, app: 'another-app' }),
    JSON.stringify({ ...envelope, version: 2 }),
    JSON.stringify({ ...envelope, exportedAt: 'not-a-date' }),
    JSON.stringify({ ...envelope, audio: [] }),
    JSON.stringify({ ...envelope, progress: { ...envelope.progress, companions: ['bunny'] } }),
  ]) assert.throws(() => importProgress(invalid));
});

test('import file must be smaller than 1 MiB measured as UTF-8 bytes', () => {
  assert.throws(() => importProgress(' '.repeat(1024 * 1024)), /过大|1\s*M/i);
  assert.throws(() => importProgress('中'.repeat(400000)), /过大|1\s*M/i);
  assert.throws(() => importProgress(new Blob(['{}'])), /文本|格式/);
});

test('audio keys and blob boundaries are validated before opening a database', async () => {
  for (const invalidKey of ['', 'word:milk/evil', 'x'.repeat(101), '__proto__.x']) {
    await assert.rejects(getClip(invalidKey), /标识|名称|key/);
  }
  await assert.rejects(putClip('word:milk', 'not-a-blob'), /音频|Blob/);
  await assert.rejects(putClip('word:milk', new Blob(['<html>'], { type: 'text/html' })), /音频/);
  await assert.rejects(putClip('word:milk', new Blob([], { type: 'audio/wav' })), /音频|空/);
  await assert.rejects(putClip('word:milk', new Blob([new Uint8Array(15 * 1024 * 1024 + 1)], { type: 'audio/wav' })), /15|过大/);
});

test('unavailable audio database reports a Chinese error rather than claiming a save', async () => {
  await assert.rejects(getClip('word:milk'), /音频|浏览器/);
  await assert.rejects(putClip('recording:milk', new Blob(['audio'], { type: 'audio/webm' })), /音频|浏览器/);
});
