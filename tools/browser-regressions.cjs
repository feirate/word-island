const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173';
const passed = [];

async function runCase(browser, name, exercise, initScript) {
  if (process.env.REGRESSION_CASE && !name.includes(process.env.REGRESSION_CASE)) return;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Shanghai',
    permissions: ['microphone'], reducedMotion: 'reduce',
  });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const state = () => page.evaluate(() => window.__wordIsland.getState());
  try {
    await page.goto(base);
    await page.waitForFunction(() => window.__wordIsland?.world.getDiagnostics().ready, { timeout: 30000 });
    await page.locator('#world-loading').waitFor({ state: 'hidden' });
    await exercise({ context, page, state });
    assert.deepEqual(errors, [], `${name}: unexpected browser exception`);
    passed.push(name);
    console.log(`PASS ${name}`);
  } finally {
    await page.evaluate(() => {
      window.__regressionMic?.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    }).catch(() => {});
    await context.close();
  }
}

async function finishSkill(page, state, skill) {
  await page.locator(`[data-task="${skill}"]`).first().click();
  let count = 0;
  while ((await state()).activeWordId) {
    assert(count < 20, 'daily word loop must finish');
    const id = (await state()).activeWordId;
    if (skill === 'listen') await page.locator(`[data-answer="${id}"]`).click();
    else {
      await page.locator('#spell-input').fill(id);
      await page.locator('#spell-input').press('Enter');
    }
    await page.locator('[data-action="next-question"]').click();
    count += 1;
  }
  assert(count > 0, `${skill} must exercise actual UI answers`);
  return count;
}

const controlledMicrophone = () => {
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const pending = [];
  window.__regressionMic = {
    calls: 0, streams: [],
    async resolve() {
      // Chromium is launched with fake device/UI flags; this never opens a real microphone.
      const stream = await nativeGetUserMedia({ audio: true, video: false });
      this.streams.push(stream);
      pending.shift()(stream);
    },
  };
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
    configurable: true,
    value() {
      window.__regressionMic.calls += 1;
      return new Promise(resolve => pending.push(resolve));
    },
  });
};

const controlledDate = () => {
  const NativeDate = Date;
  let now = NativeDate.parse('2026-11-14T23:59:00+08:00');
  class RegressionDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  window.Date = RegressionDate;
  window.__setRegressionNow = value => { now = NativeDate.parse(value); };
};

