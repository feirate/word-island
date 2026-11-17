// Child-facing spelling retries, hints and keyboard continuation in an isolated browser.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
const passed=[];

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
  try {
    for(const name of ['retry','hint','keyboard','isolation']) {
      if(process.env.QA_INPUT_CASE&&name!==process.env.QA_INPUT_CASE)continue;
      const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
      try {
        await context.addInitScript(()=>localStorage.setItem('word-island:guide:v1','{"version":1,"status":"skipped","intro":0}'));
        const page=await context.newPage(),errors=[];
        page.on('pageerror',error=>errors.push(String(error)));
        await page.goto(base);await chooseTestProfile(page,'小明');
        await page.waitForFunction(()=>window.__wordIsland.world.getDiagnostics().ready);
        await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="spell"]').click();
        const state=()=>page.evaluate(()=>window.__wordIsland.getState());
        const input=page.locator('#spell-input');
        await input.waitFor();
        if(name==='retry') {
          await input.fill('com');await input.press('Enter');
          await page.locator('.feedback').filter({hasText:'再试一次'}).waitFor();
          assert.equal(await input.inputValue(),'com','a wrong spelling must remain available to edit');
          assert(await input.evaluate(element=>element===document.activeElement),'Enter retry keeps the typing focus');
          await input.fill('comik');await page.locator('[data-action="check-spell"]').click();
          await page.waitForFunction(()=>{const s=window.__wordIsland.getState();return s.progress.days[s.dateKey]?.answers[s.activeWordId]?.spell?.attempts===2;});
          assert.equal(await input.inputValue(),'comik','tapping check also preserves the child’s draft');
          assert(await input.evaluate(element=>element===document.activeElement),'wrong answer returns to the input');
          await page.screenshot({path:'design/screenshots/qa-spelling-retry.png'});
        } else if(name==='hint') {
          await input.fill('co');await page.locator('[data-action="hint"]').click();
          assert.equal(await input.inputValue(),'co','asking for help must not erase letters already typed');
          assert.equal((await state()).progress.words[(await state()).activeWordId],undefined,'a hint alone must not record an answer');
        } else if(name==='keyboard') {
          const first=(await state()).activeWordId;
          const english=await page.evaluate(async id=>(await import('./src/content.js')).getWord(id).en,first);
          await input.fill(english);await input.press('Enter');
          await page.locator('[data-action="next-question"]').waitFor();
          assert.equal(await input.inputValue(),english,'a correct answer stays visible');
          assert.equal(await page.evaluate(()=>document.activeElement?.dataset.action),'next-question','Enter can continue through the next action');
          await page.keyboard.press('Enter');
          assert.notEqual((await state()).activeWordId,first);
          assert.equal(await input.inputValue(),'','the next word starts with an empty draft');
          assert(await input.evaluate(element=>element===document.activeElement),'the next spelling is ready to type');
        } else {
          await input.fill('privateDraft');await page.locator('[data-action="hint"]').click();
          await page.locator('#user-button').click();await page.locator('#profile-name').fill('Lucy');await page.locator('#create-profile').click();
          await page.locator('#profile-dialog').waitFor({state:'hidden'});
          const skip=page.locator('[data-story-action="skip"]');if(await skip.isVisible())await skip.click();
          await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="spell"]').click();
          assert.equal(await input.inputValue(),'','drafts never cross local users');
          await input.fill('dailyDraft');await page.locator('[data-action="back-task"]').click();
          await page.locator('[data-task="spell"]').click();assert.equal(await input.inputValue(),'','leaving a question discards its transient draft');
        }
        assert.deepEqual(errors,[]);passed.push(name);
      } finally {await context.close();}
    }
    assert(passed.length);console.log(JSON.stringify({passed,url:base}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
