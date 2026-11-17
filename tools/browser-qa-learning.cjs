const { chromium }=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const { chooseTestProfile }=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
const results=[];

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
 try {
  async function run(name,exercise){
   const context=await browser.newContext({viewport:{width:1440,height:1100},timezoneId:'Asia/Shanghai'});
   const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(String(error)));
   const state=()=>page.evaluate(()=>window.__wordIsland.getState());
   try{
    await page.goto(base);await chooseTestProfile(page,'小乐');
    await page.waitForFunction(()=>window.__wordIsland.world.getDiagnostics().ready);
    const skip=page.locator('[data-story-action="skip"]');if(await skip.isVisible())await skip.click();
    await exercise({context,page,state});assert.deepEqual(errors,[]);results.push({name,status:'PASS'});
   }catch(error){results.push({name,status:'FAIL',error:String(error)});}
   finally {await context.close();}
  }
  const finish=async(page,state,skill)=>{
   await page.locator(`#notebook-content [data-task="${skill}"]`).first().click();
   await page.waitForFunction(skill=>{const s=window.__wordIsland.getState();return s.phase===skill&&Boolean(s.activeWordId);},skill);
   for(let count=0;count<10&&(await state()).activeWordId;count++){
    const id=(await state()).activeWordId;
    if(skill==='listen')await page.locator(`[data-answer="${id}"]`).click();
    else {const en=await page.evaluate(async id=>(await import('./src/content.js')).getWord(id).en,id);await page.locator('#spell-input').fill(en);await page.locator('#spell-input').press('Enter');}
    await page.locator('[data-action="next-question"]').click();
   }
   assert.equal((await state()).activeWordId,null);
  };
  await run('free word practice does not freeze an unstarted daily unit',async({page,state})=>{
   await page.locator('[data-action="open-books"]').first().click();
   const selected=(await state()).progress.selectedUnitId;
   const free=page.locator('[data-free-word]').last();const id=await free.getAttribute('data-free-word');await free.click();
   await page.locator(`[data-answer="${id}"]`).click();await page.locator('[data-action="next-question"]').click();
   const en=await page.evaluate(async id=>(await import('./src/content.js')).getWord(id).en,id);await page.locator('#spell-input').fill(en);await page.locator('#spell-input').press('Enter');await page.locator('[data-action="next-question"]').click();
   const other=page.locator(`[data-unit]:not([data-unit="${selected}"])`).first();const unit=await other.getAttribute('data-unit');await other.click();
   await page.waitForFunction(unit=>window.__wordIsland.getState().progress.selectedUnitId===unit,unit);await page.locator('[data-action="start-unit"]').click();
   const s=await state();assert.equal(s.plan.unitId,unit,JSON.stringify({requested:unit,selected:s.progress.selectedUnitId,plan:s.plan.unitId,days:Object.keys(s.progress.days)}));
  });
  await run('IME Enter confirms composition without submitting a spelling answer',async({page,state})=>{
   await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="spell"]').click();
   await page.waitForFunction(()=>{const s=window.__wordIsland.getState();return s.phase==='spell'&&Boolean(s.activeWordId);});
   const id=(await state()).activeWordId;await page.locator('#spell-input').fill('b');
   await page.locator('#spell-input').dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
   assert.equal((await state()).progress.days[(await state()).dateKey].answers[id],undefined,'confirming an IME candidate must not become a wrong attempt');
   assert.equal(await page.locator('#spell-input').inputValue(),'b');
  });
  await run('read-first and spell-before-listen can complete one daily reward',async({page,state})=>{
   await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="read"]').click();
   await page.waitForFunction(()=>window.__wordIsland.getState().phase==='read');await page.locator('[data-action="finish-reading"]').click();
   await page.waitForFunction(()=>{const s=window.__wordIsland.getState();return s.phase==='overview'&&s.readingDone;});
   assert.equal((await state()).readingDone,true);
   await finish(page,state,'spell');await page.locator('[data-action="back-task"]').first().click();
   await finish(page,state,'listen');
   const nextStep=page.locator('#notebook-content .button.primary').first();
   assert.equal(await nextStep.getAttribute('data-action'),'collect','when reading and spelling are already done, the main next step must collect the clue instead of repeating spelling');
   await nextStep.click();await page.locator('#reward-dialog').waitFor({state:'visible'});assert.equal((await state()).progress.rewardDates.length,1);await page.locator('#reward-continue').click();
   await page.reload();await chooseTestProfile(page);await page.waitForFunction(()=>window.__wordIsland.world.getDiagnostics().ready);
   assert.equal((await state()).progress.rewardDates.length,1);await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-action="collect"]').click();assert.equal((await state()).progress.rewardDates.length,1);
  });
  await run('daily plan remains stable after a deliberate daily task starts',async({page,state})=>{
   await page.locator('[data-nav="camp"]').first().click();await page.locator('#notebook-content [data-task="listen"]').click();
   await page.waitForFunction(()=>{const s=window.__wordIsland.getState();return s.phase==='listen'&&Boolean(s.activeWordId);});const original=(await state()).plan;
   await page.locator('[data-action="back-task"]').click();await page.locator('[data-action="open-books"]').first().click();
   const other=page.locator(`[data-unit]:not([data-unit="${original.unitId}"])`).first();const unit=await other.getAttribute('data-unit');await other.click();
   await page.waitForFunction(unit=>window.__wordIsland.getState().progress.selectedUnitId===unit,unit);await page.locator('[data-action="start-unit"]').click();
   await page.waitForFunction(()=>window.__wordIsland.getState().page==='camp');
   assert.deepEqual((await state()).plan,original);assert(await page.locator('.plan-note').isVisible());
  });
 }finally{await browser.close();}
 console.log(JSON.stringify({results},null,2));if(results.some(result=>result.status==='FAIL'))process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
