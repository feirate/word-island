import { build } from 'esbuild';
import { mkdir, readdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { optimizeModels } from './optimize_models.js';
import { writeRuntimeManifest } from './build_runtime_manifest.js';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const marker = '.word-island-build';
const runtimeAsset = /\.(glb|gltf|bin|png|jpe?g|webp|svg|ktx2|mp3|m4a|wav|ogg|js)$/;
const posix = file => file.split(path.sep).join('/');

async function prepareOutput(output) {
  if (output === root || root.startsWith(`${output}${path.sep}`) || (output.startsWith(`${root}${path.sep}`) && output !== path.join(root, '_site'))) {
    throw new Error('构建输出不能覆盖源码目录；请使用 _site 或独立临时目录。');
  }
  let existing = [];
  try { existing = await readdir(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing.length && !existing.includes(marker)) throw new Error('输出目录包含非本工具生成的文件，请使用空目录。');
  if (existing.length) await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true }); await writeFile(path.join(output, marker), 'Word Island generated static output\n');
}

async function copyTree(directory, output, filter = () => true) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const file = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) await copyTree(file, output, filter);
    else if (filter(file)) { await mkdir(path.dirname(path.join(output, file)), { recursive: true }); await copyFile(path.join(root, file), path.join(output, file)); }
  }
}

async function byteTotals(output, files) {
  let rawBytes = 0, gzipBytes = 0;
  for (const file of files) { const bytes = await readFile(path.join(output, file)); rawBytes += bytes.length; gzipBytes += gzipSync(bytes).length; }
  return { rawBytes, gzipBytes };
}

export async function buildSite({ output = process.env.BUILD_OUTPUT || path.join(root, '_site') } = {}) {
  output = path.resolve(output); await prepareOutput(output);
  await copyTree('assets', output, file => runtimeAsset.test(file) && !file.endsWith('.glb'));
  await copyTree('icons', output);
  // Source modules remain available to local regression fixtures, but aren't precached.
  await copyTree('src', output, file => /\.(js|css)$/.test(file));
  await copyTree('vendor', output, file => /\.(js|txt)$/.test(file));
  for (const file of ['manifest.webmanifest', 'sw.js']) await copyFile(path.join(root, file), path.join(output, file));
  const result = await build({ absWorkingDir: root, entryPoints: ['src/app.js', 'src/styles.css'], outdir: path.join(output, 'src'),
    bundle: true, splitting: true, format: 'esm', minify: true, target: ['safari16', 'chrome110'],
    entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]', assetNames: 'asset-[hash]',
    alias: { three: path.join(root, 'vendor/three.module.js') }, metafile: true, legalComments: 'eof', logLevel: 'silent' });
  const outputs = Object.entries(result.metafile.outputs);
  const app = outputs.find(([, metadata]) => metadata.entryPoint === 'src/app.js');
  const css = outputs.find(([, metadata]) => metadata.entryPoint === 'src/styles.css');
  if (!app || !css) throw new Error('构建缺少学习入口或样式。');
  const relative = file => posix(path.relative(output, path.resolve(root, file)));
  const entryFile = relative(app[0]), cssFile = relative(css[0]);
  const files = [], inputs = new Set();
  const outputMap = new Map(outputs.map(([file, metadata]) => [path.resolve(root, file), metadata]));
  function staticGraph(file) {
    const full = path.resolve(root, file), metadata = outputMap.get(full), relativeFile = relative(full);
    if (!metadata || files.includes(relativeFile)) return;
    files.push(relativeFile); for (const input of Object.keys(metadata.inputs)) inputs.add(posix(input));
    for (const imported of metadata.imports) if (imported.kind === 'import-statement' && !imported.external) staticGraph(imported.path);
  }
  staticGraph(app[0]);
  // Profile creation/removal lazily imports storage to avoid its source cycle.
  // That tiny export proxy is core learning code, not a deferred 3D feature.
  const coreDynamicFiles = outputs.filter(([, metadata]) => metadata.entryPoint === 'src/storage.js').map(([file]) => relative(file));
  for (const file of coreDynamicFiles) staticGraph(path.join(output, file));
  const code = outputs.filter(([file]) => file.endsWith('.js')).map(([file]) => relative(file)).sort();
  const html = (await readFile(path.join(root, 'index.html'), 'utf8'))
    .replace(/\s*<script type="importmap">[\s\S]*?<\/script>/, '')
    .replace(/href="\.\/src\/styles\.css(?:\?[^\"]*)?"/, `href="./${cssFile}"`)
    .replace(/src="\.\/src\/app\.js(?:\?[^\"]*)?"/, `src="./${entryFile}"`);
  await writeFile(path.join(output, 'index.html'), html); await writeFile(path.join(output, 'start.html'), html);
  const models = await optimizeModels(root, output);
  const shell = ['index.html', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', cssFile, ...files];
  await writeRuntimeManifest(output, { shell, code });
  const report = { entry: { file: entryFile, files, coreDynamicFiles, inputs: [...inputs].sort(), ...await byteTotals(output, files) },
    javascript: { files: code, ...await byteTotals(output, code) }, models,
    note: 'gzip sizes are local estimates, not measured network transfer or phone power use' };
  await writeFile(path.join(output, 'build-report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await buildSite(); console.log(JSON.stringify(report, null, 2));
}
