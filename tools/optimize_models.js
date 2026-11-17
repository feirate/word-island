import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { NodeIO, Logger, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, simplify, quantize, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).setLogger(new Logger(Logger.Verbosity.ERROR));

function semanticSnapshot(document) {
  const root = document.getRoot();
  return {
    nodes: root.listNodes().filter(node => node.getName() || Object.keys(node.getExtras()).length).map(node => ({
      name: node.getName(), extras: node.getExtras(),
      parent: node.getParentNode()?.getName() || '',
    })).sort((a, b) => a.name.localeCompare(b.name)),
    animations: root.listAnimations().map(animation => ({
      name: animation.getName(), extras: animation.getExtras(),
      channels: animation.listChannels().map(channel => ({ target: channel.getTargetNode()?.getName(), path: channel.getTargetPath(),
        interpolation: channel.getSampler().getInterpolation(),
        input: Array.from(channel.getSampler().getInput().getArray()), output: Array.from(channel.getSampler().getOutput().getArray()),
      })),
    })),
  };
}

function modelStats(document, bytes) {
  const root = document.getRoot();
  let triangles = 0, vertices = 0;
  for (const node of root.listNodes()) for (const primitive of node.getMesh()?.listPrimitives() || []) {
    if (primitive.getMode() !== 4) continue;
    triangles += (primitive.getIndices()?.getCount() || primitive.getAttribute('POSITION').getCount()) / 3;
    vertices += primitive.getAttribute('POSITION').getCount();
  }
  return { rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length, triangles, vertices, nodes: root.listNodes().length,
    animations: root.listAnimations().length };
}

export async function optimizeModel(input, output) {
  const original = await readFile(input), document = await io.readBinary(original);
  const expected = semanticSnapshot(document), before = modelStats(document, original);
  const isArchitecture = ['home.glb', 'camp.glb'].includes(path.basename(input));
  await MeshoptSimplifier.ready;
  await document.transform(
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MATERIAL, PropertyType.MESH], keepUniqueNames: true }),
    weld(),
    // Broad beveled walls can change their normal interpolation even at a tiny
    // geometric error. Preserve scene triangles; actors use a strict error cap.
    ...(isArchitecture ? [] : [simplify({ simplifier: MeshoptSimplifier, ratio: 0.85, error: 0.0005, lockBorder: true })]),
    quantize({ quantizePosition: 14, quantizeNormal: 12, quantizeTexcoord: 14, cleanup: false }),
    prune({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.BUFFER], keepLeaves: true, keepExtras: true, keepAttributes: true }),
  );
  if (!isDeepStrictEqual(semanticSnapshot(document), expected)) throw new Error(`模型语义或动画在精简后发生变化：${path.basename(input)}`);
  const candidate = await io.writeBinary(document);
  // HTTP already compresses GLBs. Choose the result on its compressed transfer size.
  const optimized = gzipSync(candidate).length < before.gzipBytes;
  const published = optimized ? candidate : original;
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, published);
  const decoded = await io.readBinary(published);
  if (!isDeepStrictEqual(semanticSnapshot(decoded), expected)) throw new Error(`发布模型语义校验失败：${path.basename(input)}`);
  return { file: path.basename(input), optimized, semanticPreserved: true, before, after: modelStats(decoded, published),
    extensions: decoded.getRoot().listExtensionsRequired().map(extension => extension.extensionName) };
}

export async function optimizeModels(source, output) {
  const report = [];
  async function visit(relative) {
    for (const entry of (await readdir(path.join(source, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith('.glb')) report.push({ ...await optimizeModel(path.join(source, file), path.join(output, file)), file });
    }
  }
  await visit('assets/models'); return report;
}
