// Internal QA: render the actual project's Three.js scene and character GLBs.
const { chromium } = require(process.env.WORD_ISLAND_PLAYWRIGHT || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.join(__dirname, 'screenshots');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.WORD_ISLAND_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__wordIsland?.world?._loaded, { timeout: 25000 });
    await page.evaluate(async () => { await window.__wordIsland.world.ready; });
    const diagnostics = await page.evaluate(() => window.__wordIsland.world.getDiagnostics());
    assert.equal(diagnostics.models.length, 4);
    assert.equal(diagnostics.error, null);
    await page.locator('#world-canvas canvas').screenshot({ path: path.join(output, 'home-three.png') });
    await page.evaluate(() => { const w = window.__wordIsland.world; w.setScene('camp'); w.setCompanionUnlocked(true); });
    await page.waitForTimeout(200);
    await page.locator('#world-canvas canvas').screenshot({ path: path.join(output, 'camp-three.png') });
    const characterChecks = [];
    for (const name of ['hero', 'bunny']) {
      await page.evaluate(name => {
        const w = window.__wordIsland.world;
        w._reducedMotion = true;
        w._roots.home.visible = w._roots.camp.visible = false;
        w._cameraTween = null;
        w.controls.enableDamping = false;
        w.controls.minAzimuthAngle = -Infinity; w.controls.maxAzimuthAngle = Infinity;
        w.controls.minPolarAngle = 0; w.controls.maxPolarAngle = Math.PI;
        const aspect = w.canvas.clientWidth / w.canvas.clientHeight;
        w.camera.left = -1.45 * aspect; w.camera.right = 1.45 * aspect;
        w.camera.top = 1.45; w.camera.bottom = -1.45; w.camera.zoom = 1;
        w.camera.updateProjectionMatrix();
        for (const actor of w._actors) {
          actor.group.visible = actor.name === name;
          actor.group.position.set(0, 0, 0);
          actor.group.scale.setScalar(1);
          actor.mixer?.setTime(0);
        }
        w._invalidate();
      }, name);
      for (const [view, position] of [['front', [0, 1.3, 5]], ['side', [5, 1.3, 0]], ['back', [0, 1.3, -5]], ['three-quarter', [3.4, 2.2, 5]]]) {
        await page.evaluate(position => {
          const w = window.__wordIsland.world;
          w.camera.position.fromArray(position); w.controls.target.set(0, 1.0, 0); w.controls.update(); w._invalidate();
        }, position);
        await page.waitForTimeout(150);
        await page.locator('#world-canvas canvas').screenshot({ path: path.join(output, `${name}-${view}.png`) });
      }
      characterChecks.push(await page.evaluate(name => {
        const w = window.__wordIsland.world, actor = w._actors.find(a => a.name === name);
        const clipCount = actor.mixer?._actions.length || 0;
        actor.mixer.setTime(0);
        const initial = actor.head.quaternion.toArray();
        actor.mixer.setTime(1.15);
        const moved = actor.head.quaternion.toArray();
        return { name, clipCount, linkedHeadChildren: actor.head.children.length, animated: initial.some((v, i) => Math.abs(v - moved[i]) > .0001) };
      }, name));
      const check = characterChecks.at(-1);
      assert(check.clipCount > 0 && check.linkedHeadChildren > 1 && check.animated, `Missing real linked head animation: ${name}`);
      await page.evaluate(() => window.__wordIsland.world._invalidate());
      await page.waitForTimeout(150);
      await page.locator('#world-canvas canvas').screenshot({ path: path.join(output, `${name}-idle-extreme.png`) });
    }
    assert.deepEqual(errors, []);
    const result = { diagnostics, characterChecks, browserErrors: errors, screenshots: fs.readdirSync(output).filter(x => x.endsWith('.png')) };
    fs.writeFileSync(path.join(__dirname, 'asset-runtime-check.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
