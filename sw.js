/* Code follows app versions; large immutable assets follow content revisions. */
const VERSION = 'v0.7.1';
importScripts('./assets/audio/precache.js');
importScripts('./assets/companions-precache.js');
importScripts('./assets/runtime-manifest.js');
const SCOPE = self.registration.scope;
const PREFIX = `word-island:${SCOPE}`;
const SHELL_CACHE = `${PREFIX}shell:${VERSION}`;
const ASSET_CACHE = `${PREFIX}assets:v1`;
const absolute = (path) => new URL(path, SCOPE).href;
const RUNTIME = self.WORD_ISLAND_RUNTIME;
const RESOURCE_REVISIONS = new Map(Object.entries(RUNTIME.resources).map(([path, revision]) => [absolute(path), revision]));
const assetKey = (url) => `${url}?asset=${RESOURCE_REVISIONS.get(url)}`;

const DEFAULT_CORE_PATHS = [
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
  'src/deferred-world.js',
  'src/offline-client.js',
  'src/render-policy.js',
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
  'assets/runtime-manifest.js',
  'vendor/three.module.js',
  'vendor/three.core.js',
  'vendor/OrbitControls.js',
  'vendor/loaders/GLTFLoader.js',
  'vendor/utils/BufferGeometryUtils.js',
];
const INSTALL_PATHS = RUNTIME.shell || DEFAULT_CORE_PATHS.filter(path => !path.startsWith('vendor/') && !['src/world.js', 'src/companion-view.js', 'src/model-loader.js', 'src/render-policy.js'].includes(path));
const CORE_URLS = [...new Set([...INSTALL_PATHS, ...(RUNTIME.code || DEFAULT_CORE_PATHS), 'assets/runtime-manifest.js'])].map(absolute);
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
const AUDIO_URLS = new Set(self.WORD_ISLAND_AUDIO_FILES.map(absolute));

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Cache.addAll rejects the installation if any required response fails.
    const urls = INSTALL_PATHS.map(absolute);
    await cache.addAll(urls.filter(url => !RESOURCE_REVISIONS.has(url)).map(url => new Request(url, { cache: 'reload' })));
    const assets = await Promise.all(urls.filter(url => RESOURCE_REVISIONS.has(url)).map(prepareFile));
    if (assets.some(result => !result.ok)) throw new Error('学习界面资源尚未完整准备。');
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const current = new Set([SHELL_CACHE, ASSET_CACHE]);
    const keys = await caches.keys();
    const oldKeys = keys.filter(key => key.startsWith(PREFIX) && !current.has(key));
    // Preserve verified 0.6.x downloads, rather than forcing a new model/audio transfer.
    // Unversioned old entries are never trusted without checking their actual bytes.
    const migrated = await migrateAssets(oldKeys);
    if (migrated) await Promise.all(oldKeys.map(key => caches.delete(key)));
    try {
      const cache = await caches.open(ASSET_CACHE);
      const valid = new Set([...RESOURCE_REVISIONS.keys()].map(assetKey));
      for (const request of await cache.keys()) if (!valid.has(request.url)) await cache.delete(request);
    } catch { /* Storage denial must not prevent the app taking control online. */ }
    await self.clients.claim();
  })());
});

async function migrateAssets(oldKeys) {
  if (!oldKeys.length) return true;
  try {
    const target = await caches.open(ASSET_CACHE);
    for (const name of oldKeys) {
      const old = await caches.open(name);
      for (const url of RESOURCE_REVISIONS.keys()) {
        if (await target.match(assetKey(url))) continue;
        const response = await old.match(url);
        if (!response || response.status !== 200) continue;
        if (await matchesRevision(url, response)) await target.put(assetKey(url), response);
      }
    }
    return true;
  } catch { return false; }
}

async function matchesRevision(url, response) {
  const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
  const actual = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  return actual === RESOURCE_REVISIONS.get(url);
}

async function cachedOrFetch(request, cacheName, event, key = request.url, revisionUrl = request.url) {
  let cache;
  try {
    cache = await caches.open(cacheName);
    const cached = await cache.match(key);
    if (cached) return cached;
  } catch { /* Restricted browser storage must not block the available network. */ }
  const response = await fetch(request, cacheName === ASSET_CACHE ? { cache: 'no-cache' } : undefined);
  if (cache && response.ok && response.status === 200) {
    // Return the live response immediately. Cache.put consumes the entire body;
    // waiting for it would hide download progress and delay the child's scene.
    try {
      const copy = response.clone();
      const writing = (async () => {
        if (cacheName === ASSET_CACHE && !await matchesRevision(revisionUrl, copy)) return;
        await cache.put(key, copy);
      })().catch(() => {});
      event?.waitUntil?.(writing);
    } catch { /* Explicit preparation reports cache failures below. */ }
  }
  return response;
}

async function navigationResponse(request, event) {
  let response;
  try {
    // Revalidate even a fresh HTTP-cache entry so an installed old worker can
    // receive the new versioned entry point after a deployment.
    response = await fetch(request, { cache: 'no-cache' });
  } catch (error) {
    try {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(absolute('index.html'));
      if (cached) return cached;
    } catch { /* With neither network nor cache, retain the real network error. */ }
    throw error;
  }
  if (response.ok && response.status === 200) {
    try {
      const copy = response.clone();
      const writing = caches.open(SHELL_CACHE).then(cache => cache.put(absolute('index.html'), copy)).catch(() => {});
      event?.waitUntil?.(writing);
    } catch { /* The live entry point remains usable if persistence is unavailable. */ }
  }
  return response;
}

