const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = () => page.evaluate(() => ({
    animationTime: window.visibilityWorld.getDiagnostics().actors.find(actor => actor.name === 'hero').animationTime,
    renders: window.visibilityRenders,
    queued: Boolean(window.visibilityWorld._raf),
    scene: window.visibilityWorld.currentScene,
  }));
  const settle = () => page.waitForTimeout(250);
  const scrollOut = async () => { await page.evaluate(() => scrollTo(0, 1300)); await settle(); };
  const scrollIn = async () => { await page.evaluate(() => scrollTo(0, 0)); await settle(); };
  const assertStopped = async reason => {
    const a = await snapshot(); await page.waitForTimeout(350); const b = await snapshot();
    assert.equal(b.animationTime, a.animationTime, `${reason}: 离屏或暂停时不应继续推进角色动画`);
    assert.equal(b.renders, a.renders, `${reason}: 不应持续调用 WebGL render`);
    assert.equal(b.queued, false, `${reason}: 不应保留待执行 RAF`);
  };
  const setHidden = hidden => page.evaluate(hidden => {
    window.fixtureDocumentHidden = hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  try {
    // Use a project-origin text resource, then a fixture, to isolate WorldView from app/content edits.
    await page.goto(`${base}/vendor/THREE-LICENSE.txt`);
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#stage{height:360px;width:100%}#after{height:1900px}</style><script type="importmap">{"imports":{"three":"${base}/vendor/three.module.js"}}</script><div id="stage"></div><div id="after">学习手记位置</div>`);
    await page.evaluate(async base => {
      const { WorldView } = await import(`${base}/src/world.js`);
      window.visibilityClicks = []; window.visibilityRenders = 0; window.resumeDeltas = [];
      const world = window.visibilityWorld = new WorldView(document.getElementById('stage'), { onInteract: id => window.visibilityClicks.push(id) });
      await world.ready;
      const originalRender = world.renderer.render.bind(world.renderer);
      world.renderer.render = (...args) => { window.visibilityRenders += 1; return originalRender(...args); };
      const hero = world._actors.find(actor => actor.name === 'hero');
      const originalUpdate = hero.mixer.update.bind(hero.mixer);
      hero.mixer.update = delta => { if (window.captureResume) window.resumeDeltas.push(delta); return originalUpdate(delta); };
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => Boolean(window.fixtureDocumentHidden) });
    }, base);
    await page.waitForFunction(() => window.visibilityWorld.getDiagnostics().actors[0].animationTime > 0);
    const running = await snapshot(); await settle();
    assert((await snapshot()).animationTime > running.animationTime, '画布可见时应正常播放');

    const point = await page.evaluate(() => window.visibilityWorld.getObjectScreenPoint('home.bookshelf'));
    assert(point?.visible, '书柜仍须有真实可点击物件');
    await page.touchscreen.tap(point.x, point.y);
    assert.deepEqual(await page.evaluate(() => window.visibilityClicks), ['home.bookshelf']);

    await scrollOut();
    await assertStopped('手机向下滚动做题');
    await page.evaluate(() => { window.captureResume = true; window.resumeDeltas = []; });
    await scrollIn();
    assert.equal(await page.evaluate(() => window.resumeDeltas[0]), 0, '返回视口首帧 delta 必须重置，不能补播离屏时间');
    const resumed = await snapshot(); await settle();
    assert((await snapshot()).animationTime > resumed.animationTime, '滚回后动画恢复');

    await setHidden(true); await settle(); await assertStopped('document.hidden');
    await scrollOut(); await setHidden(false); await settle();
    await assertStopped('页面恢复但画布仍离屏');
    await scrollIn();
    const activeAgain = await snapshot(); await settle();
    assert((await snapshot()).animationTime > activeAgain.animationTime, '页面和画布都恢复可见后播放');

    await page.emulateMedia({ reducedMotion: 'reduce' }); await settle();
    await assertStopped('减少动态后的按需渲染');
    const beforeReset = await snapshot();
    await page.evaluate(() => window.visibilityWorld.resetCamera()); await settle();
    assert((await snapshot()).renders > beforeReset.renders, '减少动态时相机操作仍须重新绘制');
    await assertStopped('按需绘制后再次停止');

    await scrollOut();
    const beforeSwitch = await snapshot();
    await page.evaluate(() => window.visibilityWorld.setScene('camp')); await settle();
    assert.equal((await snapshot()).renders, beforeSwitch.renders, '离屏场景切换不触发渲染');
    await scrollIn();
    assert.equal((await snapshot()).scene, 'camp');
    assert((await snapshot()).renders > beforeSwitch.renders, '滚回时绘制当前场景');
    const crate = await page.evaluate(() => window.visibilityWorld.getObjectScreenPoint('camp.crate'));
    assert(crate?.visible, '切换后探索木箱仍有真实命中点');
    await page.touchscreen.tap(crate.x, crate.y);
    assert((await page.evaluate(() => window.visibilityClicks)).includes('camp.crate'));

    await page.emulateMedia({ reducedMotion: 'no-preference' }); await settle();
    const motionRestored = await snapshot(); await settle();
    assert((await snapshot()).animationTime > motionRestored.animationTime, '关闭减少动态后继续正常动画');
    await page.evaluate(() => window.visibilityWorld.dispose());
    const disposedRenders = (await snapshot()).renders;
    await scrollOut(); await scrollIn();
    assert.equal((await snapshot()).renders, disposedRenders, 'dispose 后观察器不应重启渲染');
    assert.equal((await snapshot()).queued, false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: ['真实手机尺寸滚动离屏暂停动画与WebGL', '返回视口首帧delta为零并恢复', '页面隐藏与离屏条件组合', 'reduced-motion按需绘制', '离屏场景切换后恢复', '真实触屏热点不回归', 'dispose不再启动RAF'], errors }));
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
