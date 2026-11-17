import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('assets/audio/metadata.json', root), 'utf8'));

function precache() {
  const self = {};
  vm.runInNewContext(readFileSync(new URL('assets/audio/precache.js', root), 'utf8'), { self });
  return Array.from(self.WORD_ISLAND_AUDIO_FILES);
}

test('bundled audio clearly records local Daniel synthesis instead of textbook originals', () => {
  assert.equal(metadata.app, 'word-island');
  assert.equal(metadata.voice, 'Daniel');
  assert.equal(metadata.language, 'en-GB');
  assert.equal(metadata.engine, 'macOS /usr/bin/say');
  assert.equal(metadata.networkServicesUsed, false);
  assert.equal(metadata.voiceDownloadsPerformed, false);
  assert.match(metadata.source, /合成/);
  assert.match(metadata.source, /非教材原音/);
  assert.equal(metadata.format, 'AAC / M4A');
  assert.equal(metadata.sampleRateHz, 22050);
  assert.equal(metadata.wordsPerMinute,145);
  assert.equal(metadata.slowProfile.tempo,.82);
  assert.equal(metadata.slowProfile.pitchScale,1);
  assert.equal(metadata.slowProfile.method,'offline pitch-preserving time stretch');
  assert.equal(metadata.processing.paddingBeforeMs,100);
  assert.equal(metadata.processing.paddingAfterMs,200);
  assert.equal(metadata.processing.trimSilence,false);
  assert.equal(metadata.processing.fadeSpeech,false);
  assert.equal(metadata.processing.dynamicCompression,false);
});

test('every normal prompt has an independent pitch-preserving slower file with the same spoken text',async()=>{
  assert.equal(metadata.slowClips.length,metadata.clips.length);
  const slow=new Map(metadata.slowClips.map(clip=>[clip.baseId,clip]));
  for(const normal of metadata.clips){
    const clip=slow.get(normal.id);assert.ok(clip,normal.id);
    assert.equal(clip.id,`${normal.id}-slow`);
    assert.equal(clip.file,`${normal.id}-slow.m4a`);
    for(const key of ['key','text','kind'])assert.equal(clip[key],normal[key]);
    assert.equal(clip.tempo,.82);
    assert.equal(clip.pitchScale,1);
    assert.equal(normal.wordsPerMinute,145);
    assert.equal(clip.processing.nativePcmSha256,normal.processing.nativePcmSha256);
    const ratio=clip.processing.source.durationSeconds/normal.processing.source.durationSeconds;
    assert.ok(ratio>=1.17&&ratio<=1.27,`${normal.id}: real articulation duration must increase`);
    assert.ok(clip.durationSeconds>normal.durationSeconds,normal.id);
    const bytes=await readFile(new URL(`assets/audio/${clip.file}`,root));
    assert.equal(bytes.toString('ascii',4,8),'ftyp');
    assert.equal(bytes.length,clip.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),clip.sha256);
  }
});

test('processed speech records measured source and output levels without exceeding gain or peak bounds',()=>{
  for(const clip of [...metadata.clips,...metadata.slowClips]){
    const p=clip.processing;
    assert.ok(Number.isFinite(p.gainDb)&&p.gainDb<=4,clip.id);
    assert.ok(Number.isFinite(p.source.meanDbFS)&&Number.isFinite(p.source.peakDbFS),clip.id);
    assert.ok(p.pcm.peakDbFS<=-1.999,clip.id);
    assert.ok(p.encoded.peakDbFS<=-1.95,clip.id);
    assert.ok(p.encoded.leadingSilenceMs>=70,clip.id);
    assert.ok(p.encoded.trailingSilenceMs>=150,clip.id);
  }
});

test('every current word and phrase has matching spoken text, a real M4A and a verified content hash', async () => {
  const { WORDS, PHRASES } = await import('../src/content.js');
  const expected = [
    ...WORDS.map(word => ({ id: `word-${word.id}`, key: `word:${word.id}`, text: word.en, kind: 'word' })),
    ...PHRASES.map(phrase => ({ id: `phrase-${phrase.id}`, key: `phrase:${phrase.id}`, text: phrase.en, kind: 'phrase' })),
  ];
  assert.equal(new Set(expected.map(item => item.id)).size, expected.length);
  assert.equal(metadata.clips.length, expected.length);
  const clips = new Map(metadata.clips.map(clip => [clip.id, clip]));
  assert.equal(clips.size, metadata.clips.length);
  for (const item of expected) {
    const clip = clips.get(item.id);
    assert.ok(clip, item.id);
    for (const key of ['id', 'key', 'text', 'kind']) assert.equal(clip[key], item[key], `${item.id} ${key}`);
    assert.equal(clip.file, `${item.id}.m4a`);
    assert.ok(Number.isFinite(clip.durationSeconds) && clip.durationSeconds > 0, item.id);
    const path = new URL(`assets/audio/${clip.file}`, root);
    const bytes = await readFile(path);
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp', `${item.id} must be an actual MP4-family file`);
    assert.equal((await stat(path)).size, clip.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), clip.sha256, item.id);
  }
});

test('the classic precache manifest contains exactly the generated local audio clips', async () => {
  const files = precache();
  const expected = [...metadata.clips,...metadata.slowClips].map(clip => `assets/audio/${clip.file}`);
  assert.deepEqual(files, expected);
  assert.equal(new Set(files).size, files.length);
  for (const file of files) {
    assert.match(file, /^assets\/audio\/(?:word|phrase)-[A-Za-z0-9_-]+\.m4a$/);
    assert.ok((await stat(new URL(file, root))).size > 0);
  }
});

test('the classic service worker loads manifests but installs only the learning shell', async () => {
  const scope = 'https://example.test/word-island/';
  const allowedScripts = ['./assets/audio/precache.js', './assets/companions-precache.js', './assets/runtime-manifest.js'];
  const listeners = new Map();
  const imported = [];
  let cached = [];
  const self = {
    registration: { scope }, location: { origin: 'https://example.test' },
    addEventListener(type, listener) { listeners.set(type, listener); }, async skipWaiting() {},
  };
  const context = vm.createContext({ self, URL, Request, Response, Headers,
    caches: { async open() { return { async addAll(requests) { cached = Array.from(requests, request => request.url); } }; } },
  });
  context.importScripts = (...files) => {
    for (const file of files) {
      assert.ok(allowedScripts.includes(file), `Unexpected service-worker script: ${file}`);
      imported.push(new URL(file, scope).href);
      vm.runInContext(readFileSync(new URL(file, root), 'utf8'), context);
    }
  };
  vm.runInContext(await readFile(new URL('sw.js', root), 'utf8'), context);
  let installation;
  listeners.get('install')({ waitUntil(promise) { installation = promise; } });
  await installation;
  assert.deepEqual(imported, allowedScripts.map(file => new URL(file, scope).href));
  assert.deepEqual(cached.filter(url => url.endsWith('.m4a')), []);
  assert.equal(cached.some(url => /\/vendor\/|\/world\.js$|\/companion-view\.js$|\.glb$/.test(url)),false);
  for (const file of ['index.html','src/app.js','src/deferred-world.js','src/kb3.js','src/practice.js','src/story.js','src/companions.js','src/speech-audio.js']) assert.ok(cached.includes(`${scope}${file}`),file);
});
