const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
const out=path.resolve('design/screenshots');
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1100}});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    const state=()=>page.evaluate(()=>window.__wordIsland.getState());
    const ready=async()=>{await chooseTestProfile(page);await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready);};
    const speech=page.locator('#character-speech');
    const act=async action=>page.locator(`[data-story-action="${action}"]`).click();
    const next=async()=>act('next');
    await page.goto(base);await ready();
    assert.equal(await speech.isVisible(),true,'a first-time child should see the character introduce the island');
    assert.match(await speech.innerText(),/芽芽/);
    const original=JSON.stringify((await state()).realProgress);
    await page.screenshot({path:path.join(out,'story-welcome.png'),fullPage:true});
    await page.locator('[data-story-action="next"]').press('Enter');await page.reload();await ready();
    assert.equal((await state()).guide.intro,1,'refresh resumes the introduction');
    await next();await next();await next();
    assert.equal((await state()).speech.id,'depart');
    assert.equal(JSON.stringify((await state()).realProgress),original,'reading the story must not create any answers or rewards');
    await act('camp');assert.equal((await state()).page,'camp');
    assert.equal((await state()).speech.id,'listen');
    await act('listen');await act('practice');
    assert.equal(await speech.isHidden(),true,'the child can uncover the learning area to practise');
    const finish=async skill=>{
      for(let i=0;i<8&&(await state()).activeWordId;i++) {
        const s=await state();
        if(skill==='listen')await page.locator(`[data-answer="${s.activeWordId}"]`).click();
        else {
          const word=await page.evaluate(async id=>(await import('./src/content.js')).getWord(id).en,s.activeWordId);
          await page.locator('#spell-input').fill(word);await page.locator('#spell-input').press('Enter');
        }
        await page.locator('[data-action="next-question"]').click();
      }
    };
    await finish('listen');assert.equal((await state()).speech.id,'spell');
    await act('spell');await act('practice');
    await page.locator('#spell-input').fill('b');await page.locator('#ask-hero').click();
    assert.equal(await page.locator('#spell-input').inputValue(),'b','asking the character must not rebuild the question or erase typed letters');
    await act('close');await finish('spell');
    assert.equal((await state()).speech.id,'read');
    await act('read');await act('practice');
    // Speaking can be confirmed without microphone permission or a recording.
    await page.locator('[data-action="finish-reading"]').click();
    await page.waitForFunction(()=>window.__wordIsland.getState().speech?.id==='collect');
    assert.equal((await state()).speech.id,'collect');assert.equal((await state()).progress.rewardDates.length,0);
    await act('collect');await page.locator('#reward-continue').click();
    assert.equal((await state()).speech.id,'rest');assert.equal((await state()).progress.rewardDates.length,1);
    await act('finish');await page.reload();await ready();assert(await speech.isHidden());
    const completed=JSON.stringify((await state()).realProgress);
    await page.locator('#story-replay').click();assert.equal((await state()).guide.intro,0);
    await act('skip');await page.reload();await ready();assert(await speech.isHidden());
    assert.equal(JSON.stringify((await state()).realProgress),completed,'replaying and skipping preserve the existing daily work');
    const hero=await page.evaluate(()=>window.__wordIsland.world.getObjectScreenPoint('character.hero'));
    assert(hero?.visible);await page.mouse.click(hero.x,hero.y);assert(await speech.isVisible());
    assert.equal((await state()).speech.actor,'hero');
    await act('close');
    await page.locator('#parent-button').click();await page.locator('#prepare-offline').click();
    await page.waitForFunction(()=>document.querySelector('#offline-detail').textContent.includes('已可离线'));
    await page.locator('[data-close="parent-dialog"]').click();
    await context.setOffline(true);await page.reload();await ready();
    await page.locator('#story-replay').click();assert(await speech.isVisible());
    await context.setOffline(false);assert.deepEqual(errors,[]);await context.close();

    const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    const phone=await mobile.newPage();await phone.goto(base);await chooseTestProfile(phone);await phone.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready);
    const bubble=phone.locator('#character-speech');assert(await bubble.isVisible());
    for(let i=0;i<5;i++) {
      const bounds=await bubble.boundingBox(),frame=await phone.locator('.world-frame').boundingBox();
      assert(bounds.x>=frame.x&&bounds.x+bounds.width<=frame.x+frame.width+1,'speech must stay horizontally inside the phone scene');
      assert(bounds.y>=frame.y&&bounds.y+bounds.height<=frame.y+frame.height-35,'speech must not cover the scene controls');
      if(i<4)await phone.locator('[data-story-action="next"]').tap();
    }
    await phone.screenshot({path:path.join(out,'story-mobile.png'),fullPage:true});
    await phone.locator('[data-story-action="camp"]').tap();await phone.locator('[data-story-action="listen"]').tap();
    await phone.locator('[data-story-action="practice"]').tap();
    assert(await phone.locator('#character-speech').isHidden());
    await phone.locator('#ask-hero').click();assert(await phone.locator('#character-speech').isVisible());
    assert(await phone.evaluate(()=>scrollY<400),'asking the character brings its scene back into view on a phone');
    assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await phone.locator('[data-story-action="close"]').click();
    const realGuide=JSON.stringify((await phone.evaluate(()=>window.__wordIsland.getState())).guide);
    await phone.locator('#demo-toggle').click();
    await phone.locator('#demo-banner [data-action="demo-ending"]').click();
    await phone.locator('#ask-hero').click();await phone.locator('[data-story-action="finish"]').click();
    assert.equal(JSON.stringify((await phone.evaluate(()=>window.__wordIsland.getState())).guide),realGuide,'demo dialogue must not finish the real onboarding');
    await phone.waitForTimeout(100);
    const bunny=await phone.evaluate(()=>window.__wordIsland.world.getObjectScreenPoint('home.bunny'));
    assert(bunny?.visible);
    await phone.touchscreen.tap(bunny.x,bunny.y);
    assert((await phone.evaluate(()=>window.__wordIsland.getState())).speech,'the scene tap must leave the new companion bubble open instead of clicking through to its close button');
    assert.equal((await phone.evaluate(()=>window.__wordIsland.getState())).speech.actor,'bunny');
    assert.match(await phone.locator('#character-speech').innerText(),/团团/);
    await phone.locator('.speech-next[data-story-action="close"]').tap();
    await phone.locator('#demo-banner [data-action="exit-demo"]').click();
    await mobile.close();
    console.log(JSON.stringify({passed:['first-visit character story','intro refresh resume','real task-driven guidance through first clue','optional recording','skip/replay preserve progress','real 3D hero interaction','asking preserves spelling input','offline story replay','390px speech bounds and reduced motion','mobile ask-character scroll','demo dialogue preserves real guide','real 3D companion dialogue'],screenshots:out}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
