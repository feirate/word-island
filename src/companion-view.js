import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import { COMPANIONS } from './companions.js';

// One shared WebGL view for the selected catalog entry, not one canvas per card.
export class CompanionView {
  constructor(container,{onReady=()=>{},onError=()=>{},onFrame=()=>{}}={}) {
    this.container=container;this.onReady=onReady;this.onError=onError;this.onFrame=onFrame;
    this._models=new Map();this._pending=new Map();this._selection=0;this._frames=0;
    this._active=true;this._disposed=false;this._raf=0;this._lastNow=0;this._lastShadowAt=0;
    this._inViewport=typeof IntersectionObserver!=='function';
    this.ready=this._initialize().catch(error=>{this._error=error.message;if(!this._disposed)this.onError(error);throw error;});
  }

  async _initialize() {
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color('#e5ede3');
    this.renderer=new THREE.WebGLRenderer({antialias:true});
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.1;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;this.renderer.shadowMap.autoUpdate=false;
    this.canvas=this.renderer.domElement;Object.assign(this.canvas.style,{display:'block',width:'100%',height:'100%',touchAction:'none'});
    this.canvas.setAttribute('aria-label','伙伴三维形象；拖动旋转，双指缩放。');this.container.append(this.canvas);
    this.camera=new THREE.OrthographicCamera(-2,2,2,-2,.1,50);
    this.controls=new OrbitControls(this.camera,this.canvas);this.controls.enablePan=false;this.controls.minZoom=.65;this.controls.maxZoom=1.6;
    this.controls.rotateSpeed=.6;this.controls.zoomSpeed=.6;this.controls.dampingFactor=.1;
    this.controls.minPolarAngle=.55;this.controls.maxPolarAngle=1.5;
    this._motionQuery=matchMedia('(prefers-reduced-motion: reduce)');this._reducedMotion=this._motionQuery.matches;this.controls.enableDamping=!this._reducedMotion;
    this.scene.add(new THREE.HemisphereLight('#fff7e6','#82917b',2));
    const light=new THREE.DirectionalLight('#fff0df',2.8);light.position.set(-3,6,5);light.castShadow=true;light.shadow.mapSize.set(512,512);light.shadow.normalBias=.035;
    Object.assign(light.shadow.camera,{left:-3,right:3,top:4,bottom:-2,near:.1,far:20});this.scene.add(light);
    this._platform=new THREE.Mesh(new THREE.CylinderGeometry(1,1,.09,48),new THREE.MeshStandardMaterial({color:'#dce5ce',roughness:1}));
    this._platform.position.y=-.045;this._platform.receiveShadow=true;this.scene.add(this._platform);
    this._changed=()=>this._invalidate();this.controls.addEventListener('change',this._changed);
    this._motionChanged=event=>{this._reducedMotion=event.matches;this.controls.enableDamping=!event.matches;this._lastNow=0;if(event.matches)this._current?.mixer?.setTime(0);this._invalidate();};
    this._motionQuery.addEventListener('change',this._motionChanged);
    this._visibilityChanged=()=>this._syncVisibility();document.addEventListener('visibilitychange',this._visibilityChanged);
    if(typeof IntersectionObserver==='function') {
      this._viewportObserver=new IntersectionObserver(entries=>{const entry=entries.find(item=>item.target===this.container);if(entry){this._inViewport=entry.isIntersecting;this._syncVisibility();}});
      this._viewportObserver.observe(this.container);
    }
    this._contextLost=event=>{event.preventDefault();this._error='伙伴画面暂时中断，请重新打开页面。';this._syncVisibility();this.onError(new Error(this._error));};
    this.canvas.addEventListener('webglcontextlost',this._contextLost);
    this._resizeObserver=new ResizeObserver(()=>this._resize());this._resizeObserver.observe(this.container);
    this.resetCamera();return this;
  }

  async _load(pet) {
    if(this._models.has(pet.id))return this._models.get(pet.id);
    if(this._pending.has(pet.id))return this._pending.get(pet.id);
    const pending=(async()=>{
      const gltf=await new GLTFLoader().loadAsync(new URL(`../${pet.modelFile}`,import.meta.url).href);
      const root=gltf.scene,materials=[],grayByOriginal=new Map();
      root.traverse(mesh=>{
        if(!mesh.isMesh)return;
        mesh.castShadow=true;mesh.receiveShadow=true;
        const original=mesh.material;
        const grayFor=material=>{
          if(grayByOriginal.has(material))return grayByOriginal.get(material);
          const gray=material.clone();
          if(gray.color){const c=gray.color;const luminance=.24+.58*Math.sqrt(c.r*.2126+c.g*.7152+c.b*.0722);gray.color.setRGB(luminance,luminance,luminance);}
          if(gray.emissive)gray.emissive.set(0x000000);
          gray.map=null;gray.emissiveMap=null;gray.metalness=0;gray.roughness=.9;
          grayByOriginal.set(material,gray);return gray;
        };
        materials.push({mesh,original,gray:Array.isArray(original)?original.map(grayFor):grayFor(original)});
      });
      root.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(root),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
      root.position.set(-center.x,-box.min.y,-center.z);
      const mixer=gltf.animations.length?new THREE.AnimationMixer(root):null;
      if(mixer){mixer.clipAction(gltf.animations[0]).play();mixer.setTime(0);}
      const entry={id:pet.id,root,materials,mixer,size,grayMaterials:[...grayByOriginal.values()]};
      if(this._disposed){this._disposeEntry(entry);return entry;}
      root.visible=false;this.scene.add(root);this._models.set(pet.id,entry);return entry;
    })();
    this._pending.set(pet.id,pending);
    try{return await pending;}finally{this._pending.delete(pet.id);}
  }

