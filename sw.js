/* Runtime files must be versioned together when the app or models change. */
const VERSION = 'v0.6.3';
importScripts('./assets/audio/precache.js');
importScripts('./assets/companions-precache.js');
const SCOPE = self.registration.scope;
const PREFIX = `word-island:${SCOPE}`;
const SHELL_CACHE = `${PREFIX}shell:${VERSION}`;
const MODEL_CACHE = `${PREFIX}models:${VERSION}`;
const absolute = (path) => new URL(path, SCOPE).href;

const CORE_URLS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'src/styles.css',
  'src/app.js',
  'src/world.js',
  'src/model-loader.js',
  'src/storage.js',
  'src/learning.js',
  'src/content.js',
  'src/kb3.js',
  'src/practice.js',
  'src/story.js',
  'src/companions.js',
  'src/companion-view.js',
  'src/speech-audio.js',
  'src/profiles.js',
  'assets/companions-precache.js',
  'assets/audio/precache.js',
  'vendor/three.module.js',
  'vendor/three.core.js',
  'vendor/OrbitControls.js',
  'vendor/loaders/GLTFLoader.js',
  'vendor/utils/BufferGeometryUtils.js',
  ...self.WORD_ISLAND_AUDIO_FILES,
].map(absolute);
const MODELS = [
  'assets/models/home.glb',
  'assets/models/camp.glb',
  'assets/models/hero.glb',
  'assets/models/child.glb',
  'assets/models/child-portrait.png',
  ...self.WORD_ISLAND_COMPANION_FILES,
];
const MODEL_URLS = new Set(MODELS.map(absolute));
const CORE_SET = new Set(CORE_URLS);
const AUDIO_URLS = new Set(CORE_URLS.filter((url) => url.startsWith(absolute('assets/audio/')) && url.endsWith('.m4a')));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Cache.addAll rejects the installation if any required response fails.
    await cache.addAll(CORE_URLS.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const current = new Set([SHELL_CACHE, MODEL_CACHE]);
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && !current.has(key)).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function cachedOrFetch(request, cacheName, key = request.url) {
  let cache;
  try {
    cache = await caches.open(cacheName);
    const cached = await cache.match(key);
    if (cached) return cached;
  } catch { /* Restricted browser storage must not block the available network. */ }
  const response = await fetch(request);
  if (cache && response.ok && response.status === 200) {
    // Cache capacity problems must not prevent online use of a valid response.
    try { await cache.put(key, response.clone()); } catch { /* Explicit preparation reports cache failures below. */ }
  }
  return response;
}

async function cachedAudioRange(request) {
  let cached;
  try {
    const cache = await caches.open(SHELL_CACHE);
    cached = await cache.match(request.url);
  } catch { return fetch(request); }
  if (!cached || cached.status !== 200) return fetch(request);
  const match = /^bytes=(\d*)-(\d*)$/i.exec(request.headers.get('range').trim());
  // A complete 200 response is a valid fallback for unsupported or multiple ranges.
  if (!match || (!match[1] && !match[2])) return cached;
  let body;
  try { body = await cached.arrayBuffer(); } catch { return fetch(request); }
  const size = body.byteLength;
  let start, end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  const headers = new Headers(cached.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.delete('Content-Encoding');
  if (size === 0 || start >= size || start > end) {
    headers.set('Content-Range', `bytes */${size}`);
    headers.set('Content-Length', '0');
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  // Partial bodies are produced from, and never written over, the complete cached file.
  return new Response(body.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.headers.has('range')) {
    if (AUDIO_URLS.has(url.href)) event.respondWith(cachedAudioRange(request));
    return;
  }
  const navigation = request.mode === 'navigate' && [absolute('./'), absolute('index.html')].includes(`${url.origin}${url.pathname}`);
  if (navigation) {
    event.respondWith(cachedOrFetch(request, SHELL_CACHE, absolute('index.html')));
  } else if (CORE_SET.has(url.href)) {
    event.respondWith(cachedOrFetch(request, SHELL_CACHE));
  } else if (MODEL_URLS.has(url.href)) {
    event.respondWith(cachedOrFetch(request, MODEL_CACHE));
  }
});

async function prepareModels(paths) {
  const selected = paths === undefined ? MODELS : paths;
  if (!Array.isArray(selected) || selected.length === 0 || selected.some((path) => typeof path !== 'string')) {
    return { type: 'MODELS_CACHED', ok: false, paths: [], error: '模型列表无效。' };
  }
  let urls;
  try { urls = [...new Set(selected.map(absolute))]; } catch {
    return { type: 'MODELS_CACHED', ok: false, paths: [], error: '模型地址无效。' };
  }
  if (urls.some((url) => !MODEL_URLS.has(url))) {
    return { type: 'MODELS_CACHED', ok: false, paths: [], error: '只能准备应用内置的模型。' };
  }
  const cache = await caches.open(MODEL_CACHE);
  const results = await Promise.all(urls.map(async (url) => {
    try {
      if (await cache.match(url)) return { url, ok: true };
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok || response.status !== 200) return { url, ok: false };
      await cache.put(url, response.clone());
      return { url, ok: true };
    } catch { return { url, ok: false }; }
  }));
  const pathsReady = results.filter((item) => item.ok).map((item) => item.url.slice(SCOPE.length));
  const failed = results.filter((item) => !item.ok).map((item) => item.url.slice(SCOPE.length));
  return { type: 'MODELS_CACHED', ok: failed.length === 0, paths: pathsReady, failed };
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_MODELS') return;
  const reply = (message) => event.ports?.[0]?.postMessage(message);
  event.waitUntil(prepareModels(event.data.paths)
    .then(reply)
    .catch(() => reply({ type: 'MODELS_CACHED', ok: false, paths: [], error: '无法准备本机缓存。' })));
});
