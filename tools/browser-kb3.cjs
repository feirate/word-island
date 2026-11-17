const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
const output=path.resolve('design/screenshots');
fs.mkdirSync(output,{recursive:true});

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['microphone'],timezoneId:'Asia/Shanghai'});
    await context.addInitScript(()=>localStorage.setItem('word-island:guide:v1','{"version":1,"status":"skipped","intro":0}'));
    await context.addInitScript(()=>{const Original=window.Audio;window.Audio=function(...args){const audio=new Original(...args);window.__lastTestAudio=audio;return audio;};window.Audio.prototype=Original.prototype;});
    const page=await context.newPage();const errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    const state=()=>page.evaluate(()=>window.__wordIsland.getState());
    const ready=async()=>{await chooseTestProfile(page);await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready,{timeout:30000});await page.locator('#world-loading').waitFor({state:'hidden'});};
    const openBooks=async()=>{await page.locator('[data-nav="home"]').first().click();await page.locator('[data-action="open-books"]').first().click();};
    const chooseUnit=async(id,target=page)=>{
      const button=target.locator(`[data-unit="${id}"]`);
      if(await target.evaluate(id=>window.__wordIsland.getState().progress.selectedUnitId!==id,id))await button.click();
      await target.waitForFunction(id=>window.__wordIsland.getState().progress.selectedUnitId===id&&document.querySelector(`[data-unit="${id}"]`)?.getAttribute('aria-pressed')==='true',id);
    };
    const playPhrase=async()=>{await page.locator('[data-action="play-phrase"]').click();await page.waitForFunction(()=>document.querySelector('#audio-source').textContent.includes('合成音'));await page.waitForFunction(()=>window.__lastTestAudio?.currentTime>0.01);};
    const finishSkill=async skill=>{
      await page.locator(`[data-task="${skill}"]`).first().click();
      await page.waitForFunction(skill=>{const s=window.__wordIsland.getState();return s.phase===skill&&Boolean(s.activeWordId);},skill);
      for(let n=0;n<8&&(await state()).activeWordId;n++){
        const id=(await state()).activeWordId;
        if(skill==='listen')await page.locator(`[data-answer="${id}"]`).click();
        else{const english=await page.evaluate(async id=>(await import('./src/content.js')).getWord(id).en,id);await page.locator('#spell-input').fill(english);await page.locator('#spell-input').press('Enter');}
        await page.locator('[data-action="next-question"]').click();
      }
      assert.equal((await state()).activeWordId,null);
    };
    await page.goto(base);await ready();
    assert.equal((await state()).progress.selectedUnitId,'kb3-hello');
    assert.equal((await state()).plan.unitId,'kb3-hello');
    await page.screenshot({path:path.join(output,'kb3-home.png'),fullPage:true});
    await openBooks();assert.equal(await page.locator('[data-unit]').count(),9);
    await page.screenshot({path:path.join(output,'kb3-books.png'),fullPage:true});
    await page.locator('#book-select').selectOption('kb2');
    await page.locator('[data-reading-unit="kb2-u6"]').click();
    await page.locator('[data-action="back-task"]').click();
    assert.equal(await page.locator('#book-select').inputValue(),'kb2','returning from a preview must retain the browsed book');
    assert.equal((await state()).progress.selectedUnitId,'kb3-hello','previewing a different book must not select its unit');
    await page.locator('#book-select').selectOption('kb3');
    for(const id of ['kb3-hello',...Array.from({length:8},(_,i)=>`kb3-u${i+1}`)]){
      await chooseUnit(id);
      assert.equal((await state()).progress.selectedUnitId,id);
      assert.equal((await state()).plan.unitId,id);
      await page.locator(`[data-reading-unit="${id}"]`).click();
      assert.equal((await state()).readingUnitId,id);
      assert((await state()).phraseId.startsWith(id));await playPhrase();
      await page.locator('[data-action="back-task"]').click();
    }
    await chooseUnit('kb3-u3');
    const compound=await page.evaluate(async()=>{const c=await import('./src/content.js');return c.getWordsForUnit('kb3-u3').find(word=>word.en.includes(' '));});
    assert(compound,'daily routines should include a genuine multiword vocabulary item');
    await page.locator(`[data-free-word="${compound.id}"]`).click();
    await page.locator(`[data-answer="${compound.id}"]`).click();await page.locator('[data-action="next-question"]').click();
    await page.locator('#spell-input').fill(compound.en.toUpperCase());await page.locator('#spell-input').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.feedback')?.textContent.includes('找到了'));
    assert((await page.locator('.feedback').textContent()).includes('找到了'));
    await page.locator('[data-action="next-question"]').click();
    assert.equal((await state()).plan.unitId,'kb3-u3');
    assert.equal((await state()).progress.days[(await state()).dateKey],undefined,'optional word practice must not start today’s adventure');
    // Start the actual daily task before checking that a later shelf choice cannot replace it.
    await page.locator('[data-action="start-unit"]').click();await page.waitForFunction(()=>window.__wordIsland.getState().page==='camp');
    await page.locator('[data-task="listen"]').click();
    await page.waitForFunction(()=>{const s=window.__wordIsland.getState();return s.phase==='listen'&&Boolean(s.activeWordId);});
    await openBooks();await chooseUnit('kb3-u4');
    assert.equal((await state()).progress.selectedUnitId,'kb3-u4');assert.equal((await state()).plan.unitId,'kb3-u3');
    await page.locator('[data-nav="camp"]').first().click();await finishSkill('listen');await finishSkill('spell');
    await openBooks();await page.locator('[data-reading-unit="kb3-u4"]').click();
    await page.locator('[data-action="finish-reading"]').click();await page.waitForFunction(()=>window.__wordIsland.getState().phase==='books');assert.equal((await state()).readingDone,false,'another unit cannot complete today’s reading');
    await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-action="collect"]').click();
    await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('先完成木箱'));
    assert.equal((await state()).progress.rewardDates.length,0);
    await page.locator('[data-task="read"]').click();await page.waitForFunction(()=>window.__wordIsland.getState().phase==='read');assert.equal((await state()).readingUnitId,'kb3-u3');
    const recorded=[];
    for(const index of [0,1]){
      await page.locator(`[data-phrase="${index}"]`).click();const phrase=(await state()).phraseId;recorded.push(phrase);
      if(index===1)assert(await page.locator('#recording-playback').isHidden(),'a new sentence must not show the previous sentence’s recording');
      await page.locator('[data-action="record"]').click();
      await page.waitForFunction(()=>document.querySelector('#record-button').textContent.includes('结束录音'));
      await page.waitForTimeout(450);await page.locator('[data-action="record"]').click();
      await page.locator('#recording-playback').waitFor({state:'visible'});
    }
    assert.notEqual(recorded[0],recorded[1]);
    assert.deepEqual(await page.evaluate(async ids=>{const s=window.__wordIsland.getState();const m=await import('./src/storage.js');return Promise.all(ids.map(async id=>Boolean((await m.getClip(`recording:${s.dateKey}:${id}`,s.activeProfile.id))?.size)));},recorded),[true,true]);
    await page.locator('[data-action="finish-reading"]').click();await page.waitForFunction(()=>{const s=window.__wordIsland.getState();return s.phase==='overview'&&s.readingDone;});await page.locator('[data-action="collect"]').click();
    await page.locator('#reward-dialog').waitFor({state:'visible'});
    await page.locator('#reward-continue').click();assert.equal((await state()).progress.rewardDates.length,1);
    await page.locator('#parent-button').click();await page.locator('#prepare-offline').click();
    await page.waitForFunction(()=>document.querySelector('#offline-detail').textContent.includes('已可离线'),{timeout:45000});
    await page.locator('[data-close="parent-dialog"]').click();
    await context.setOffline(true);await page.reload();await ready();
    assert.equal((await state()).progress.selectedUnitId,'kb3-u4');assert.equal((await state()).plan.unitId,'kb3-u3');
    await openBooks();await chooseUnit('kb3-u8');await page.locator('[data-reading-unit="kb3-u8"]').click();await playPhrase();
    await context.setOffline(false);
    await page.setViewportSize({width:390,height:900});
    await page.locator('[data-nav="home"]').first().click();await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(500);
    const point=await page.evaluate(()=>window.__wordIsland.world.getObjectScreenPoint('home.bookshelf'));
    assert(point.visible);await page.mouse.click(point.x,point.y);
    await page.waitForTimeout(600);
    assert.equal((await state()).phase,'books');
    const top=await page.locator('.notebook').evaluate(element=>element.getBoundingClientRect().top);
    assert(top>=-10&&top<400,'3D bookshelf interaction must bring the mobile shelf into view');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.screenshot({path:path.join(output,'kb3-mobile-books.png'),fullPage:true});
    assert.deepEqual(errors,[]);await context.close();

    const migrated=await browser.newContext({viewport:{width:1280,height:1000}});
    await migrated.addInitScript(()=>localStorage.setItem('word-island:guide:v1','{"version":1,"status":"skipped","intro":0}'));
    const fixture=JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/kb2-v1-progress.json'),'utf8'));
    await migrated.addInitScript(value=>{if(!localStorage.getItem('word-island-test-seeded')){localStorage.setItem('word-island:progress:v1',JSON.stringify(value));localStorage.setItem('word-island-test-seeded','yes');}},fixture);
    const legacyPage=await migrated.newPage();await legacyPage.goto(base);
    await chooseTestProfile(legacyPage);
    await legacyPage.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready);
    const migratedState=await legacyPage.evaluate(()=>window.__wordIsland.getState());
    assert.equal(migratedState.progress.version,3);assert.equal(migratedState.progress.selectedUnitId,'kb3-hello');
    assert.equal(migratedState.progress.rewardDates.length,7);assert.deepEqual(migratedState.progress.companions,['bunny']);
    assert.equal(await legacyPage.evaluate(()=>localStorage.getItem('word-island:progress:v1')),null,'naming the first user moves the old data into its profile');
    const scoped=await legacyPage.evaluate(async()=>{const p=await import('./src/profiles.js');const s=window.__wordIsland.getState();return JSON.parse(localStorage.getItem(p.profileStorageKey(s.activeProfile.id,'progress')));});
    assert.equal(scoped.version,3);assert.deepEqual(scoped.words,fixture.words);assert.deepEqual(scoped.rewardDates,fixture.rewardDates);assert.deepEqual(scoped.companions,fixture.companions);
    assert.deepEqual(scoped.days,migratedState.progress.days,'the scoped v3 copy retains the complete migrated history');
    await legacyPage.locator('[data-action="open-books"]').first().click();await legacyPage.locator('#book-select').selectOption('kb2');
    await chooseUnit('kb2-u6',legacyPage);
    const oldClipKey=await legacyPage.evaluate(async()=>{const m=await import('./src/storage.js');const s=window.__wordIsland.getState(),date=s.dateKey;const clip=await(await fetch('./assets/audio/word-milk.m4a')).blob();await m.putClip('recording:'+date,new Blob([clip],{type:'audio/mp4'}),s.activeProfile.id);return 'recording:'+date;});
    await legacyPage.locator('[data-reading-unit="kb2-u6"]').click();await legacyPage.locator('#recording-playback').waitFor({state:'visible'});
    assert((await legacyPage.locator('#recording-status').textContent()).includes('旧版当日录音'));
    assert(oldClipKey.startsWith('recording:'));assert.equal((await legacyPage.evaluate(()=>window.__wordIsland.getState())).progress.rewardDates.length,7);
    await migrated.close();
    console.log(JSON.stringify({passed:['default KB3 Hello','nine verified units and unit-specific spoken phrases','multiword spelling uses English rather than slug','same-day plan survives unit selection','another-unit reading does not unlock daily reward','separate sentence recordings','offline other-unit speech and curriculum','mobile real bookshelf scroll','v1 progress and companion migration','legacy KB2 recording playback'],url:base,screenshots:output}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
