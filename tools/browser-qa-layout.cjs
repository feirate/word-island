const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173/';
const out=path.resolve('design/screenshots');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
 const observations=[],errors=[];
 try {
  const context=await browser.newContext({viewport:{width:375,height:667},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  const snap=async name=>{await page.waitForTimeout(120);await page.screenshot({path:path.join(out,`qa-${name}.png`),fullPage:true});};
  const measure=async(label,selector)=>observations.push(await page.locator(selector).evaluate((e,label)=>{const r=e.getBoundingClientRect();return {label,viewport:[innerWidth,innerHeight],scrollY,scrollWidth:document.documentElement.scrollWidth,bounds:{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom},elementScroll:{top:e.scrollTop,scroll:e.scrollHeight,client:e.clientHeight},text:e.textContent.slice(0,110)};},label));
  const make=async name=>{await page.locator('#profile-name').fill(name);await page.locator('#create-profile').tap();await page.locator('#profile-dialog').waitFor({state:'hidden'});};
  await page.goto(base);await page.locator('#profile-dialog').waitFor({state:'visible'});
  await measure('first375','#profile-dialog');await snap('profile-first-375');
  await make('小小词岛探索队长小明同学');await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready);
  await measure('welcome375','#character-speech');await snap('welcome-long-name-375');
  await page.locator('#user-button').tap();await make('Abcdefghijkl');
  await page.locator('#user-button').tap();await make('小乐');
  await page.locator('#user-button').tap();await measure('three375','#profile-dialog');await snap('profile-three-375');
  await page.setViewportSize({width:375,height:350});await page.locator('#profile-list [data-profile-select]').first().scrollIntoViewIfNeeded();await measure('keyboard375','#profile-dialog');await snap('profile-small-height');
  await page.setViewportSize({width:375,height:667});await page.locator('[data-profile-select]').first().tap();
  await page.locator('[data-story-action="skip"]').tap();
  await page.locator('.main-nav [data-nav="camp"]').tap();await measure('campAfterNav375','.notebook');await snap('camp-after-nav-375');
  await page.locator('[data-task="spell"]').tap();
  if(await page.locator('[data-story-action="practice"]').isVisible())await page.locator('[data-story-action="practice"]').tap();
  await page.waitForTimeout(150);await measure('spell375','#spell-input');await snap('spell-375');
  await page.setViewportSize({width:375,height:350});await page.locator('#spell-input').fill('d');await measure('spellKeyboard375','#spell-input');await snap('spell-keyboard-375');
  await page.setViewportSize({width:375,height:667});
  await page.locator('.main-nav [data-nav="clues"]').tap();await page.waitForFunction(()=>window.__wordIsland.getCompanionDiagnostics()?.ready);await measure('album375','.notebook');await snap('album-375');
  await page.locator('[data-companion="fox"]').tap();await measure('selectedFox375','.world-frame');await snap('album-selected-fox-375');
  await page.locator('#parent-button').tap();await measure('parent375','#parent-dialog');await snap('parent-375');
  const fixture=JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/kb2-v1-progress.json'),'utf8'));
  await page.locator('#import-progress').setInputFiles({name:'layout-progress.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({app:'word-island',version:1,exportedAt:new Date().toISOString(),progress:fixture}))});
  await page.locator('#import-dialog').waitFor({state:'visible'});await measure('import375','#import-dialog');await snap('import-confirm-375');
  assert((await page.locator('#import-summary').innerText()).includes('小小词岛探索队长小明同学'));
  await page.locator('#import-dialog .icon-button').tap();if(await page.locator('#parent-dialog').isVisible())await page.locator('#parent-dialog [data-close="parent-dialog"]').tap();
  for(const [width,height] of [[390,844],[768,1024],[844,390],[1024,768]]){
   await page.setViewportSize({width,height});await page.locator('#user-button').tap();await measure(`profiles-${width}x${height}`,'#profile-dialog');await snap(`profiles-${width}x${height}`);await page.locator('#profile-cancel').tap();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`horizontal overflow ${width}`);
  }
  await page.setViewportSize({width:375,height:667});
  await page.locator('.main-nav [data-nav="camp"]').tap();await page.locator('[data-task="listen"]').tap();
  await page.waitForFunction(()=>window.__wordIsland.getState().phase==='listen'&&window.__wordIsland.getState().activeWordId);
  const state=()=>page.evaluate(()=>window.__wordIsland.getState());
  const failures=[];
  for(const skill of ['listen','spell']){
   if(skill==='spell'){await page.locator('[data-task="spell"]').tap();await page.waitForFunction(()=>window.__wordIsland.getState().phase==='spell'&&window.__wordIsland.getState().activeWordId);}
   for(let i=0;i<8&&(await state()).activeWordId;i++){
    const s=await state();
    if(skill==='listen')await page.locator(`[data-answer="${s.activeWordId}"]`).tap();
    else {const en=await page.evaluate(async id=>(await import('./src/content.js')).getWord(id).en,s.activeWordId);await page.locator('#spell-input').fill(en);await page.locator('[data-action="check-spell"]').tap();}
    await page.locator('[data-action="next-question"]').tap();
    if((await state()).activeWordId){
     const y=await page.locator('.question-title').evaluate(e=>e.getBoundingClientRect().y);
     if(y<0){failures.push(`${skill} question ${i+2} starts above viewport at y=${y}`);await snap(`next-${skill}-question-offscreen`);}
    }
   }
  }
  await page.locator('[data-task="read"]').tap();await page.locator('[data-action="finish-reading"]').tap();
  await page.locator('[data-action="collect"]').tap();await page.locator('#reward-continue').tap();
  await page.waitForTimeout(150);await measure('afterReward375','.world-frame');await page.screenshot({path:path.join(out,'qa-reward-home-viewport.png')});
  const scene=await page.locator('.world-frame').boundingBox();if(scene.y+scene.height<0)failures.push('reward return leaves home entirely above viewport');
  const report=path.resolve('design/qa-layout-report.json');fs.writeFileSync(report,JSON.stringify({observations,errors,failures},null,2));
  console.log(JSON.stringify({viewports:['375×667','390×844','768×1024','844×390','1024×768'],observations:observations.length,errors,failures,report}));
  assert.deepEqual(failures,[]);
  await context.close();
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
