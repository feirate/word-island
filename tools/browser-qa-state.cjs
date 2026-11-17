const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const results=[];
  const run=async(name,exercise)=>{
    const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['microphone'],serviceWorkers:'block'});
    try{
      const page=await context.newPage();page.setDefaultTimeout(12000);
      const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(String(e))));page.on('pageerror',e=>errors.push(String(e)));
      await page.goto(base);await chooseTestProfile(page,'测试');
      const skip=page.locator('[data-story-action="skip"]');if(await skip.isVisible())await skip.click();
      await exercise({context,page,state:()=>page.evaluate(()=>window.__wordIsland.getState())});
      assert.deepEqual(errors,[]);results.push({name,status:'PASS'});
    }catch(error){results.push({name,status:'FAIL',error:error.message});process.exitCode=1;}
    finally{await context.close();}
  };
  try{
    await run('same local learner keeps answers from both tabs',async({context,page,state})=>{
      const other=await context.newPage();other.setDefaultTimeout(12000);
      await other.goto(base);await chooseTestProfile(other);
      await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="listen"]').click();
      await other.locator('[data-nav="camp"]').first().click();await other.locator('[data-task="spell"]').click();
      await page.locator('[data-answer]').first().waitFor();await other.locator('#spell-input').waitFor();
      const word=(await state()).activeWordId;
      await page.locator(`[data-answer="${word}"]`).click();
      await page.locator('.feedback').filter({hasText:'找到了'}).waitFor();
      const otherWord=await other.evaluate(()=>window.__wordIsland.getState().activeWordId);
      const english=await other.evaluate(async id=>(await import('./src/content.js')).getWord(id).en,otherWord);
      await other.locator('#spell-input').fill(english);await other.locator('#spell-input').press('Enter');
      await other.locator('.feedback').filter({hasText:'找到了'}).waitFor();
      const stored=await other.evaluate(async()=>{const s=window.__wordIsland.getState();return (await import('./src/storage.js')).loadProgress(s.activeProfile.id).progress;});
      console.log(JSON.stringify({case:'two-tab-answer-evidence',firstWord:word,secondWord:otherWord,storedAnswers:stored.days[(await state()).dateKey]?.answers}));
      assert.equal(stored.days[(await state()).dateKey]?.answers[word]?.listen?.completed,true,'the first tab’s saved listening answer was overwritten by the second tab');
      assert.equal(stored.days[(await state()).dateKey]?.answers[otherWord]?.spell?.completed,true);
    });
    await run('same local learner keeps free-reading completion from both tabs',async({context,page,state})=>{
      const other=await context.newPage();other.setDefaultTimeout(12000);
      await other.goto(base);await chooseTestProfile(other);
      await page.locator('[data-action="open-books"]').first().click();await page.locator('[data-reading-unit="kb3-hello"]').click();
      await other.locator('[data-action="open-books"]').first().click();await other.locator('[data-unit="kb3-u1"]').click();
      await other.locator('[data-reading-unit="kb3-u1"]').click();
      await page.locator('[data-action="finish-reading"]').click();await page.waitForFunction(()=>window.__wordIsland.getState().phase!=='read');
      await other.locator('[data-action="finish-reading"]').click();await other.waitForFunction(()=>window.__wordIsland.getState().phase!=='read');
      const flags=await other.evaluate(async()=>{const s=window.__wordIsland.getState(),m=await import('./src/profiles.js');return JSON.parse(localStorage.getItem(m.profileStorageKey(s.activeProfile.id,'reading'))||'[]');});
      const date=(await state()).dateKey;
      console.log(JSON.stringify({case:'two-tab-reading-evidence',storedReading:flags}));
      assert(flags.includes(`${date}:kb3-hello`),'the first tab’s completed free reading was overwritten by the second tab');
      assert(flags.includes(`${date}:kb3-u1`));
    });
    await run('deleting a learner during a queued answer returns the old tab to user selection',async({context,page,state})=>{
      const owner=(await state()).activeProfile.id;
      const other=await context.newPage();other.setDefaultTimeout(12000);await other.goto(base);await chooseTestProfile(other);
      await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="listen"]').click();
      await page.locator('[data-answer]').first().waitFor();
      const word=(await state()).activeWordId;
      await page.evaluate(async()=>{
        const m=await import('./src/profiles.js');
        window.__qaHeld=m.withProfileStorageLock(()=>new Promise(resolve=>{window.__qaUnlock=resolve;}));
      });
      await page.waitForFunction(()=>typeof window.__qaUnlock==='function');
      await other.locator('#user-button').click();await other.locator(`[data-profile-delete="${owner}"]`).click();await other.locator('#confirm-delete-profile').click();
      await page.waitForFunction(async()=>(await navigator.locks.query()).pending.length>0);
      await page.locator(`[data-answer="${word}"]`).click();
      await page.evaluate(()=>window.__qaUnlock());
      await page.waitForFunction(()=>window.__wordIsland.getState().activeProfile===null);
      await page.locator('#profile-dialog').waitFor({state:'visible',timeout:7000});
      const after=await page.evaluate(owner=>({picker:document.querySelector('#profile-dialog').open,orphanKeys:Object.keys(localStorage).filter(key=>key.includes(owner)),toast:document.querySelector('#toast').textContent}),owner);
      console.log(JSON.stringify({case:'queued-delete-evidence',...after}));
      assert.equal(after.picker,true,'a deleted learner must be returned to user selection even while an answer was saving');
      assert.deepEqual(after.orphanKeys,[],'a queued answer must never recreate the deleted user’s data');
    });
    console.log(JSON.stringify({results,fakeMicrophoneOnly:true,url:base}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
