import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import { COMPANIONS } from './companions.js';

const SCENES = {
  home: {
    camera: [9, 8, 11], target: [0, 1.35, 0], span: 14,
    hero: [-0.5, 0.08, 1.25], guide: [.85, .08, .1], bunny: [2.6, 0.31, 1.3],
    interactions: ['home.door', 'home.bookshelf', 'home.clues'],
  },
  camp: {
    camera: [8, 8, 10], target: [0, 1, 0], span: 12.3,
    hero: [-.25, 0.055, 1.3], guide: [-2.8, .055, 2.65], bunny: [-1.6, 0.055, 2.2],
    interactions: ['camp.crate', 'camp.sign', 'camp.mailbox', 'camp.chest'],
  },
};
const ASSET_FILES = {home:'assets/models/home.glb',camp:'assets/models/camp.glb',hero:'assets/models/hero.glb',child:'assets/models/child.glb',...Object.fromEntries(COMPANIONS.map(pet=>[pet.id,pet.modelFile]))};
const ASSET_NAMES = Object.keys(ASSET_FILES);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class WorldView {
  constructor(container, { onInteract = () => {}, onReady = () => {}, onError = () => {}, onFrame = () => {} } = {}) {
    this.container = container;
    this.onInteract = onInteract;
    this.onReady = onReady;
    this.onError = onError;
    this.onFrame = onFrame;
    this.currentScene = 'home';
    this._unlocked = false;
    this._unlockedIds = new Set();
    this._playerName = '小探险家';
    this._active = true;
    this._disposed = false;
    this._loaded = false;
    this._raf = 0;
    this._elapsed = 0;
    this._lastNow = 0;
    this._lastInteractionAt = -Infinity;
    this._lastShadowAt = -Infinity;
    this._inViewport = typeof IntersectionObserver !== 'function';
    this._pausedAt = null;
    this._pointers = new Map();
    this._interactionNodes = new Map();
    this._actors = [];
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._deltaRotation = new THREE.Quaternion();
    this._stats = { fps: 0, triangles: 0, drawCalls: 0 };
    this._frames = 0;
    this._measuredAt = 0;
    this.ready = this._initialize().then(() => {
      if (this._disposed) throw new Error('三维视图已关闭。');
      this._loaded = true;
      this._invalidate();
      this.onReady(this);
      return this;
    }).catch((error) => {
      this._error = error.message;
      if (!this._disposed) this.onError(error);
      throw error;
    });
  }

  async _initialize() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e5ede3');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.canvas = this.renderer.domElement;
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%' });
    this.canvas.setAttribute('aria-label', '词遇岛三维世界；轻点物件互动，拖动旋转，双指缩放。');
    this.container.append(this.canvas);
    this.camera = new THREE.OrthographicCamera(-6, 6, 6, -6, 0.1, 80);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.rotateSpeed = 0.45;
    this.controls.zoomSpeed = 0.65;
    this.controls.minZoom = 0.8;
    this.controls.maxZoom = 1.6;
    this.controls.touches.ONE = THREE.TOUCH.ROTATE;
    this.controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
    const hemisphere = new THREE.HemisphereLight('#fff7e6', '#8b9b83', 2);
    const key = new THREE.DirectionalLight('#fff0cf', 2.7);
    key.position.set(-3, 9, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.5, far: 30 });
    key.shadow.normalBias = 0.035;
    key.shadow.bias = -0.00015;
    this.scene.add(hemisphere, key);

    this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._reducedMotion = this._motionQuery.matches;
    this.controls.enableDamping = !this._reducedMotion;
    this._motionChanged = (event) => {
      this._reducedMotion = event.matches;
      this._lastNow = 0;
      this.controls.enableDamping = !event.matches;
      if (event.matches) {
        this._celebration = null;
        for (const actor of this._actors) actor.mixer?.setTime(0);
      }
      this._invalidate();
    };
    this._motionQuery.addEventListener('change', this._motionChanged);
    this._visibilityChanged = () => this._syncVisibility();
    document.addEventListener('visibilitychange', this._visibilityChanged);
    if (typeof IntersectionObserver === 'function') {
      this._viewportObserver = new IntersectionObserver((entries) => {
        const entry = entries.find(item => item.target === this.container);
        if (!entry || this._disposed) return;
        this._inViewport = entry.isIntersecting;
        this._syncVisibility();
      });
      this._viewportObserver.observe(this.container);
    }
    this._controlChanged = () => this._invalidate();
    this._controlStarted = () => { this._cameraTween = null; };
    this.controls.addEventListener('change', this._controlChanged);
    this.controls.addEventListener('start', this._controlStarted);
    this._listeners = {
      pointerdown: (event) => this._onPointerDown(event),
      pointermove: (event) => this._onPointerMove(event),
      pointerup: (event) => this._onPointerUp(event),
      pointercancel: (event) => this._pointers.delete(event.pointerId),
      webglcontextlost: (event) => {
        event.preventDefault();
        this._error = '三维画面暂时中断，请重新打开页面。';
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        this.onError(new Error(this._error));
      },
    };
    for (const [type, listener] of Object.entries(this._listeners)) this.canvas.addEventListener(type, listener);
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.container);
    this.resetCamera();

    const loader = new GLTFLoader();
    const models = await Promise.all(ASSET_NAMES.map(async (name) => {
      try {
        const model = await loader.loadAsync(new URL(`../${ASSET_FILES[name]}`, import.meta.url).href);
        if (this._disposed) this._disposeObject(model.scene);
        return model;
      } catch (error) { throw new Error(`无法加载${name}三维模型：${error.message}`); }
    }));
    if (this._disposed) return;
    this._roots = Object.fromEntries(models.map((model, index) => [ASSET_NAMES[index], model.scene]));
    for (const root of Object.values(this._roots)) {
      root.traverse((object) => {
        if (object.isMesh) { object.castShadow = true; object.receiveShadow = true; }
        const id = object.userData.interactionId;
        // The empty arrival cushion is scenery; only the unlocked animal speaks as the companion.
        if (id === 'home.bunny') { delete object.userData.interactionId; return; }
        if (typeof id === 'string') {
          if (this._interactionNodes.has(id)) throw new Error(`三维互动标识重复：${id}`);
          this._interactionNodes.set(id, object);
        }
      });
    }
    for (const id of Object.values(SCENES).flatMap((scene) => scene.interactions)) {
      const object = this._interactionNodes.get(id);
      let geometry = false;
      object?.traverse((node) => { if (node.isMesh && node.geometry?.attributes.position?.count) geometry = true; });
      if (!geometry) throw new Error(`三维互动缺少真实物件：${id}`);
    }
    this.scene.add(this._roots.home, this._roots.camp);
    for (const [name, asset, scale] of [['hero','child',.85],['guide','hero',.65], ...COMPANIONS.map(pet=>[pet.id,pet.id,pet.scale])]) {
      const model = this._roots[asset];
      const group = new THREE.Group();
      group.name = `${name}-placement`;
      if (name === 'hero' || name === 'guide') {
        group.userData.interactionId = `character.${name}`;
        this._interactionNodes.set(`character.${name}`, group);
      } else {
        this._interactionNodes.set(`home.${name}`, group);
      }
      group.scale.setScalar(scale);
      group.add(model);
      this.scene.add(group);
      let head = null, tail = null;
      model.traverse((object) => {
        // Only rotate linked control groups, never isolated facial meshes.
        if (object.userData.role === 'head' && object.children.length) head = object;
        if (object.userData.role === 'tail' && object.children.length) tail = object;
      });
      const clips = models[ASSET_NAMES.indexOf(asset)].animations;
      const mixer = clips.length ? new THREE.AnimationMixer(model) : null;
      if (mixer) { mixer.clipAction(clips[0]).play(); mixer.setTime(0); }
      this.scene.updateMatrixWorld(true);
      const headBox = new THREE.Box3().setFromObject(head || model);
      const headTop = headBox.getCenter(new THREE.Vector3());
      headTop.y = headBox.max.y + 0.16;
      const speechAnchor = new THREE.Object3D();
      const anchorParent = head || group;
      speechAnchor.position.copy(anchorParent.worldToLocal(headTop));
      anchorParent.add(speechAnchor);
      this._actors.push({ name, modelAsset:asset, displayName:name==='hero'?this._playerName:name==='guide'?'芽芽':COMPANIONS.find(pet=>pet.id===name).name, group, model, scale: model.scale.clone(), placementScale: scale, mixer, head, tail,
        speechAnchor, headRotation: head?.quaternion.clone(), tailRotation: tail?.quaternion.clone() });
    }
    this.setPlayerName(this._playerName);
    this.setScene(this.currentScene);
  }

  setScene(name) {
    if (!SCENES[name]) throw new Error(`未知场景：${name}`);
    this.currentScene = name;
    if (this._appliedScene === name) { this._invalidate(); return; }
    if (this._roots) {
      this._roots.home.visible = name === 'home';
      this._roots.camp.visible = name === 'camp';
      this._placeActors();
      this._appliedScene = name;
    }
    this._pointers.clear();
    this._celebration = null;
    this.resetCamera();
  }

  setCompanionUnlocked(unlocked) {
    this.setCompanionsUnlocked(unlocked ? ['bunny'] : []);
  }

  setCompanionsUnlocked(ids) {
    if(!Array.isArray(ids)||ids.some(id=>!COMPANIONS.some(pet=>pet.id===id)))throw new Error('伙伴列表无效。');
    const next=new Set(ids);
    if(next.size===this._unlockedIds.size&&[...next].every(id=>this._unlockedIds.has(id)))return;
    this._unlockedIds=next;
    this._unlocked=next.has('bunny');
    this._placeActors();
    this._invalidate();
  }

  _placeActors() {
    for(const actor of this._actors) {
      if(actor.name==='hero'||actor.name==='guide') {actor.group.position.fromArray(SCENES[this.currentScene][actor.name]);actor.group.visible=true;continue;}
      const pet=COMPANIONS.find(item=>item.id===actor.name);
      actor.group.position.fromArray(this.currentScene==='home'?pet.home:actor.name==='bunny'?SCENES.camp.bunny:pet.home);
      actor.group.visible=this._unlockedIds.has(actor.name)&&(this.currentScene==='home'||actor.name==='bunny');
      if(this.currentScene==='home')actor.group.userData.interactionId=`home.${actor.name}`;
      else delete actor.group.userData.interactionId;
    }
  }

  setPlayerName(name) {
    if(typeof name!=='string')throw new Error('小朋友的名字无效。');
    this._playerName=name.trim()||'小探险家';
    const hero=this._actors.find(actor=>actor.name==='hero');
    if(hero){hero.displayName=this._playerName;hero.group.userData.characterName=this._playerName;hero.model.userData.characterName=this._playerName;}
    this.canvas?.setAttribute('aria-label',`词遇岛三维世界；主角${this._playerName}和向导芽芽；轻点物件互动，拖动旋转，双指缩放。`);
  }

  setActive(active) {
    if(this._active===Boolean(active))return;
    this._active=Boolean(active);
    this._syncVisibility();
  }

  _resize() {
    if (!this.renderer || this._disposed) return;
    const rect = this.container.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const aspect = rect.width / rect.height;
    const width = SCENES[this.currentScene].span * Math.max(1, aspect / 1.4);
    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = width / aspect / 2;
    this.camera.bottom = -width / aspect / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height, false);
    this._invalidate();
  }

  resetCamera() {
    if (!this.camera || this._disposed) return;
    const config = SCENES[this.currentScene];
    this._cameraTween = null;
    this.camera.position.fromArray(config.camera);
    this.controls.target.fromArray(config.target);
    this.camera.zoom = 1;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const azimuth = Math.atan2(offset.x, offset.z);
    const polar = Math.acos(offset.y / offset.length());
    this.controls.minAzimuthAngle = azimuth - 0.36;
    this.controls.maxAzimuthAngle = azimuth + 0.36;
    this.controls.minPolarAngle = polar - 0.18;
    this.controls.maxPolarAngle = Math.min(polar + 0.12, 1.25);
    this.controls.update();
    this._resize();
  }

  focusObject(id) {
    const object = this._interactionNodes.get(id);
    if (!object || !this._isVisible(object) || this._disposed) return false;
    this.scene.updateMatrixWorld(true);
    const target = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
    const offset = this.camera.position.clone().sub(this.controls.target);
    this._cameraTween = {
      start: performance.now(), from: this.camera.position.clone(), to: target.clone().add(offset),
      targetFrom: this.controls.target.clone(), targetTo: target,
      zoomFrom: this.camera.zoom, zoomTo: 1.25,
    };
    this._invalidate();
    return true;
  }

  celebrate() {
    if (this._disposed || this._celebration) return;
    if (this._reducedMotion) { this._invalidate(); return; }
    this._celebration = { start: this._elapsed, duration: 1.6 };
    this._invalidate();
  }

  _isVisible(object) {
    for (let node = object; node; node = node.parent) if (!node.visible) return false;
    return true;
  }

  _semanticFor(object) {
    for (let node = object; node; node = node.parent) {
      if (typeof node.userData.interactionId === 'string') return node.userData.interactionId;
    }
    return null;
  }

  _pickAt(x, y) {
    if (this._disposed) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1 || x < rect.left || y < rect.top || x > rect.left + rect.width || y > rect.top + rect.height) return null;
    this._pointer.set((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1);
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const meshes = [];
    this.scene.traverseVisible((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some((material) => material.visible && material.opacity > 0)) meshes.push(object);
    });
    const first = this._raycaster.intersectObjects(meshes, false)[0];
    return first ? this._semanticFor(first.object) : null;
  }

  getObjectScreenPoint(id) {
    const object = this._interactionNodes.get(id);
    if (!object || this._disposed) return null;
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const rect = this.canvas.getBoundingClientRect();
    const box = new THREE.Box3().setFromObject(object);
    const candidates = [box.getCenter(new THREE.Vector3())];
    object.traverseVisible((node) => {
      if (node.isMesh && candidates.length < 40) candidates.push(new THREE.Box3().setFromObject(node).getCenter(new THREE.Vector3()));
    });
    for (const point of candidates) {
      point.project(this.camera);
      const x = rect.left + (point.x + 1) * rect.width / 2;
      const y = rect.top + (1 - point.y) * rect.height / 2;
      if (point.z >= -1 && point.z <= 1 && this._pickAt(x, y) === id) return { x, y, visible: true, interactionId: id };
    }
    return { visible: false, interactionId: id };
  }

  // Bubble coordinates are local to the stage, independent of document scroll.
  getActorScreenPoint(name) {
    if (this._disposed) return null;
    const actor = this._actors.find(item => item.name === name);
    if (!actor) return null;
    if (!this._isVisible(actor.group)) return { name, visible: false };
    this.camera.updateMatrixWorld(true);
    const point = actor.speechAnchor.getWorldPosition(new THREE.Vector3()).project(this.camera);
    const canvas = this.canvas.getBoundingClientRect();
    const stage = this.container.getBoundingClientRect();
    return {
      name,
      x: canvas.left - stage.left + (point.x + 1) * canvas.width / 2,
      y: canvas.top - stage.top + (1 - point.y) * canvas.height / 2,
      visible: canvas.width > 0 && canvas.height > 0 && point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1,
    };
  }

  _onPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const multi = this._pointers.size > 0;
    if (multi) for (const pointer of this._pointers.values()) pointer.multi = true;
    this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: false, multi });
  }

  _onPointerMove(event) {
    const pointer = this._pointers.get(event.pointerId);
    if (pointer && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) pointer.moved = true;
  }

  _onPointerUp(event) {
    const pointer = this._pointers.get(event.pointerId);
    this._pointers.delete(event.pointerId);
    if (!pointer || pointer.moved || pointer.multi || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8) return;
    const now = performance.now();
    if (now - this._lastInteractionAt < 450 || this._interactionBusy) return;
    const id = this._pickAt(event.clientX, event.clientY);
    if (!id) return;
    this._lastInteractionAt = now;
    try {
      const result = this.onInteract(id);
      if (result?.then) {
        this._interactionBusy = true;
        Promise.resolve(result).catch((error) => this.onError(error)).finally(() => { this._interactionBusy = false; });
      }
    } catch (error) { this.onError(error); }
  }

  _canRender() {
    return this._loaded && this._active && !this._disposed && !document.hidden && this._inViewport && !this._error;
  }

  _syncVisibility() {
    if (this._disposed) return;
    this._lastNow = 0;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    const now = performance.now();
    if (!this._active || document.hidden || !this._inViewport) {
      this._pausedAt ??= now;
      return;
    }
    // Keep an in-progress focus move from jumping to its end after a long pause.
    if (this._pausedAt !== null && this._cameraTween) {
      this._cameraTween.start += now - Math.max(this._pausedAt, this._cameraTween.start);
    }
    this._pausedAt = null;
    this._measuredAt = now;
    this._frames = 0;
    this._invalidate();
  }

  _invalidate() {
    if (!this._canRender() || this._raf) return;
    this._raf = requestAnimationFrame((now) => this._frame(now));
  }

  _frame(now) {
    this._raf = 0;
    if (!this._canRender()) return;
    const delta = this._lastNow ? Math.min((now - this._lastNow) / 1000, 0.05) : 0;
    this._lastNow = now;
    this._elapsed += delta;
    const celebration = this._celebration;
    const progress = celebration ? Math.min(1, (this._elapsed - celebration.start) / celebration.duration) : 0;
    for (const [index, actor] of this._actors.entries()) {
      const breath = this._reducedMotion ? 0 : Math.sin(this._elapsed * 2 + index) * 0.007;
      const cheer = celebration && !this._reducedMotion ? Math.sin(progress * Math.PI * 6) * 0.018 * (1 - progress) : 0;
      // Exported idle clips own body/head/ear channels; celebration only owns the outer, foot-origin wrapper.
      if (actor.mixer) {
        if (!this._reducedMotion && actor.group.visible) actor.mixer.update(delta);
        actor.group.scale.y = actor.placementScale * (1 + cheer);
      } else actor.model.scale.y = actor.scale.y * (1 + breath + cheer);
      if (!actor.mixer && actor.head) {
        this._deltaRotation.setFromAxisAngle(X_AXIS, cheer * 5);
        actor.head.quaternion.copy(actor.headRotation).multiply(this._deltaRotation);
      }
      if (!actor.mixer && actor.tail) {
        this._deltaRotation.setFromAxisAngle(Y_AXIS, this._reducedMotion ? 0 : Math.sin(this._elapsed * 1.8) * 0.035);
        actor.tail.quaternion.copy(actor.tailRotation).multiply(this._deltaRotation);
      }
    }
    if (celebration && progress >= 1) this._celebration = null;
    if (this._cameraTween) {
      const tween = this._cameraTween;
      const t = this._reducedMotion ? 1 : Math.min(1, (now - tween.start) / 500);
      const ease = t * t * (3 - 2 * t);
      this.camera.position.lerpVectors(tween.from, tween.to, ease);
      this.controls.target.lerpVectors(tween.targetFrom, tween.targetTo, ease);
      this.camera.zoom = THREE.MathUtils.lerp(tween.zoomFrom, tween.zoomTo, ease);
      this.camera.updateProjectionMatrix();
      if (t === 1) this._cameraTween = null;
    }
    this.controls.update();
    if (now - this._lastShadowAt > 100 || this._reducedMotion) {
      this.renderer.shadowMap.needsUpdate = true;
      this._lastShadowAt = now;
    }
    this.renderer.render(this.scene, this.camera);
    this.onFrame(this);
    this._frames += 1;
    if (now - this._measuredAt > 1000) {
      this._stats = { fps: Math.round(this._frames * 1000 / (now - this._measuredAt)),
        triangles: this.renderer.info.render.triangles, drawCalls: this.renderer.info.render.calls };
      this._measuredAt = now;
      this._frames = 0;
    }
    if (!this._reducedMotion || this._cameraTween || this._celebration) this._invalidate();
  }

  getDiagnostics() {
    return { ready: this._loaded, scene: this.currentScene, models: this._roots ? Object.keys(this._roots) : [],
      interactions: [...this._interactionNodes.keys()], companionUnlocked: this._unlocked,unlockedCompanions:[...this._unlockedIds],active:this._active,playerName:this._playerName,
      reducedMotion: this._reducedMotion, visibleInViewport: this._inViewport, error: this._error || null, ...this._stats,
      actors: this._actors.map((actor) => ({ name: actor.name, modelAsset:actor.modelAsset, displayName:actor.displayName, visible: actor.group.visible,
        position: actor.group.position.toArray(), scale: actor.model.scale.toArray(),
        headRotation: actor.head?.quaternion.toArray() || null, animationTime: actor.mixer?.time || 0 })) };
  }

  _disposeObject(root) {
    const geometries = new Set(), materials = new Set(), textures = new Set();
    root.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    for (const resource of [...geometries, ...materials, ...textures]) resource.dispose();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._lastNow = 0;
    this._resizeObserver?.disconnect();
    this._viewportObserver?.disconnect();
    document.removeEventListener('visibilitychange', this._visibilityChanged);
    this._motionQuery?.removeEventListener('change', this._motionChanged);
    for (const [type, listener] of Object.entries(this._listeners || {})) this.canvas?.removeEventListener(type, listener);
    this.controls?.dispose();
    for (const actor of this._actors) { actor.mixer?.stopAllAction(); actor.mixer?.uncacheRoot(actor.model); }
    if (this.scene) this._disposeObject(this.scene);
    this.renderer?.dispose();
    this.canvas?.remove();
    this._pointers.clear();
  }
}
