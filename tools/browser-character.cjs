const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const anchor = name => page.evaluate(name => window.characterWorld.getActorScreenPoint(name), name);
  const snapshot = () => page.evaluate(() => ({ frames: window.characterFrames, diagnostics: window.characterWorld.getDiagnostics() }));
  const clickActor = async id => {
    await page.waitForTimeout(500);
    const point = await page.evaluate(id => window.characterWorld.getObjectScreenPoint(id), id);
    assert(point?.visible, `${id}: 必须命中真实角色网格`);
    await page.mouse.click(point.x, point.y);
    return point;
  };
  try {
    await page.goto(`${base}/vendor/THREE-LICENSE.txt`);
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:55px 30px}#stage{height:590px;width:950px}#after{height:1800px}</style><script type="importmap">{"imports":{"three":"${base}/vendor/three.module.js"}}</script><div id="stage"></div><div id="after"></div>`);
    await page.evaluate(async base => {
      const { WorldView } = await import(`${base}/src/world.js`);
      window.characterFrames = 0; window.characterClicks = [];
      window.characterWorld = new WorldView(document.getElementById('stage'), {
        onInteract: id => window.characterClicks.push(id),
        onFrame: () => { window.characterFrames += 1; },
      });
      await window.characterWorld.ready;
    }, base);
    assert.equal(await page.evaluate(() => typeof window.characterWorld.getActorScreenPoint), 'function', '角色需要公开气泡锚点 API');
    await page.waitForFunction(() => window.characterFrames > 1);
    const first = await anchor('hero');
    assert(first?.visible && first.x > 0 && first.x < 950 && first.y > 0 && first.y < 590, '芽芽头顶锚点应位于画布内');
    assert.equal((await anchor('bunny')).visible, false, '未解锁伙伴不应有可见气泡锚点');
    assert.equal(await anchor('missing'), null, '不存在的角色应返回 null');
    const picked = await clickActor('character.hero');
    const relative = await page.locator('#stage').boundingBox();
    assert(first.y < picked.y - relative.y, '气泡锚点应在真实角色的头上');
    assert.deepEqual(await page.evaluate(() => window.characterClicks), ['character.hero']);
    const beforeDrag = await anchor('hero');
    await page.mouse.move(relative.x + relative.width / 2, relative.y + relative.height / 2);
    await page.mouse.down(); await page.mouse.move(relative.x + relative.width / 2 + 140, relative.y + relative.height / 2 + 30, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(300);
    const afterDrag = await anchor('hero');
    assert(Math.hypot(afterDrag.x - beforeDrag.x, afterDrag.y - beforeDrag.y) > 2, '旋转场景后锚点应跟随角色投影移动');

    await page.evaluate(() => { window.characterWorld.setCompanionUnlocked(true); window.characterWorld.resetCamera(); });
    assert((await anchor('bunny')).visible, '解锁后的团团应有可见气泡锚点');
    await clickActor('home.bunny');
    assert((await page.evaluate(() => window.characterClicks)).includes('home.bunny'));
    await page.evaluate(() => window.characterWorld.setScene('camp'));
    await clickActor('character.hero');
    assert.equal((await page.evaluate(() => window.characterClicks)).filter(id => id === 'character.hero').length, 2, '两个场景都应能点击芽芽');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.body.style.padding = '20px 16px'; document.getElementById('stage').style.cssText = 'height:360px;width:100%'; });
    await page.waitForTimeout(250);
    const mobile = await anchor('hero');
    assert(mobile.visible && mobile.x > 0 && mobile.x < 358 && mobile.y > 0 && mobile.y < 360, '手机尺寸的坐标必须相对于容器');
    await page.evaluate(() => scrollTo(0, 1200)); await page.waitForTimeout(300);
    const offscreen = await snapshot(); await page.waitForTimeout(300);
    assert.equal((await snapshot()).frames, offscreen.frames, '离屏后 onFrame 不能引入额外循环');
    await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(300);
    assert((await snapshot()).frames > offscreen.frames, '返回视口后回调恢复');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForTimeout(300);
    const reduced = await snapshot(); await page.waitForTimeout(300);
    assert.equal((await snapshot()).frames, reduced.frames, '减少动态模式不应引入常驻气泡刷新');
    await page.evaluate(() => window.characterWorld.resetCamera()); await page.waitForTimeout(150);
    assert((await snapshot()).frames > reduced.frames, '减少动态模式操作相机仍触发一次定位');
    await page.evaluate(() => window.characterWorld.dispose());
    assert.equal(await anchor('hero'), null, '关闭视图后气泡锚点不可用');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: ['两个场景真实点击芽芽', '解锁团团仍可点击', '头顶锚点与场景旋转同步', '桌面与手机容器相对坐标', 'onFrame离屏停帧并恢复', '减少动态按需定位', 'dispose无锚点'], errors }));
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
