// The first offline visit must keep profile creation and text learning usable.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const artifact = path.resolve(process.env.ARTIFACT_ROOT || '_site');
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

(async () => {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(artifact, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(`${artifact}${path.sep}`)) { response.writeHead(403); response.end(); return; }
    fs.readFile(file, (error, bytes) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' }); response.end(bytes);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(), errors = [], requests = [];
  page.setDefaultTimeout(5000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  try {
    await page.goto(base);
    await page.locator('#profile-dialog[open]').waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', null, { timeout: 15000 });
    assert(!requests.some(url => url.endsWith('.glb')), 'opening profile selection must not prepare 3D models');
    await context.setOffline(true);
    await page.locator('#profile-name').fill('离线学习');
    await page.locator('#create-profile').click();
    await page.waitForFunction(() => Boolean(window.__wordIsland?.getState().activeProfile), null, { timeout: 3500 });
    assert.equal(await page.locator('#profile-dialog').isVisible(), false);
    await page.locator('[data-nav="camp"]').first().click();
    await page.locator('#notebook-content [data-task="listen"]').click();
    await page.locator('[data-answer]').first().waitFor();
    assert.equal(await page.evaluate(() => window.__wordIsland.getState().phase), 'listen');
    await page.locator('[data-nav="camp"]').first().click();
    await page.locator('#notebook-content [data-task="spell"]').click();
    await page.locator('#spell-input').fill('test');
    assert.equal(await page.locator('#spell-input').inputValue(), 'test');
    assert.equal(await page.evaluate(() => window.__wordIsland.getState().phase), 'spell');
    assert.equal(await page.evaluate(() => window.__wordIsland.getDiagnostics().ready), false, 'unprepared 3D is allowed to fail without blocking core learning');
    assert.deepEqual(errors, []);
    const result = { passed: ['install core shell before selecting a name', 'create first profile entirely offline', 'listen text choices with unavailable 3D', 'offline spelling input'], artifact, errors };
    fs.writeFileSync('/private/tmp/word-island-core-offline-report.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, profileError: await page.locator('#profile-error').textContent(), requests, errors }));
    throw error;
  } finally { await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
