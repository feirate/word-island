import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {createHash,webcrypto} from 'node:crypto';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const scope = 'https://example.test/word-island/';
const audioUrl = `${scope}assets/audio/word-milk.m4a`;
const sample = Uint8Array.from({ length: 10 }, (_, index) => index);
const importedScripts = new Map([
  ['./assets/audio/precache.js', readFileSync(new URL('../assets/audio/precache.js', import.meta.url), 'utf8')],
  ['./assets/companions-precache.js', readFileSync(new URL('../assets/companions-precache.js', import.meta.url), 'utf8')],
  ['./assets/runtime-manifest.js', readFileSync(new URL('../assets/runtime-manifest.js', import.meta.url), 'utf8')],
]);
const manifestSelf = {};
vm.runInNewContext(importedScripts.get('./assets/audio/precache.js'), { self: manifestSelf });
const bundledAudioFiles = Array.from(manifestSelf.WORD_ISLAND_AUDIO_FILES);
vm.runInNewContext(importedScripts.get('./assets/runtime-manifest.js'),{self:manifestSelf});
const fixtureRuntime=manifestSelf.WORD_ISLAND_RUNTIME;
fixtureRuntime.resources=Object.fromEntries(Object.keys(fixtureRuntime.resources).map(path=>[path,createHash('sha256').update(sample).digest('hex')]));
importedScripts.set('./assets/runtime-manifest.js',`self.WORD_ISLAND_RUNTIME=${JSON.stringify(fixtureRuntime)};`);

function worker() {
  const listeners = new Map();
  const buckets = new Map();
  const requests = [];
  const writes = [];
  let offline = false;
  let networkStatus = 200;
  const urlOf = (input) => typeof input === 'string' ? input : input.url;
  const fetch = async (input) => {
    requests.push(input);
    if (offline) throw new Error('offline');
    return new Response(sample, { status: networkStatus, headers: { 'Content-Type': 'audio/mp4' } });
  };
  const caches = {
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const entries = buckets.get(name);
      return {
        async match(input) { return entries.get(urlOf(input))?.clone(); },
        async put(input, response) {
          writes.push({ url: urlOf(input), status: response.status });
          entries.set(urlOf(input), response.clone());
        },
        async addAll(inputs) {
          const results = await Promise.all(inputs.map(async (input) => {
            const response = await fetch(input);
            if (!response.ok) throw new Error('precache failed');
            return [urlOf(input), response];
          }));
          for (const [url, response] of results) entries.set(url, response);
        },
      };
    },
    async keys() { return [...buckets.keys()]; },
    async delete(name) { return buckets.delete(name); },
  };
  const self = {
    registration: { scope }, location: { origin: new URL(scope).origin },
    clients: { async claim() {} }, async skipWaiting() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  const context = vm.createContext({ self, caches, fetch, URL, Request, Response, Headers,crypto:webcrypto });
  context.importScripts = (...files) => {
    for (const file of files) {
      assert.ok(importedScripts.has(file), `Unexpected service-worker script: ${file}`);
      vm.runInContext(importedScripts.get(file), context);
    }
  };
  vm.runInContext(source, context);
  return {
    requests, writes, buckets,
    async install() {
      const promises = [];
      listeners.get('install')({ waitUntil(promise) { promises.push(promise); } });
      await Promise.all(promises);
    },
    async prepareAudio() {
      const promises=[];
      listeners.get('message')({data:{type:'CACHE_LESSON',paths:bundledAudioFiles},ports:[{postMessage(){}}],waitUntil(value){promises.push(value);}});
      await Promise.all(promises);
      writes.length=0;
    },
    async request(range, { url = audioUrl, method = 'GET' } = {}) {
      const headers = new Headers();
      if (range !== undefined) headers.set('Range', range);
      const request = new Request(url, { method, headers });
      let response;
      listeners.get('fetch')({ request, respondWith(promise) { response = Promise.resolve(promise); } });
      return response ? await response : undefined;
    },
    goOffline() { offline = true; },
    setNetworkStatus(status) { networkStatus = status; },
  };
}

