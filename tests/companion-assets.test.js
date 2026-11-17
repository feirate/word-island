import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,stat } from 'node:fs/promises';
import vm from 'node:vm';
import { COMPANIONS } from '../src/companions.js';

test('all eight catalog entries ship a real volumetric animated GLB, editable source and rendered portrait',async()=>{
  for(const pet of COMPANIONS){
    const bytes=await readFile(new URL(`../${pet.modelFile}`,import.meta.url));
    assert.equal(bytes.toString('ascii',0,4),'glTF',pet.id);
    assert.equal(bytes.readUInt32LE(4),2);
    assert.equal(bytes.readUInt32LE(8),bytes.length);
    const gltf=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
    assert(gltf.meshes.length>0&&gltf.materials.length>1,pet.id);
    assert(gltf.animations?.some(clip=>clip.channels.length>0),`${pet.id} needs a real idle clip`);
    assert(gltf.nodes.some(node=>node.extras?.role==='head'),`${pet.id} needs a linked head for dialogue`);
    assert(gltf.meshes.some(mesh=>mesh.primitives.some(primitive=>{const p=gltf.accessors[primitive.attributes.POSITION];return p.min&&p.max&&p.max.every((value,i)=>value>p.min[i]);})),`${pet.id} needs geometry with depth`);
    assert(gltf.buffers.every(buffer=>!buffer.uri),`${pet.id} must be self-contained`);
    assert((await stat(new URL(`../${pet.modelFile.replace('.glb','.blend')}`,import.meta.url))).size>0);
    const portrait=await readFile(new URL(`../${pet.portraitFile}`,import.meta.url));
    assert.equal(portrait.toString('hex',0,8),'89504e470d0a1a0a');
  }
});

test('the offline companion manifest includes exactly every model and its portrait',async()=>{
  const self={};
  vm.runInNewContext(await readFile(new URL('../assets/companions-precache.js',import.meta.url),'utf8'),{self});
  const paths=Array.from(self.WORD_ISLAND_COMPANION_FILES);
  assert.deepEqual(paths,COMPANIONS.flatMap(pet=>[pet.modelFile,pet.portraitFile]));
  assert.equal(new Set(paths).size,16);
});
