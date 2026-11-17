const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4181/';
const artifact=process.env.ARTIFACT_ROOT;
const report=artifact?JSON.parse(fs.readFileSync(path.join(artifact,'build-report.json'),'utf8')):null;
const moduleFile=(name,fallback)=>{
 if(!artifact)return fallback;
 const file=report.javascript.files.find(file=>new RegExp(`\\bas ${name}\\b`).test(fs.readFileSync(path.join(artifact,file),'utf8')));
 assert(file,`built runtime must expose ${name}`);return file;
};
const worldPattern=`**/${moduleFile('WorldView','src/world.js')}*`;
const albumPattern=`**/${moduleFile('CompanionView','src/companion-view.js')}*`;
const loaderFile=moduleFile('GLTFLoader','vendor/loaders/GLTFLoader.js');

(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
 const results=[];
 const run=async(name,exercise)=>{
  // Page routes cannot inject faults into a service worker's own fetches.
  // Worker streaming/cancellation has its separate real-HTTP suite.
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  try{await exercise({context,page});assert.deepEqual(errors,[]);results.push({name,status:'PASS'});}
  catch(error){results.push({name,status:'FAIL',error:String(error),state:await page.evaluate(()=>({world:window.__wordIsland?.getDiagnostics(),companion:window.__wordIsland?.getCompanionDiagnostics(),loading:document.querySelector('#companion-loading')?.textContent,worldError:document.querySelector('#world-loading')?.textContent})).catch(()=>null)});}
  finally{await context.close();console.log(JSON.stringify(results.at(-1)));}
 };
 const skip=async page=>{const button=page.locator('[data-story-action="skip"]');if(await button.isVisible())await button.click();};
 const ready=async page=>{await page.goto(base);await chooseTestProfile(page,'恢复测试');await page.waitForFunction(()=>window.__wordIsland.getDiagnostics().sceneReady);await skip(page);};
 const albumReady=async(page,id)=>page.waitForFunction(id=>{const d=window.__wordIsland.getCompanionDiagnostics();return d?.ready&&d.id===id;},id,{timeout:7000});
 try{
  await run('failed world module can be retried after network recovers',async({page})=>{
   await page.route(worldPattern,route=>route.abort());await page.goto(base);await chooseTestProfile(page,'世界恢复');await skip(page);
   await page.locator('#world-loading[data-state="error"]').waitFor();
   await page.unroute(worldPattern);await page.locator('#world-loading [data-action="retry-world"]').click();
   await page.waitForFunction(()=>window.__wordIsland.getDiagnostics().sceneReady,null,{timeout:7000});
  });
  await run('failed album module can be retried after network recovers',async({page})=>{
   await page.route(albumPattern,route=>route.abort());await ready(page);
   await page.locator('.main-nav [data-nav="clues"]').click();await page.locator('[data-action="retry-companion"]').waitFor();
   await page.unroute(albumPattern);await page.locator('[data-action="retry-companion"]').click();await albumReady(page,'bunny');
  });
  await run('cancelled album load resumes after opening and returning from profile picker',async({page})=>{
   await ready(page);await page.locator('.main-nav [data-nav="clues"]').click();await albumReady(page,'bunny');
   let release,seen;const blocked=new Promise(resolve=>seen=resolve),gate=new Promise(resolve=>release=resolve);let first=true;
   await page.route('**/assets/models/companions/dog.glb',async route=>{if(first){first=false;seen();await gate;}await route.continue().catch(()=>{});});
   await page.locator('[data-companion="dog"]').click();await Promise.race([blocked,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Expected cold dog request was not observed')),7000))]);
   await page.locator('#user-button').click();await page.locator('#profile-dialog[open]').waitFor();
   assert.deepEqual(await page.evaluate(()=>window.__wordIsland.getCompanionDiagnostics().loadingModels),[]);
   await page.locator('#profile-cancel').click();release();await albumReady(page,'dog');
   assert.equal(await page.locator('#companion-loading').isHidden(),true);
  });
  await run('obsolete first A selection cannot hide loading for a later A selection',async({page})=>{
   await ready(page);await page.locator('.main-nav [data-nav="clues"]').click();await albumReady(page,'bunny');
   // Parsing can finish after its download was cancelled. Delay one real GLB's
   // parsed result, then hold the second dog request, to expose the A/B/A race.
   await page.evaluate(async loaderFile=>{
    const {GLTFLoader}=await import(new URL(loaderFile,location.href).href);
    const original=GLTFLoader.prototype.parseAsync;let captured=false;
    GLTFLoader.prototype.parseAsync=async function(...args){
     const gltf=await original.apply(this,args);
     if(!captured){captured=true;window.firstAlbumParseWaiting=true;await new Promise(resolve=>window.releaseFirstAlbumParse=resolve);}
     return gltf;
    };
   },loaderFile);
   let count=0,release,seen;const held=new Promise(resolve=>seen=resolve),gate=new Promise(resolve=>release=resolve);
   await page.route('**/assets/models/companions/dog.glb',async route=>{count++;if(count===2){seen();await gate;}await route.continue().catch(()=>{});});
   try{
    await page.locator('[data-companion="dog"]').click();await page.waitForFunction(()=>window.firstAlbumParseWaiting);
    await page.locator('[data-companion="cat"]').click();await page.locator('[data-companion="dog"]').click();
    await Promise.race([held,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Expected second dog request was not observed')),7000))]);
    assert.equal(await page.locator('#companion-loading').isVisible(),true,'second dog is still being downloaded');
    await page.evaluate(()=>window.releaseFirstAlbumParse());await page.waitForTimeout(150);
    assert.equal(await page.locator('#companion-loading').isVisible(),true,'a false result from the obsolete first dog must not hide the second dog loading state');
   }finally{release?.();await page.evaluate(()=>window.releaseFirstAlbumParse?.()).catch(()=>{});}
   await albumReady(page,'dog');assert.equal(await page.locator('#companion-loading').isHidden(),true);
  });
  await run('late album import stays dormant on another page and resumes when revisited',async({page})=>{
   await ready(page);let release,seen;const blocked=new Promise(resolve=>seen=resolve),gate=new Promise(resolve=>release=resolve);
   await page.route(albumPattern,async route=>{seen();await gate;await route.continue().catch(()=>{});});
   await page.locator('.main-nav [data-nav="clues"]').click();await Promise.race([blocked,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Expected album module request was not observed')),7000))]);await page.locator('.main-nav [data-nav="home"]').click();release();
   await page.waitForTimeout(250);assert.equal(await page.locator('#companion-preview canvas').count(),0);
   await page.locator('.main-nav [data-nav="clues"]').click();await albumReady(page,'bunny');
  });
  await run('switching unit while 3D is unavailable retains selected unit and learning input',async({page})=>{
   await page.route(worldPattern,route=>route.abort());await page.goto(base);await chooseTestProfile(page,'单元测试');await skip(page);
   await page.locator('[data-action="open-books"]').first().click();const other=page.locator('[data-unit="kb3-u1"]');await other.click();
   await page.waitForFunction(()=>window.__wordIsland.getState().progress.selectedUnitId==='kb3-u1');
   await page.locator('[data-action="start-unit"]').click();await page.locator('#notebook-content [data-task="spell"]').click();await page.locator('#spell-input').fill('test');
   assert.equal(await page.locator('#spell-input').inputValue(),'test');assert.equal(await page.evaluate(()=>window.__wordIsland.getState().plan.unitId),'kb3-u1');
  });
 }finally{await browser.close();}
 fs.writeFileSync('/private/tmp/word-island-startup-recovery-report.json',JSON.stringify({results},null,2));console.log(JSON.stringify({results},null,2));
 if(results.some(result=>result.status==='FAIL'))process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