const observeAudio = () => {
  const NativeAudio = window.Audio;
  window.Audio = function (...args) {
    const audio = new NativeAudio(...args);
    window.__regressionAudio = audio;
    return audio;
  };
  window.Audio.prototype = NativeAudio.prototype;
};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  try {
    await runCase(browser, 'eighth demo day completes without another clue or real-progress changes', async ({ page, state }) => {
      const realBefore = JSON.stringify((await state()).realProgress);
      const storedBefore = await page.evaluate(() => ({
        progress: localStorage.getItem('word-island:progress:v1'),
        reading: localStorage.getItem('word-island:reading:v1'),
      }));
      await page.locator('#demo-toggle').click();
      await page.locator('#demo-banner [data-action="demo-ending"]').click();
      assert.equal((await state()).progress.rewardDates.length, 7);
      assert.deepEqual((await state()).progress.companions, ['bunny']);
      await page.locator('[data-action="demo-next"]').click();
      assert.equal((await state()).dateKey, '2026-01-08');
      const listening = await finishSkill(page, state, 'listen');
      const spelling = await finishSkill(page, state, 'spell');
      assert.equal(listening, spelling);
      await page.locator('[data-task="read"]').click();
      await page.locator('[data-action="finish-reading"]').click();
      await page.locator('[data-action="collect"]').click();
      const after = await state();
      assert.equal(after.progress.days['2026-01-08'].completed, true);
      assert.equal(after.progress.rewardDates.length, 7);
      assert.equal(Object.values(after.progress.days).filter(day => day.completed).length, 8);
      assert.equal(JSON.stringify(after.realProgress), realBefore);
      assert.deepEqual(await page.evaluate(() => ({
        progress: localStorage.getItem('word-island:progress:v1'),
        reading: localStorage.getItem('word-island:reading:v1'),
      })), storedBefore);
    });

    await runCase(browser, 'pending microphone permission blocks duplicate requests and context switches', async ({ page, state }) => {
      await page.locator('[data-nav="camp"]').first().click();
      await page.locator('[data-task="read"]').click();
      const phraseBefore = await page.locator('.phrase-card .english').textContent();
      await page.locator('[data-action="record"]').click();
      assert.equal(await page.evaluate(() => window.__regressionMic.calls), 1);
      assert.equal(await page.locator('#record-button').isDisabled(), true);
      await page.locator('[data-phrase="1"]').click();
      assert.equal(await page.locator('.phrase-card .english').textContent(), phraseBefore);
      await page.locator('[data-nav="home"]').first().click();
      assert.equal((await state()).phase, 'read');
      assert.equal((await state()).page, 'camp');
      await page.locator('#demo-toggle').click();
      assert.equal((await state()).demo, false);
      await page.evaluate(() => document.querySelector('#record-button').click());
      assert.equal(await page.evaluate(() => window.__regressionMic.calls), 1);
      await page.evaluate(() => window.__regressionMic.resolve());
      await page.waitForFunction(() => document.querySelector('#record-button')?.textContent.includes('结束录音'));
      await page.waitForTimeout(400);
      await page.locator('[data-action="record"]').click();
      await page.locator('#recording-playback').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => window.__regressionMic.calls), 1);
      assert.equal(await page.evaluate(() => window.__regressionMic.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
    }, controlledMicrophone);

    await runCase(browser, 'foreground midnight refresh discards stale question and records the new day', async ({ page, state }) => {
      assert.equal((await state()).dateKey, '2026-11-14');
      await page.locator('[data-nav="camp"]').first().click();
      await page.locator('[data-task="listen"]').click();
      const first = (await state()).activeWordId;
      await page.locator(`[data-answer="${first}"]`).click();
      await page.locator('[data-action="next-question"]').click();
      const oldDay = structuredClone((await state()).progress.days['2026-11-14']);
      const staleId = (await state()).activeWordId;
      await page.evaluate(() => window.__setRegressionNow('2026-11-15T00:01:00+08:00'));
      await page.locator(`[data-answer="${staleId}"]`).click();
      assert.equal((await state()).dateKey, '2026-11-15');
      assert.equal((await state()).phase, 'overview');
      assert.deepEqual((await state()).progress.days['2026-11-14'], oldDay);
      assert.equal((await state()).progress.days['2026-11-15'], undefined);
      await page.locator('[data-task="listen"]').click();
      const next = (await state()).activeWordId;
      await page.locator(`[data-answer="${next}"]`).click();
      assert.equal((await state()).progress.days['2026-11-15'].answers[next].listen.completed, true);
      assert.deepEqual((await state()).progress.days['2026-11-14'], oldDay);
    }, controlledDate);

    await runCase(browser, 'bundled British demonstration audio plays online and after offline reload', async ({ context, page, state }) => {
      const failedAudio = [];
      page.on('requestfailed', request => {
        if (request.url().includes('/assets/audio/')) failedAudio.push({ url: request.url(), failure: request.failure()?.errorText });
      });
      const play = async () => {
        await page.locator('[data-nav="camp"]').first().click();
        await page.locator('[data-task="listen"]').click();
        const id = (await state()).activeWordId;
        await page.locator('[data-action="play-word"]').click();
        try {
          await page.waitForFunction(() => document.querySelector('#audio-source')?.textContent.includes('合成音，非教材原音'));
          await page.waitForFunction(() => window.__regressionAudio?.currentTime > 0.01);
        } catch (error) {
          const details = await page.evaluate(() => ({
            source: document.querySelector('#audio-source')?.textContent,
            audioError: window.__regressionAudio?.error?.code,
            readyState: window.__regressionAudio?.readyState,
            networkState: window.__regressionAudio?.networkState,
          }));
          throw new Error(`Actual audio playback failed: ${JSON.stringify({ ...details, failedAudio })}; ${error.message}`);
        }
        return id;
      };
      const onlineWord = await play();
      await page.locator(`[data-answer="${onlineWord}"]`).click();
      await page.locator('[data-action="next-question"]').click();
      const offlineWord = (await state()).activeWordId;
      assert.notEqual(offlineWord, onlineWord, 'offline case must play a previously unheard asset');
      await page.locator('#parent-button').click();
      await page.locator('#prepare-offline').click();
      await page.waitForFunction(() => document.querySelector('#offline-detail')?.textContent.includes('已可离线'), { timeout: 30000 });
      await page.locator('[data-close="parent-dialog"]').click();
      await context.setOffline(true);
      await page.reload();
      await page.waitForFunction(() => window.__wordIsland?.world.getDiagnostics().ready, { timeout: 30000 });
      assert.equal(await play(), offlineWord);
    }, observeAudio);
    assert(passed.length > 0, 'REGRESSION_CASE must match at least one scenario');
    console.log(JSON.stringify({ passed, fakeMicrophoneOnly: true, url: base }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
