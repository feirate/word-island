const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['microphone']});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  const state=()=>page.evaluate(()=>window.__wordIsland.getState());
  const ready=()=>page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready);
  const picker=page.locator('#profile-dialog');
  const create=async name=>{await page.locator('#profile-name').fill(name);await page.locator('#create-profile').click();await picker.waitFor({state:'hidden'});return (await state()).activeProfile;};
  const skip=async()=>{const button=page.locator('[data-story-action="skip"]');if(await button.isVisible())await button.click();};
  const choose=async id=>{await page.locator('#user-button').click();await page.locator(`[data-profile-select="${id}"]`).click();await picker.waitFor({state:'hidden'});};
  const record=async()=>{
   await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="read"]').click();
   await page.locator('[data-action="record"]').click();await page.waitForFunction(()=>document.querySelector('#record-button')?.textContent.includes('结束录音'));
   await page.waitForTimeout(450);await page.locator('[data-action="record"]').click();await page.locator('#recording-playback').waitFor({state:'visible'});
   const s=await state();return `recording:${s.dateKey}:${s.phraseId}`;
  };
  await page.goto(base);
  assert.equal(await picker.isVisible(),true,'every fresh visit must ask which local learner is using the island');
  await page.locator('#profile-name').fill('小明1');await page.locator('#create-profile').click();
  await page.waitForFunction(()=>document.querySelector('#profile-error').textContent.length>0);assert.equal(await page.locator('[data-profile-select]').count(),0);
  const a=await create('小明');await ready();await skip();
  assert.equal((await state()).activeProfile.name,'小明');assert((await page.locator('#user-button').innerText()).includes('小明'));
  const fixture=JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/kb2-v1-progress.json'),'utf8'));
  await page.locator('#parent-button').click();await page.locator('#import-progress').setInputFiles({name:'old-progress.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({app:'word-island',version:1,exportedAt:new Date().toISOString(),progress:fixture}))});
  await page.locator('#confirm-import').click();await page.locator('#import-dialog').waitFor({state:'hidden'});assert.equal((await state()).progress.rewardDates.length,7);
  const clipA=await record();await page.locator('[data-action="finish-reading"]').click();await page.waitForFunction(()=>window.__wordIsland.getState().phase!=='read');
  await page.locator('#user-button').click();const b=await create('Lucy');
  assert.notEqual(a.id,b.id);assert.equal((await state()).progress.rewardDates.length,0);assert.equal((await state()).guide.status,'active');await skip();
  await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="read"]').click();
  await page.locator('#record-button').waitFor();
  assert.equal((await state()).readingDone,false);assert(await page.locator('#recording-playback').isHidden(),'another learner’s recording must never be displayed');
  const clipB=await record();
  await choose(a.id);assert.equal((await state()).progress.rewardDates.length,7);assert.equal((await state()).guide.status,'skipped');
  await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="read"]').click();await page.locator('#recording-playback').waitFor({state:'visible'});assert.equal((await state()).readingDone,true);
  await page.locator('#user-button').click();const c=await create('王Lucy');
  await page.locator('#user-button').click();assert.equal(await page.locator('[data-profile-select]').count(),3);assert(await page.locator('#create-profile').isDisabled());
  await page.locator(`[data-profile-delete="${a.id}"]`).click();await page.getByRole('button',{name:'留着，返回'}).click();assert.equal(await page.locator('[data-profile-select]').count(),3);
  await page.locator(`[data-profile-delete="${a.id}"]`).click();assert((await page.locator('#delete-profile-dialog').innerText()).includes('小明'));await page.locator('#confirm-delete-profile').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-profile-select]').length===2);
  const deletion=await page.evaluate(async({a,b,clipA,clipB})=>{
   const m=await import('./src/storage.js'),profiles=await import('./src/profiles.js');
   const texts=Object.keys(localStorage).filter(key=>key.includes(a));
   const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('word-island-audio',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
   const keys=await new Promise((resolve,reject)=>{const tx=db.transaction('clips');const r=tx.objectStore('clips').getAllKeys();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();
   return {deleted:profiles.getProfile(a)===null,texts,orphanKeys:keys.filter(key=>String(key).includes(a)),bClip:Boolean((await m.getClip(clipB,b))?.size)};
  },{a:a.id,b:b.id,clipA,clipB});
  assert.deepEqual(deletion,{deleted:true,texts:[],orphanKeys:[],bClip:true});
  await page.locator(`[data-profile-select="${b.id}"]`).click();assert.equal((await state()).activeProfile.id,b.id);assert.equal((await state()).progress.rewardDates.length,0);
  await page.reload();await picker.waitFor({state:'visible'});assert.equal((await state()).activeProfile,null);
  await page.locator(`[data-profile-select="${b.id}"]`).click();await ready();
  assert.equal((await state()).worldPlayerName||await page.evaluate(()=>window.__wordIsland.world.getDiagnostics().playerName),'Lucy');
  await page.locator('#parent-button').click();await page.locator('#prepare-offline').click();await page.waitForFunction(()=>document.querySelector('#offline-detail').textContent.includes('已可离线'));await page.locator('[data-close="parent-dialog"]').click();
  await context.setOffline(true);
  assert.deepEqual(await page.evaluate(async()=>{
   const entry=document.querySelector('script[type="module"][src]').src;
   return Promise.all([entry,...['assets/models/child.glb','assets/models/child-portrait.png'].map(file=>new URL(file,location.href).href)].map(async url=>{try{const response=await fetch(url);return response.ok&&(await response.arrayBuffer()).byteLength>0;}catch{return false;}}));
  }),[true,true,true],'offline preparation must serve the real learning entry and complete child assets through the worker');
  await page.reload();await picker.waitFor({state:'visible'});await page.locator(`[data-profile-select="${b.id}"]`).click();await ready();assert.equal((await state()).activeProfile.name,'Lucy');await context.setOffline(false);
  const other=await context.newPage();await other.goto(base);await other.locator('#profile-dialog').waitFor({state:'visible'});await other.locator(`[data-profile-select="${c.id}"]`).click();
  await other.locator('#user-button').click();await other.locator(`[data-profile-delete="${b.id}"]`).click();await other.locator('#confirm-delete-profile').click();
  await picker.waitFor({state:'visible'});assert.equal((await state()).activeProfile,null,'deleting an active name in another tab must return this tab to the chooser');
  await page.locator(`[data-profile-select="${c.id}"]`).click();await other.close();
  for(const width of [390,768]){await page.setViewportSize({width,height:1000});await page.locator('#user-button').click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#profile-cancel').click();}
  fs.mkdirSync(path.resolve('design/screenshots'),{recursive:true});await page.setViewportSize({width:1440,height:1100});await page.screenshot({path:path.resolve('design/screenshots/child-home.png'),fullPage:true});
  await page.locator('#user-button').click();await page.screenshot({path:path.resolve('design/screenshots/profile-picker.png'),fullPage:true});
  assert.deepEqual(errors,[]);assert.notEqual(b.id,c.id);
  console.log(JSON.stringify({passed:['required chooser on each visit','Chinese/English names and max three','per-user progress/companions/guide/reading/recording','confirmed deletion with real IDB cleanup','other learner preserved','offline user selection and cached child assets','named child avatar','cross-tab deletion returns active learner to chooser','390/768 layouts'],errors}));
  await context.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
