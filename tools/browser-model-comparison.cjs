// Internal QA only: side-by-side renders of source and publish-optimized GLB bytes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = process.env.PREVIEW_URL || 'http://127.0.0.1:4181';
const output = process.env.BUILD_OUTPUT || path.resolve('_site');
const evidence = process.env.MODEL_QA_OUTPUT || '/private/tmp/word-island-model-comparison';
const ids = ['home', 'camp', 'hero', 'child', 'bunny', 'squirrel', 'cat', 'dog', 'hedgehog', 'turtle', 'raccoon', 'fox'];
const fileFor = id => ['home', 'camp', 'hero', 'child', 'bunny'].includes(id) ? `assets/models/${id}.glb` : `assets/models/companions/${id}.glb`;

(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 560 }, deviceScaleFactor: 1 }), errors = [], report = [];
    page.on('pageerror', error => errors.push(error.message));
    // Same-origin transport wrapper serves the exact generated files, avoiding test-only CORS changes.
    await page.route('**/__optimized__/**', async route => {
      const file = new URL(route.request().url()).pathname.split('/__optimized__/')[1];
      assert(ids.some(id => fileFor(id) === file));
      await route.fulfill({ path: path.join(output, file), contentType: 'model/gltf-binary' });
    });
    await page.goto(`${source}/vendor/THREE-LICENSE.txt`);
    await page.setContent(`<style>body{margin:0;background:#eaf0e3;font:16px sans-serif;color:#294537}header{height:48px;display:flex;justify-content:space-around;align-items:center}canvas{display:block}</style><header><span>原始模型 · Source</span><span>发布精简模型 · Optimized</span></header><script type="importmap">{"imports":{"three":"${source}/vendor/three.module.js"}}</script>`);
    await page.evaluate(async source => {
      const THREE = await import(`${source}/vendor/three.module.js`);
      const { GLTFLoader } = await import(`${source}/vendor/loaders/GLTFLoader.js`);
      const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(1024, 512); renderer.setPixelRatio(1);
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
      renderer.setScissorTest(true); document.body.append(renderer.domElement);
      const panels = [0, 1].map(() => {
        const scene = new THREE.Scene(); scene.background = new THREE.Color('#eaf0e3');
        scene.add(new THREE.HemisphereLight('#fff7e6', '#8b9b83', 2));
        const key = new THREE.DirectionalLight('#fff0cf', 2.7); key.position.set(-3, 9, 7); scene.add(key);
        return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 200), model: null };
      });
      const loader = new GLTFLoader(), dispose = object => object.traverse(node => { node.geometry?.dispose(); for (const material of Array.isArray(node.material) ? node.material : [node.material]) material?.dispose(); });
      window.compareLoad = async file => {
        const measurements = [];
        for (const [index, panel] of panels.entries()) {
          if (panel.model) { panel.scene.remove(panel.model); panel.mixer?.stopAllAction(); panel.mixer?.uncacheRoot(panel.model); dispose(panel.model); }
          const gltf = await loader.loadAsync(`${source}/${index ? '__optimized__/' : ''}${file}`);
          panel.model = gltf.scene; panel.scene.add(panel.model); panel.mixer = gltf.animations.length ? new THREE.AnimationMixer(panel.model) : null;
          if (panel.mixer) { panel.mixer.clipAction(gltf.animations[0]).play(); panel.mixer.setTime(0); }
          const box = new THREE.Box3().setFromObject(panel.model), size = box.getSize(new THREE.Vector3());
          if (!index) { window.compareTarget = box.getCenter(new THREE.Vector3()); window.compareSpan = Math.max(size.x, size.y, size.z) * 1.36; }
          panel.camera.left = panel.camera.bottom = -window.compareSpan / 2; panel.camera.right = panel.camera.top = window.compareSpan / 2; panel.camera.updateProjectionMatrix();
          panel.head = null; panel.model.traverse(node => { if (node.userData.role === 'head' && node.children.length) panel.head = node; });
          measurements.push({ min: box.min.toArray(), max: box.max.toArray(), clips: gltf.animations.length });
        }
        return measurements;
      };
      window.comparePose = (view, time) => {
        const offsets = { front: [0, .12, 3], side: [3, .12, 0], back: [0, .12, -3], 'three-quarter': [2, 1.6, 3], 'idle-extreme': [2, 1.6, 3] };
        return panels.map((panel, index) => {
          panel.mixer?.setTime(time); panel.camera.position.copy(window.compareTarget).add(new THREE.Vector3(...offsets[view]).multiplyScalar(window.compareSpan)); panel.camera.lookAt(window.compareTarget);
          renderer.setViewport(index * 512, 0, 512, 512); renderer.setScissor(index * 512, 0, 512, 512); renderer.render(panel.scene, panel.camera);
          return { head: panel.head?.quaternion.toArray() || null, triangles: renderer.info.render.triangles };
        });
      };
    }, source);
    for (const id of ids) {
      const measurements = await page.evaluate(file => window.compareLoad(file), fileFor(id));
      assert.equal(measurements[0].clips, measurements[1].clips);
      for (const bound of ['min', 'max']) for (let axis = 0; axis < 3; axis++) assert(Math.abs(measurements[0][bound][axis] - measurements[1][bound][axis]) < .005, `${id} world bounds must remain aligned`);
      let initialHead;
      for (const view of ['front', 'side', 'back', 'three-quarter', ...(measurements[0].clips ? ['idle-extreme'] : [])]) {
        const pose = await page.evaluate(({ view, time }) => window.comparePose(view, time), { view, time: view === 'idle-extreme' ? 1.05 : 0 });
        if (view === 'front') initialHead = pose[0].head;
        if (initialHead) {
          assert(pose[0].head.every((value, index) => Math.abs(value - pose[1].head[index]) < 1e-6), `${id} linked head pose must match`);
          if (view === 'idle-extreme') assert(pose[0].head.some((value, index) => Math.abs(value - initialHead[index]) > .0001), `${id} real head motion must survive`);
        }
        await page.screenshot({ path: path.join(evidence, `${id}-${view}.png`) });
      }
      report.push({ id, measurements });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ assets: report, errors }, null, 2));
    const images = ids.flatMap(id => ['three-quarter', 'side', 'back'].map(view => `${id}-${view}.png`));
    await page.setViewportSize({ width: 1536, height: 1000 });
    await page.setContent(`<style>body{margin:0;background:#f8f5ed;font:15px sans-serif}.grid{display:grid;grid-template-columns:repeat(3,1fr)}figure{margin:0;padding:7px}img{width:100%;display:block}figcaption{text-align:center}</style><div class="grid">${images.map(file => `<figure><img src="data:image/png;base64,${fs.readFileSync(path.join(evidence, file)).toString('base64')}"><figcaption>${file} · 左原始 / 右精简</figcaption></figure>`).join('')}</div>`);
    await page.screenshot({ path: path.join(evidence, 'comparison-gallery.png'), fullPage: true });
    console.log(JSON.stringify({ passed: ids, imagePairs: ids.length * 3, evidence, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
