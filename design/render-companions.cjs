// Internal asset inspection: actual GLBs rendered by the app's vendored Three.js.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
const ids=process.env.COMPANION_ASSETS?.split(',')||['squirrel','cat','dog','hedgehog','turtle','raccoon','fox'];
const out=path.resolve('design/screenshots/companions');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
 try {
  const page=await browser.newPage({viewport:{width:512,height:512},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base+'/vendor/THREE-LICENSE.txt');
  await page.setContent(`<style>body{margin:0}canvas{display:block}</style><script type="importmap">{"imports":{"three":"${base}/vendor/three.module.js"}}</script>`);
  await page.evaluate(async base=>{
   const THREE=await import(base+'/vendor/three.module.js');
   const {GLTFLoader}=await import(base+'/vendor/loaders/GLTFLoader.js');
   const scene=new THREE.Scene();scene.background=new THREE.Color('#eaf0e3');
   const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(512,512);renderer.setPixelRatio(1);
   renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
   renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;document.body.append(renderer.domElement);
   scene.add(new THREE.HemisphereLight('#fff7e6','#8b9b83',2));
   const key=new THREE.DirectionalLight('#fff0cf',2.7);key.position.set(-3,9,7);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.normalBias=.035;key.shadow.bias=-.00015;scene.add(key);
   const floor=new THREE.Mesh(new THREE.CylinderGeometry(1.1,1.12,.07,64),new THREE.MeshStandardMaterial({color:'#dce5d0',roughness:.8}));floor.position.y=-.04;floor.receiveShadow=true;scene.add(floor);
   const camera=new THREE.OrthographicCamera(-1.1,1.1,1.1,-1.1,.1,40);
   const state={THREE,scene,renderer,camera,floor,loader:new GLTFLoader(),model:null,mixer:null,target:new THREE.Vector3()};
   window.petInspection=state;
   window.loadPet=async id=>{
    if(state.model)scene.remove(state.model);
    const file=id==='bunny'?'assets/models/bunny.glb':`assets/models/companions/${id}.glb`;
    const gltf=await state.loader.loadAsync(base+'/'+file);state.model=gltf.scene;scene.add(gltf.scene);
    gltf.scene.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});
    const bounds=new THREE.Box3().setFromObject(gltf.scene),size=bounds.getSize(new THREE.Vector3());
    state.target.copy(bounds.getCenter(new THREE.Vector3()));
    const span=Math.max(size.x,size.y,size.z)*1.34;
    camera.left=-span/2;camera.right=span/2;camera.top=span/2;camera.bottom=-span/2;camera.updateProjectionMatrix();
    floor.position.x=state.target.x;floor.position.z=state.target.z;
    state.mixer=new THREE.AnimationMixer(gltf.scene);state.mixer.clipAction(gltf.animations[0]).play();state.mixer.setTime(0);
    state.head=null;gltf.scene.traverse(o=>{if(o.userData.role==='head')state.head=o;});
    return {id,clips:gltf.animations.length,size:size.toArray(),minY:bounds.min.y,headChildren:state.head?.children.length};
   };
   window.posePet=(view,time=0)=>{
    const angles={front:[0,.08,5],side:[5,.08,0],back:[0,.08,-5],'three-quarter':[3.2,1.4,5],'idle-extreme':[3.2,1.4,5]};
    state.mixer.setTime(time);camera.position.copy(state.target).add(new THREE.Vector3(...angles[view]));camera.lookAt(state.target);
    renderer.render(scene,camera);return {head:state.head.quaternion.toArray(),triangles:renderer.info.render.triangles,drawCalls:renderer.info.render.calls};
   };
  },base);
  const report=[];
  for(const id of ids){
   const diagnostic=await page.evaluate(id=>window.loadPet(id),id);
   assert(diagnostic.clips>0&&diagnostic.headChildren>0,id+' real idle/head');
   assert(Math.abs(diagnostic.minY)<.01,id+' grounded feet');
   for(const view of ['front','side','back','three-quarter','idle-extreme']){
    await page.evaluate(({view,time})=>window.posePet(view,time),{view,time:view==='idle-extreme'?1.05:0});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:path.join(out,`${id}-${view}.png`)});
   }
   const initial=await page.evaluate(()=>window.posePet('front',0));
   const moved=await page.evaluate(()=>window.posePet('front',1.05));
   assert(initial.head.some((n,i)=>Math.abs(n-moved.head[i])>.0001),id+' head animation really changes');
   await page.setViewportSize({width:256,height:256});
   await page.evaluate(()=>{const s=window.petInspection;s.renderer.setSize(256,256);window.posePet('three-quarter',0);});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.screenshot({path:path.resolve('assets/models/companions',id+'-portrait.png')});
   await page.setViewportSize({width:512,height:512});await page.evaluate(()=>window.petInspection.renderer.setSize(512,512));
   report.push({...diagnostic,triangles:initial.triangles,drawCalls:initial.drawCalls});
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'runtime-check.json'),JSON.stringify({assets:report,errors},null,2));
  const names={bunny:'团团 · 小兔',squirrel:'栗栗 · 松鼠',cat:'米米 · 小猫',dog:'豆豆 · 小狗',hedgehog:'刺刺 · 刺猬',turtle:'慢慢 · 乌龟',raccoon:'圈圈 · 浣熊',fox:'橙橙 · 狐狸'};
  await page.setViewportSize({width:1024,height:700});
  await page.setContent(`<style>body{margin:0;padding:24px;background:#f8f5ed;color:#2c4239;font:16px -apple-system,sans-serif}h1{font-size:24px;font-weight:500;margin:0 0 18px}.lineup{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.pet{text-align:center}.pet img{display:block;width:100%;border-radius:16px}.pet p{margin:8px 0 0}</style><h1>词遇岛 · 八位立体小伙伴</h1><div class="lineup">${ids.map(id=>`<div class="pet"><img src="${base}/assets/models/companions/${id}-portrait.png" alt="${names[id]}"><p>${names[id]}</p></div>`).join('')}</div>`);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.resolve('design/screenshots/companions-lineup.png'),fullPage:true});
  await page.setContent(`<style>body{margin:0;padding:15px;background:#f8f5ed;color:#2c4239;font:14px -apple-system,sans-serif}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.pet{text-align:center}.pet img{display:block;width:100%}.pet p{margin:4px 0 0}</style><div class="grid">${ids.flatMap(id=>['side','back'].map(view=>`<div class="pet"><img src="${base}/design/screenshots/companions/${id}-${view}.png" alt="${id} ${view}"><p>${names[id]} · ${view}</p></div>`)).join('')}</div>`);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(out,'side-back-review.png'),fullPage:true});
  console.log(JSON.stringify({passed:ids,assets:report,errors}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
