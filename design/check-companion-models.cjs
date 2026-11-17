// Structural asset contract; visual quality is checked separately in Three.js.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const ids=['squirrel','cat','dog','hedgehog','turtle','raccoon','fox'];
const results=[];
for(const id of ids){
  const file=path.resolve('assets/models/companions',id+'.glb');
  const bytes=fs.readFileSync(file);
  assert.equal(bytes.toString('ascii',0,4),'glTF');
  const json=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
  assert(json.nodes.some(n=>n.extras?.assetId===id&&n.extras?.role==='companion'),id+' identity');
  const head=json.nodes.find(n=>n.extras?.role==='head');
  assert(head?.children?.length>=3,id+' complete head hierarchy');
  assert(!json.nodes.some(n=>n.extras?.interactionId),id+' interactions belong to runtime');
  assert(json.animations?.length===1&&json.animations[0].channels.length>=2,id+' coordinated idle');
  const headIndex=json.nodes.indexOf(head);
  assert(json.animations[0].channels.some(c=>c.target.node===headIndex&&c.target.path==='rotation'),id+' real head animation');
  assert(bytes.length<700000,id+' mobile file budget');
  const triangles=json.meshes.reduce((sum,m)=>sum+m.primitives.reduce((n,p)=>n+json.accessors[p.indices].count/3,0),0);
  assert(triangles>1000&&triangles<25000,id+' meaningful and bounded mesh');
  assert(fs.statSync(file.replace('.glb','.blend')).size>1000,id+' editable source');
  results.push({id,bytes:bytes.length,meshes:json.meshes.length,triangles,materials:json.materials.length});
}
console.log(JSON.stringify({passed:ids,assets:results},null,2));
