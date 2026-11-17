const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173';

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const page = await context.newPage(), errors = [], report = { engine: 'Chrome mobile emulation; not real iPhone power measurements' };
  page.on('pageerror', error => errors.push(error.message));
  const countFor = async ms => {
    const before = await page.evaluate(() => window.budgetFrames);
    const start = Date.now(); await page.waitForTimeout(ms);
    return { frames: (await page.evaluate(() => window.budgetFrames)) - before, ms: Date.now() - start };
  };
  try {
    await page.goto(`${base}/vendor/THREE-LICENSE.txt`);
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#stage{height:360px;width:100%}#after{height:1900px}</style><script type="importmap">{"imports":{"three":"${base}/vendor/three.module.js"}}</script><div id="stage"></div><div id="after">练习区</div>`);
    await page.evaluate(async base => {
      const { WorldView } = await import(`${base}/src/world.js`);
      window.budgetFrames = 0; window.budgetClicks = [];
      window.budgetWorld = new WorldView(document.getElementById('stage'), {
        onInteract: id => window.budgetClicks.push(id), onFrame: () => window.budgetFrames++,
      });
      await window.budgetWorld.ready;
    }, base);
    await page.waitForFunction(() => window.budgetFrames > 0);
    report.buffer = await page.evaluate(() => ({ width: window.budgetWorld.canvas.width, height: window.budgetWorld.canvas.height,
      ratio: window.budgetWorld.renderer.getPixelRatio(), shadow: window.budgetWorld.scene.children.find(child => child.isDirectionalLight).shadow.mapSize.x }));
    const point = await page.evaluate(() => window.budgetWorld.getObjectScreenPoint('home.bookshelf'));
    assert(point?.visible); await page.touchscreen.tap(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => window.budgetClicks), ['home.bookshelf']);
    report.active = await countFor(1800);
    await page.waitForTimeout(5200);
    report.idle = await countFor(1800);
    console.log(JSON.stringify({ phase: 'render-budget-observed', ...report }));
    assert.equal(report.buffer.ratio, 1, 'a 3x touch device should use the 1x mobile render budget');
    assert.equal(report.buffer.shadow, 512, 'mobile shadows should use a 512 map');
    assert(report.active.frames > 0 && report.active.frames / report.active.ms * 1000 <= 34, 'interactive mobile rendering must be capped near 30fps');
    assert(report.idle.frames > 0 && report.idle.frames / report.idle.ms * 1000 <= 15, 'idle mobile rendering must be capped near 12fps');
    assert.equal(await page.evaluate(() => window.budgetWorld.getDiagnostics().renderBudget.targetFps), 12);

    await page.touchscreen.tap(point.x, point.y);
    assert.equal(await page.evaluate(() => window.budgetWorld.getDiagnostics().renderBudget.targetFps), 30, 'touch must wake the active budget');
    await page.evaluate(() => window.budgetWorld.celebrate());
    report.celebration = await countFor(700);
    assert(report.celebration.frames > 0, 'celebration must still animate');
    await page.evaluate(() => window.budgetWorld.focusObject('home.clues'));
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(() => window.budgetWorld._cameraTween), null, 'focus transition must finish under the capped budget');

    await page.evaluate(() => scrollTo(0, 1300)); await page.waitForTimeout(200);
    report.offscreen = await countFor(450); assert.equal(report.offscreen.frames, 0);
    assert.equal(await page.evaluate(() => Boolean(window.budgetWorld._raf || window.budgetWorld._frameTimer)), false);
    await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(200);
    assert((await countFor(350)).frames > 0);
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(250);
    report.reducedMotion = await countFor(350); assert.equal(report.reducedMotion.frames, 0);
    const beforeReset = await page.evaluate(() => window.budgetFrames);
    await page.evaluate(() => window.budgetWorld.resetCamera()); await page.waitForTimeout(250);
    assert((await page.evaluate(() => window.budgetFrames)) > beforeReset, 'reduced-motion view must still react to a camera reset');
    assert.equal((await countFor(250)).frames, 0);
    await page.evaluate(() => window.budgetWorld.dispose());
    assert.equal((await countFor(250)).frames, 0);
    assert.equal(await page.evaluate(() => Boolean(window.budgetWorld._raf || window.budgetWorld._frameTimer)), false);
    assert.deepEqual(errors, []); report.errors = errors;
    fs.writeFileSync('/private/tmp/word-island-render-budget-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: ['mobile render resolution and shadow budget', 'interactive 30fps cap', 'idle 12fps cap', 'real touch wakes rendering', 'celebration and focus', 'offscreen stops timer and RAF', 'reduced-motion and disposal'], report }));
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
