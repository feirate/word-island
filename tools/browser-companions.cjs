const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1150}});
  await context.addInitScript(()=>localStorage.setItem('word-island:guide:v1','{"version":1,"status":"skipped","intro":4}'));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const state=()=>page.evaluate(()=>window.__wordIsland.getState());
  const ready=async()=>{await chooseTestProfile(page);await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready);};
  const previewReady=async id=>page.waitForFunction(id=>{const p=window.__wordIsland.getCompanionDiagnostics();return p?.ready&&p.id===id;},id);
  await page.goto(base);await ready();
  await page.locator('[data-nav="clues"]').first().click();
  assert.equal(await page.locator('[data-companion]').count(),8,'all eight requested animals must be visible in the companion album');
  await previewReady('bunny');
  const before=JSON.stringify((await state()).realProgress);
  for(const id of ['bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox']){
   await page.locator(`[data-companion="${id}"]`).click();await previewReady(id);
   assert.equal((await page.evaluate(()=>window.__wordIsland.getCompanionDiagnostics())).gray,true,'unearned model must render with grey materials');
  }
  assert.equal(JSON.stringify((await state()).realProgress),before,'viewing pets never grants rewards');
  fs.mkdirSync(path.resolve('design/screenshots'),{recursive:true});
  await page.screenshot({path:path.resolve('design/screenshots/companion-album.png'),fullPage:true});
  await page.locator('#parent-button').click();await page.locator('[data-action="demo-all"]').click();
  assert.equal((await state()).demo,true);assert.equal((await state()).progress.companions.length,8);
  assert.equal((await state()).progress.rewardDates.length,56);assert.equal(JSON.stringify((await state()).realProgress),before);
  await page.waitForFunction(()=>['bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox'].every(id=>window.__wordIsland.world.getObjectScreenPoint(`home.${id}`)?.visible));
  await page.waitForTimeout(550);
  await page.screenshot({path:path.resolve('design/screenshots/companions-home-all.png'),fullPage:true});
  for(const id of ['bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox']){
   const target=await page.evaluate(id=>window.__wordIsland.world.getObjectScreenPoint(`home.${id}`),id);
   assert(target?.visible,`${id} must have a visible real mesh in the house`);
   await page.mouse.click(target.x,target.y);assert.equal((await state()).speech?.actor,id);
   await page.locator('.speech-dismiss').click();await page.waitForTimeout(460);
  }
  await page.locator('[data-nav="clues"]').first().click();
  await page.locator('[data-companion="fox"]').click();await previewReady('fox');
  assert.equal((await page.evaluate(()=>window.__wordIsland.getCompanionDiagnostics())).gray,false);
  await page.locator('[data-action="visit-companion"]').click();assert.equal((await state()).page,'home');
  await page.locator('#demo-banner [data-action="exit-demo"]').click();
  assert.equal((await state()).progress.companions.length,0);
  await page.locator('#parent-button').click();await page.locator('#prepare-offline').click();
  await page.waitForFunction(()=>document.querySelector('#offline-detail').textContent.includes('已可离线'));
  await page.locator('[data-close="parent-dialog"]').click();
  await context.setOffline(true);await page.reload();await ready();
  await page.locator('[data-nav="clues"]').first().click();
  await page.locator('[data-companion="turtle"]').click();await previewReady('turtle');
  assert.equal((await page.evaluate(()=>window.__wordIsland.getCompanionDiagnostics())).gray,true);
  await context.setOffline(false);
  for(const width of [390,768]){
   await page.setViewportSize({width,height:1000});
   await page.locator('[data-companion="cat"]').click();await previewReady('cat');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  await page.setViewportSize({width:390,height:1000});
  await page.screenshot({path:path.resolve('design/screenshots/companions-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:['eight real 3D grey previews','viewing preserves progress','56-day independent demo','eight clickable house residents and dialogues','unlocked model returns to original colors','offline all-animal model cache','390/768 layouts'],errors}));
  await context.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