  async setCompanion(id,unlocked=false) {
    const pet=COMPANIONS.find(item=>item.id===id);
    if(!pet)throw new Error('没有找到这位伙伴。');
    if(this._disposed)return false;
    if(this._selectedId===id&&this._gray===!Boolean(unlocked)&&this._current?.id===id)return true;
    const generation=++this._selection;this._selectedId=id;this._gray=!Boolean(unlocked);this._error=null;
    await this.ready;
    try {
      const entry=await this._load(pet);
      if(this._disposed||generation!==this._selection)return false;
      for(const model of this._models.values())model.root.visible=model===entry;
      for(const record of entry.materials)record.mesh.material=this._gray?record.gray:record.original;
      this._current=entry;
      this.canvas.setAttribute('aria-label',`${pet.name}，${pet.species}，${this._gray?'尚未获得的灰色形象':'已获得的彩色形象'}；拖动旋转，双指缩放。`);
      const radius=Math.max(entry.size.x,entry.size.z,.9)*.65;this._platform.scale.set(radius,1,radius);
      this.resetCamera();this._invalidate();this.onReady(this);return true;
    } catch(error) {
      if(this._disposed||generation!==this._selection)return false;
      this._error=error.message;this.onError(error);throw error;
    }
  }

  resetCamera() {
    if(this._disposed||!this.controls)return;
    const height=this._current?.size.y||2;
    this.controls.target.set(0,height*.48,0);this.camera.position.set(3,height*.48+1.65,5);this.camera.zoom=1;
    this.controls.update();this._resize();
  }

  _resize() {
    if(this._disposed||!this.renderer)return;
    const rect=this.container.getBoundingClientRect();if(rect.width<1||rect.height<1)return;
    const aspect=rect.width/rect.height,size=this._current?.size;
    const half=Math.max(size?.x||1.8,size?.y||2,size?.z||1.8)*.72;
    this.camera.left=-half*Math.max(1,aspect);this.camera.right=-this.camera.left;
    this.camera.top=half/Math.min(1,aspect);this.camera.bottom=-this.camera.top;
    this.camera.updateProjectionMatrix();this.renderer.setSize(rect.width,rect.height,false);this._invalidate();
  }

  setActive(active) {if(this._active!==Boolean(active)){this._active=Boolean(active);this._syncVisibility();}}
  _canRender(){return !this._disposed&&this._active&&this._inViewport&&!document.hidden&&Boolean(this._current)&&!this._error;}
  _syncVisibility(){cancelAnimationFrame(this._raf);this._raf=0;this._lastNow=0;this._invalidate();}
  _invalidate(){if(this._canRender()&&!this._raf)this._raf=requestAnimationFrame(now=>this._frame(now));}
  _frame(now) {
    this._raf=0;if(!this._canRender())return;
    const delta=this._lastNow?Math.min((now-this._lastNow)/1000,.05):0;this._lastNow=now;
    if(!this._reducedMotion)this._current.mixer?.update(delta);
    this.controls.update();
    if(now-this._lastShadowAt>100||this._reducedMotion){this.renderer.shadowMap.needsUpdate=true;this._lastShadowAt=now;}
    this.renderer.render(this.scene,this.camera);this._frames+=1;this.onFrame(this);
    if(!this._reducedMotion)this._invalidate();
  }

  getDiagnostics() {
    const colors=new Set();const materialColors=[];
    for(const record of this._current?.materials||[])for(const material of Array.isArray(record.mesh.material)?record.mesh.material:[record.mesh.material])if(material.color&&!colors.has(material)){colors.add(material);materialColors.push(material.color.toArray());}
    return {id:this._current?.id||null,ready:Boolean(this._current)&&this._current.id===this._selectedId,gray:this._gray,active:this._active,visibleInViewport:this._inViewport,reducedMotion:this._reducedMotion,frames:this._frames,animationTime:this._current?.mixer?.time||0,camera:this.camera?.position.toArray(),materialColors,error:this._error||null};
  }

  _disposeEntry(entry) {
    entry.mixer?.stopAllAction();entry.mixer?.uncacheRoot(entry.root);
    const geometries=new Set(),materials=new Set(entry.grayMaterials),textures=new Set();
    entry.root.traverse(mesh=>{if(mesh.geometry)geometries.add(mesh.geometry);});
    for(const record of entry.materials)for(const material of Array.isArray(record.original)?record.original:[record.original])materials.add(material);
    for(const material of materials)for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
    for(const resource of [...geometries,...materials,...textures])resource.dispose();
  }

  dispose() {
    if(this._disposed)return;this._disposed=true;this._selection+=1;cancelAnimationFrame(this._raf);this._raf=0;
    this._resizeObserver?.disconnect();this._viewportObserver?.disconnect();document.removeEventListener('visibilitychange',this._visibilityChanged);this._motionQuery?.removeEventListener('change',this._motionChanged);
    this.controls?.removeEventListener('change',this._changed);this.controls?.dispose();this.canvas?.removeEventListener('webglcontextlost',this._contextLost);
    for(const entry of this._models.values())this._disposeEntry(entry);
    this._platform?.geometry.dispose();this._platform?.material.dispose();this.renderer?.dispose();this.canvas?.remove();
  }
}
