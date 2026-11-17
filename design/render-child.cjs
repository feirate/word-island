// Real GLB visual and idle inspection, isolated from the learner's stored profiles.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
const out=path.resolve('design/screenshots/child');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
 try {
  const page=await browser.newPage({viewport:{width:640,height:640},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`${base}/vendor/THREE-LICENSE.txt`);
  await page.setContent(`<style>body{margin:0}canvas{display:block}</style><script type="importmap">{"imports":{"three":"${base}/vendor/three.module.js"}}</script>`);
  const report=await page.evaluate(async base=>{
   const THREE=await import(`${base}/vendor/three.module.js`);
   const {GLTFLoader}=await import(`${base}/vendor/loaders/GLTFLoader.js`);
   const scene=new THREE.Scene();scene.background=new THREE.Color('#eaf0e3');
   const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(640,640);renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;document.body.append(renderer.domElement);
   scene.add(new THREE.HemisphereLight('#fff7e6','#8b9b83',2));
   const light=new THREE.DirectionalLight('#fff0cf',2.7);light.position.set(-3,9,7);light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.shadow.normalBias=.025;scene.add(light);
   const gltf=await new GLTFLoader().loadAsync(`${base}/assets/models/child.glb`);scene.add(gltf.scene);
   let head,body;const feet=[];
   gltf.scene.traverse(node=>{if(node.isMesh){node.castShadow=true;node.receiveShadow=true;}if(node.userData.role==='head')head=node;if(node.userData.role==='body')body=node;if(node.isMesh&&node.name.includes('ChildExplorer'))feet.push(node);});
   gltf.scene.updateMatrixWorld(true);
   const box=new THREE.Box3().setFromObject(gltf.scene),size=box.getSize(new THREE.Vector3()),target=box.getCenter(new THREE.Vector3());
   const floor=new THREE.Mesh(new THREE.CylinderGeometry(.85,.88,.07,64),new THREE.MeshStandardMaterial({color:'#dce5d0',roughness:.8}));floor.position.y=-.04;floor.receiveShadow=true;scene.add(floor);
   const half=Math.max(size.x,size.y,size.z)*.67;
   const camera=new THREE.OrthographicCamera(-half,half,half,-half,.1,40);
   const mixer=new THREE.AnimationMixer(gltf.scene);mixer.clipAction(gltf.animations[0]).play();
   window.childInspection={THREE,renderer,scene,camera,mixer,head,body,root:gltf.scene,target};
   window.childPose=(view,time=0)=>{
    const directions={front:[0,.1,5],side:[5,.1,0],back:[0,.1,-5],'three-quarter':[3.2,1.4,5],'idle-extreme':[3.2,1.4,5]};
    mixer.setTime(time);camera.position.copy(target).add(new THREE.Vector3(...directions[view]));camera.lookAt(target);renderer.render(scene,camera);
    gltf.scene.updateMatrixWorld(true);
    return {head:head.quaternion.toArray(),body:body.scale.toArray(),bounds:new THREE.Box3().setFromObject(gltf.scene).min.toArray(),triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls};
   };
   return {size:size.toArray(),min:box.min.toArray(),max:box.max.toArray(),animations:gltf.animations.map(clip=>clip.name),headChildren:head.children.length,bodyChildren:body.children.length};
  },base);
  assert(Math.abs(report.min[1])<.005,'child shoe soles touch the ground');
  assert(report.size[1]>1.85&&report.size[1]<2.15,'child scale fits the miniature world');
  assert(report.headChildren>=3&&report.animations.length===1);
  for(const view of ['front','side','back','three-quarter','idle-extreme']){
   await page.evaluate(({view,time})=>window.childPose(view,time),{view,time:view==='idle-extreme'?1.05:0});
   await page.waitForTimeout(100);
   await page.screenshot({path:path.join(out,`${view}.png`)});
  }
  const first=await page.evaluate(()=>window.childPose('front',0));
  const middle=await page.evaluate(()=>window.childPose('front',1.05));
  const end=await page.evaluate(()=>window.childPose('front',95/24));
  assert(first.head.some((n,i)=>Math.abs(n-middle.head[i])>.001),'head really moves with the idle clip');
  assert(first.head.every((n,i)=>Math.abs(n-end.head[i])<.0001),'idle returns to its initial pose');
  assert(Math.abs(first.bounds[1]-middle.bounds[1])<.001,'shoe soles stay grounded during breathing');
  await page.setViewportSize({width:256,height:256});
  await page.evaluate(()=>{const s=window.childInspection;s.renderer.setSize(256,256);window.childPose('three-quarter',0);});
  await page.waitForTimeout(200);
  await page.screenshot({path:path.resolve('assets/models/child-portrait.png')});
  assert.deepEqual(errors,[]);
  const result={...report,triangles:first.triangles,drawCalls:first.drawCalls,errors,headInitial:first.head,headAt1s:middle.head};
  fs.writeFileSync(path.join(out,'runtime-check.json'),JSON.stringify(result,null,2)+'\n');
  await page.evaluate(()=>window.childInspection.renderer.dispose());
  console.log(JSON.stringify({passed:['real child GLB','head and clothing hierarchy','grounded shoes','front/side/back/three-quarter','real idle and exact loop return','idle ground contact','256px actual-model portrait'],...result}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
