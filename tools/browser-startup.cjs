const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4181/';
const buildReport=process.env.ARTIFACT_ROOT?JSON.parse(fs.readFileSync(path.join(process.env.ARTIFACT_ROOT,'build-report.json'),'utf8')):null;
const deferredFiles=new Set((buildReport?.javascript.files||[]).filter(file=>!buildReport.entry.files.includes(file)).map(file=>path.basename(file)));
const isDeferred=url=>buildReport?deferredFiles.has(path.basename(new URL(url).pathname)):/\/(?:world|three(?:\.core|\.module)?)\.js/.test(url);
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  const page=await context.newPage();const requests=[],errors=[];
  page.on('request',request=>requests.push(request.url()));page.on('pageerror',error=>errors.push(error.message));
  // A missing/slow 3D module must not prevent selecting a name or learning.
  await page.route('**/src/*.js*',route=>isDeferred(route.request().url())?route.abort():route.continue());
  try{
    await page.goto(base);await page.locator('#profile-dialog[open]').waitFor({timeout:10000});
    assert.equal(requests.some(isDeferred),false,'profile selection must not request 3D code');
    await chooseTestProfile(page,'启动测试');
    await page.locator('#world-loading [data-action="start-learning"]').click();
    await page.locator('[data-answer]').first().waitFor();
    assert.equal(await page.evaluate(()=>window.__wordIsland.getState().phase),'listen');
    await page.locator('[data-nav="camp"]').click();await page.locator('#notebook-content [data-task="spell"]').click();
    await page.locator('#spell-input').fill('test');assert.equal(await page.locator('#spell-input').inputValue(),'test');
    assert.equal(await page.evaluate(()=>window.__wordIsland.getDiagnostics().ready),false);
    assert.deepEqual(errors,[]);const report={passed:['profile before any 3D code','listen with failed 3D import','spelling with failed 3D import'],requests,errors};
    fs.writeFileSync('/private/tmp/word-island-startup-report.json',JSON.stringify(report,null,2));
    await page.screenshot({path:'/private/tmp/word-island-startup-learning.png',fullPage:true});console.log(JSON.stringify(report));
  }catch(error){
    console.error(JSON.stringify({error:String(error),errors,requests,state:await page.evaluate(()=>({profileError:document.querySelector('#profile-error')?.textContent,state:window.__wordIsland?.getState(),world:window.__wordIsland?.getDiagnostics()})).catch(()=>null)}));
    throw error;
  }finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
