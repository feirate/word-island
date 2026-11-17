const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173';
const out = path.resolve('design/screenshots');
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['microphone'],acceptDownloads:true});
  // First-visit story and its overlays are exercised separately in browser-story.cjs.
  await context.addInitScript(()=>localStorage.setItem('word-island:guide:v1','{"version":1,"status":"skipped","intro":0}'));
  const page=await context.newPage();
  const errors=[];const failures=[];
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('response',response=>{if(response.status()>=400)failures.push({url:response.url(),status:response.status()});});
  const state=()=>page.evaluate(()=>window.__wordIsland.getState());
  const ready=async()=>{await chooseTestProfile(page);await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready,{timeout:30000});await page.locator('#world-loading').waitFor({state:'hidden'});};
  const pick=async id=>{
    const point=await page.evaluate(id=>window.__wordIsland.world.getObjectScreenPoint(id),id);
    assert(point?.visible,`${id} must be visible and actually hit`);
    await page.waitForTimeout(500);
    await page.mouse.click(point.x,point.y);
  };
  try{
    await page.goto(base);await ready();
    assert.deepEqual((await page.evaluate(()=>window.__wordIsland.getDiagnostics())).models,['home','camp','hero','child','bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox']);
    await page.screenshot({path:path.join(out,'app-home.png'),fullPage:true});
    await pick('home.bookshelf');assert.equal((await state()).phase,'books');
    await page.locator('[data-nav="home"]').first().click();
    await pick('home.door');assert.equal((await state()).page,'camp');
    await page.screenshot({path:path.join(out,'app-camp.png'),fullPage:true});
    await pick('camp.chest');assert.equal((await state()).progress.rewardDates.length,0);
    await pick('camp.crate');await page.waitForFunction(()=>window.__wordIsland.getState().phase==='listen');assert.equal((await state()).phase,'listen');
    for(let n=0;n<3;n++){
      const id=(await state()).activeWordId;
      if(n===0){
        const wrong=await page.locator(`[data-answer]:not([data-answer="${id}"])`).first().getAttribute('data-answer');
        await page.locator(`[data-answer="${wrong}"]`).click();
        await page.locator('.feedback.error').waitFor({state:'visible'});
        assert.equal((await state()).progress.days[(await state()).dateKey].answers[id].listen.completed,false);
      }
      await page.locator(`[data-answer="${id}"]`).click();
      await page.locator('[data-action="next-question"]').click();
    }
    await page.locator('[data-task="spell"]').click();await page.locator('#spell-input').waitFor({state:'visible'});
    for(let n=0;n<3;n++){
      const id=(await state()).activeWordId;
      if(n===0){await page.locator('#spell-input').fill('wrong');await page.locator('[data-action="check-spell"]').click();await page.locator('.feedback.error').waitFor({state:'visible'});}
      const english=await page.evaluate(async id=>(await import('./src/content.js')).getWord(id).en,id);
      await page.locator('#spell-input').fill(english);await page.locator('#spell-input').press('Enter');
      await page.waitForFunction(()=>document.querySelector('.feedback')?.textContent.includes('找到了'));
      assert((await page.locator('.feedback').textContent()).includes('找到了'));
      await page.locator('[data-action="next-question"]').click();
    }
    await page.locator('[data-task="read"]').click();
    await page.locator('[data-action="record"]').click();
    await page.waitForFunction(()=>document.querySelector('#record-button')?.textContent.includes('结束录音'));
    await page.waitForTimeout(700);await page.locator('[data-action="record"]').click();
    await page.locator('#recording-playback').waitFor({state:'visible'});
    const clip=await page.evaluate(async()=>{const m=await import('./src/storage.js');const s=window.__wordIsland.getState();const blob=await m.getClip('recording:'+s.dateKey+':'+s.phraseId,s.activeProfile.id);return {size:blob.size,type:blob.type};});
    assert(clip.size>0&&clip.type.startsWith('audio/'));
    await page.screenshot({path:path.join(out,'app-reading.png'),fullPage:true});
    await page.locator('[data-action="finish-reading"]').click();
    await page.locator('[data-action="collect"]').click();
    await page.locator('#reward-dialog').waitFor({state:'visible'});
    assert.equal((await state()).progress.rewardDates.length,1);
    await page.locator('#reward-continue').click();
    const realBefore=JSON.stringify((await state()).realProgress);
    await page.reload();await ready();assert.equal((await state()).progress.rewardDates.length,1);
    await page.locator('#demo-toggle').click();
    assert.equal((await state()).demo,true);
    await page.locator('#demo-banner [data-action="demo-ending"]').click();
    assert.equal((await state()).progress.rewardDates.length,7);
    assert.deepEqual((await state()).progress.companions,['bunny']);
    assert.equal(JSON.stringify((await state()).realProgress),realBefore);
    await page.waitForTimeout(700);
    await page.screenshot({path:path.join(out,'app-companion.png'),fullPage:true});
    await page.locator('[data-action="exit-demo"]').click();
    assert.equal((await state()).progress.rewardDates.length,1);
    await page.locator('#parent-button').click();
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export-progress').click()]);
    const file=await download.path();const envelope=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(envelope.app,'word-island');assert.equal(envelope.progress.rewardDates.length,1);
    await page.locator('#import-progress').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(envelope))});
    await page.locator('#import-dialog').waitFor({state:'visible'});await page.locator('#confirm-import').click();
    assert.equal((await state()).progress.rewardDates.length,1);
    const audioRoundTrip=await page.evaluate(async()=>{const m=await import('./src/storage.js');const clip=new Blob([new Uint8Array([82,73,70,70,0,0,0,0])],{type:'audio/wav'});await m.putClip('word:test-audio',clip);const result=await m.getClip('word:test-audio');return result.size;});
    assert.equal(audioRoundTrip,8);
    await page.locator('#parent-button').click();await page.locator('#prepare-offline').click();
    await page.waitForFunction(()=>document.querySelector('#offline-detail').textContent.includes('已可离线'),{timeout:30000});
    await page.locator('[data-close="parent-dialog"]').click();
    await context.setOffline(true);await page.reload();await ready();
    assert.equal((await state()).progress.rewardDates.length,1);
    await context.setOffline(false);
    for(const width of [390,768]){
      await page.setViewportSize({width,height:1000});
      for(const view of ['home','camp','clues','growth']){
        await page.locator(`[data-nav="${view}"]`).first().click();
        const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
        assert(sizes.scroll<=sizes.width+1,`${view} overflows at ${width}`);
      }
      await page.locator('[data-nav="home"]').first().click();await page.waitForTimeout(300);
      await page.screenshot({path:path.join(out,`app-${width}.png`),fullPage:true});
    }
    const diagnostics=await page.evaluate(()=>window.__wordIsland.getDiagnostics());
    assert.deepEqual(errors,[]);assert.deepEqual(failures,[]);
    console.log(JSON.stringify({passed:['twelve real GLBs including child, guide and eight companions','real 3D click targets','incomplete tasks cannot earn clue','listen retry','spelling retry and Enter','mock microphone recording and IndexedDB playback','daily reward persistence','demo isolation and seven-clue companion','JSON export and reviewed import','IndexedDB successful write/read','all models reload offline','390/768px four-page layouts'],diagnostics,screenshots:out}));
  }finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
