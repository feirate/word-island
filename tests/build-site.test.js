import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { buildSite } from '../tools/build_site.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let output, report, originalHash;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
before(async () => {
  output = await mkdtemp(path.join(tmpdir(), 'word-island-build-test-'));
  originalHash = hash(await readFile(path.join(root, 'assets/models/hero.glb')));
  report = await buildSite({ output });
});
after(async () => { if (output) await rm(output, { recursive: true, force: true }); });

test('the publishable entry uses hashed assets and a matching repair entry without an import map', async () => {
  const index = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.equal(await readFile(path.join(output, 'start.html'), 'utf8'), index);
  assert(!index.includes('type="importmap"'));
  assert.match(index, /src="\.\/src\/app-[A-Z0-9]+\.js"/);
  assert.match(index, /href="\.\/src\/styles-[A-Z0-9]+\.css"/);
  assert.equal(report.entry.files[0], report.entry.file);
  assert(report.javascript.gzipBytes < report.javascript.rawBytes);
});

test('the install shell has the static learning entry graph and leaves 3D and media on demand', async () => {
  const context = { self: {} };
  vm.runInNewContext(await readFile(path.join(output, 'assets/runtime-manifest.js'), 'utf8'), context);
  const manifest = context.self.WORD_ISLAND_RUNTIME;
  assert(manifest.shell.includes(report.entry.file));
  assert(report.entry.files.every(file => manifest.shell.includes(file)));
  assert(manifest.code.every(file => file.startsWith('src/') && file.endsWith('.js')));
  assert(!manifest.shell.some(file => /\.(glb|m4a)$/.test(file)));
  assert(!manifest.shell.some(file => file.startsWith('vendor/')));
  assert(!report.entry.inputs.some(file => /vendor\/three|src\/world\.js|src\/companion-view\.js/.test(file)), '3D must remain outside the static learning graph');
  for (const file of manifest.code) assert((await readFile(path.join(output, file))).length > 0);
});

test('core dynamic storage exports are cached before the first offline profile is created', async () => {
  assert(Array.isArray(report.entry.coreDynamicFiles) && report.entry.coreDynamicFiles.length > 0, 'profile storage migration proxy belongs to the core shell');
  const context = { self: {} };
  vm.runInNewContext(await readFile(path.join(output, 'assets/runtime-manifest.js'), 'utf8'), context);
  for (const file of report.entry.coreDynamicFiles) {
    assert(report.entry.files.includes(file));
    assert(context.self.WORD_ISLAND_RUNTIME.shell.includes(file));
    assert.match(await readFile(path.join(output, file), 'utf8'), /copyLegacyRecordings/);
  }
});

test('publication reduces real GLBs while keeping semantic nodes, animations and original authoring assets', async () => {
  assert.equal(report.models.length, 12);
  assert(report.models.every(model => model.semanticPreserved && model.after.gzipBytes <= model.before.gzipBytes));
  const before = report.models.reduce((total, model) => total + model.before.gzipBytes, 0);
  const afterBytes = report.models.reduce((total, model) => total + model.after.gzipBytes, 0);
  assert(afterBytes < before * 0.85, 'the complete model set should measurably reduce transfer size');
  assert.equal(hash(await readFile(path.join(root, 'assets/models/hero.glb'))), originalHash);
  const files = [];
  async function visit(directory) { for (const entry of await readdir(path.join(output, directory), { withFileTypes: true })) {
    const file = path.posix.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else files.push(file);
  } }
  await visit('assets');
  assert(!files.some(file => /\.blend$/.test(file)));
  assert(report.models.every(model => !model.extensions.some(extension => /draco|meshopt/.test(extension))), 'runtime model decoding must not require an extra codec');
});

test('the build rejects source directories as output', async () => {
  await assert.rejects(buildSite({ output: root }), /输出|output/i);
  await assert.rejects(buildSite({ output: path.join(root, 'src') }), /输出|output/i);
  await assert.rejects(buildSite({ output: path.join(root, 'assets') }), /输出|output/i);
});