async function cachedAudioRange(request) {
  let cached;
  try {
    const cache = await caches.open(ASSET_CACHE);
    cached = await cache.match(assetKey(request.url));
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
  const canonical = `${url.origin}${url.pathname}`;
  const navigation = request.mode === 'navigate' && [absolute('./'), absolute('index.html'), absolute('start.html')].includes(canonical);
  const params = [...url.searchParams];
  const currentCodeVersion = /\.(?:js|css)$/.test(url.pathname) && params.length === 1
    && params[0][0] === 'v' && params[0][1] === VERSION.slice(1);
  const coreKey = CORE_SET.has(url.href) ? url.href : currentCodeVersion && CORE_SET.has(canonical) ? canonical : null;
  if (navigation) {
    event.respondWith(navigationResponse(request, event));
  } else if (RESOURCE_REVISIONS.has(url.href) || (coreKey && RESOURCE_REVISIONS.has(coreKey))) {
    const revisionUrl = RESOURCE_REVISIONS.has(url.href) ? url.href : coreKey;
    event.respondWith(cachedOrFetch(request, ASSET_CACHE, event, assetKey(revisionUrl), revisionUrl));
  } else if (coreKey) {
    event.respondWith(cachedOrFetch(request, SHELL_CACHE, event, coreKey));
  }
});

// All background preparations share two slots and one task per complete file.
// Revisiting a unit or retrying a partly prepared pack reuses successful files.
const preparationQueue = [], preparingFiles = new Map();
let activePreparations = 0;
function pumpPreparations() {
  while (activePreparations < 2 && preparationQueue.length) {
    const { work, resolve } = preparationQueue.shift();
    activePreparations++;
    work().then(resolve).finally(() => { activePreparations--; pumpPreparations(); });
  }
}
function prepareFile(url) {
  if (preparingFiles.has(url)) return preparingFiles.get(url);
  const task = new Promise(resolve => {
    preparationQueue.push({ resolve, work: async () => {
      try {
        const resource = RESOURCE_REVISIONS.has(url);
        const cache = await caches.open(resource ? ASSET_CACHE : SHELL_CACHE);
        const key = resource ? assetKey(url) : url;
        if (await cache.match(key)) return { url, ok: true };
        const response = await fetch(new Request(url, { cache: 'no-cache' }));
        if (response.status !== 200) return { url, ok: false };
        if (resource && !await matchesRevision(url, response)) return { url, ok: false };
        await cache.put(key, response);
        return { url, ok: true };
      } catch { return { url, ok: false }; }
    }});
    pumpPreparations();
  });
  preparingFiles.set(url, task);
  task.finally(() => preparingFiles.delete(url));
  return task;
}

async function prepareResources(type, paths, reply) {
  const lesson = type === 'CACHE_LESSON';
  const finalType = lesson ? 'LESSON_CACHED' : 'MODELS_CACHED';
  const fail = error => ({ type: finalType, version: VERSION.slice(1), ok: false, paths: [], failed: [], error });
  const selected = paths === undefined && !lesson ? [...CORE_URLS, ...RESOURCE_REVISIONS.keys()] : paths;
  if (!Array.isArray(selected) || selected.length === 0 || selected.some(path => typeof path !== 'string')) return fail('资源列表无效。');
  let urls;
  try { urls = [...new Set(selected.map(absolute))]; } catch { return fail('资源地址无效。'); }
  const allowed = lesson ? AUDIO_URLS : paths === undefined ? new Set([...CORE_URLS, ...RESOURCE_REVISIONS.keys()]) : MODEL_URLS;
  if (urls.some(url => !allowed.has(url) || (!CORE_SET.has(url) && !RESOURCE_REVISIONS.has(url)))) return fail('只能准备应用内置的资源。');
  let completed = 0;
  const results = await Promise.all(urls.map(async url => {
    const result = await prepareFile(url);
    reply({ type: 'CACHE_PROGRESS', version: VERSION.slice(1), completed: ++completed, total: urls.length, path: url.slice(SCOPE.length), ok: result.ok });
    return result;
  }));
  return { type: finalType, version: VERSION.slice(1), ok: results.every(item => item.ok),
    paths: results.filter(item => item.ok).map(item => item.url.slice(SCOPE.length)),
    failed: results.filter(item => !item.ok).map(item => item.url.slice(SCOPE.length)) };
}

self.addEventListener('message', event => {
  if (!['CACHE_MODELS', 'CACHE_LESSON'].includes(event.data?.type)) return;
  const reply = message => { try { event.ports?.[0]?.postMessage(message); } catch { /* A closed UI does not invalidate a completed file. */ } };
  event.waitUntil(prepareResources(event.data.type, event.data.paths, reply).then(reply)
    .catch(() => reply({ type: event.data.type === 'CACHE_LESSON' ? 'LESSON_CACHED' : 'MODELS_CACHED', version: VERSION.slice(1), ok: false, paths: [], failed: [], error: '无法准备本机缓存。' })));
});