async function preparedWorker() {
  const result = worker();
  await result.install();
  await result.prepareAudio();
  result.goOffline();
  return result;
}

test('a fully cached built-in audio answers an offline closed byte range with 206', async () => {
  const sw = await preparedWorker();
  const before = sw.requests.length;
  const response = await sw.request('bytes=2-5');
  assert.ok(response, 'a Safari-style media Range request must receive a Service Worker response');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.equal(response.headers.get('Content-Length'), '4');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Content-Type'), 'audio/mp4');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3, 4, 5]);
  assert.equal(sw.requests.length, before, 'cached range playback must not need a network');
  assert.equal(sw.writes.length, 0, 'a partial response must not overwrite the complete cached file');
});

test('offline media supports start-to-end and suffix ranges', async () => {
  const sw = await preparedWorker();
  for (const [range, contentRange, expected] of [
    ['bytes=7-', 'bytes 7-9/10', [7, 8, 9]],
    ['bytes=-3', 'bytes 7-9/10', [7, 8, 9]],
    ['bytes=-20', 'bytes 0-9/10', [...sample]],
    ['bytes=8-99', 'bytes 8-9/10', [8, 9]],
  ]) {
    const response = await sw.request(range);
    assert.equal(response?.status, 206, range);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(expected.length));
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expected);
  }
});

test('unsatisfiable media ranges return 416 and the complete resource size', async () => {
  const sw = await preparedWorker();
  for (const range of ['bytes=10-', 'bytes=200-300', 'bytes=5-2', 'bytes=-0']) {
    const response = await sw.request(range);
    assert.equal(response?.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test('multiple ranges and unsupported syntax can fall back to the complete cached response', async () => {
  const sw = await preparedWorker();
  for (const range of ['bytes=0-1,4-5', 'items=0-1', 'bytes=invalid', 'bytes=-']) {
    const response = await sw.request(range);
    assert.equal(response?.status, 200, range);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...sample]);
  }
});

test('uncached built-in media forwards the original Range request without caching a partial response', async () => {
  const sw = worker();
  sw.setNetworkStatus(206);
  const response = await sw.request('bytes=2-5');
  assert.equal(response?.status, 206);
  assert.equal(sw.requests.length, 1);
  assert.equal(sw.requests[0].url, audioUrl);
  assert.equal(sw.requests[0].headers.get('Range'), 'bytes=2-5');
  assert.deepEqual(sw.writes, []);
  for (const entries of sw.buckets.values()) assert.equal(entries.has(audioUrl), false);
});

test('uncached media does not pretend to be available offline', async () => {
  const sw = worker();
  sw.goOffline();
  await assert.rejects(sw.request('bytes=0-1'), /offline/);
  assert.deepEqual(sw.writes, []);
});

test('media range handling excludes foreign URLs, uploads, user audio and GLB requests', async () => {
  const sw = await preparedWorker();
  const before = sw.requests.length;
  for (const options of [
    { url: 'https://foreign.test/word-island/assets/audio/word-milk.m4a' },
    { method: 'POST' },
    { url: `${scope}assets/audio/user-import.m4a` },
    { url: `${scope}assets/models/home.glb` },
    { url: `${scope}src/app.js` },
  ]) assert.equal(await sw.request('bytes=0-1', options), undefined);
  assert.equal(sw.requests.length, before);
});

test('every pre-cached built-in audio uses the same range behavior, retaining full-file reads', async () => {
  const sw = await preparedWorker();
  const urls = sw.requests.map((request) => request.url).filter((url) => new URL(url).pathname.endsWith('.m4a'));
  assert.deepEqual(urls, bundledAudioFiles.map(path => new URL(path, scope).href));
  for (const url of urls) {
    assert.equal((await sw.request('bytes=0-0', { url })).status, 206);
    const full = await sw.request(undefined, { url });
    assert.equal(full.status, 200);
    assert.deepEqual([...new Uint8Array(await full.arrayBuffer())], [...sample]);
  }
});
