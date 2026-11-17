const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(`${base}/vendor/THREE-LICENSE.txt`);
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:20px}main{display:flex;gap:20px}#world{width:930px;height:650px}#preview{width:420px;height:520px}#after{height:1600px}</style><script type="importmap">{"imports":{"three":"${base}/vendor/three.module.js"}}</script><main><div id="world"></div><div id="preview"></div></main><div id="after"></div>`);
    await page.evaluate(async base=>{
      const {WorldView}=await import(`${base}/src/world.js`);
      window.petClicks=[];
      window.petWorld=new WorldView(document.getElementById('world'),{onInteract:id=>window.petClicks.push(id)});
      await window.petWorld.ready;
    },base);
    assert.equal(await page.evaluate(()=>typeof window.petWorld.setCompanionsUnlocked),'function','the home must support all earned companion identities');
    await page.evaluate(async base=>{
      const {CompanionView}=await import(`${base}/src/companion-view.js`);
      window.petPreview=new CompanionView(document.getElementById('preview'));
      await window.petPreview.ready;
      await window.petPreview.setCompanion('bunny',false);
    },base);
    const preview=()=>page.evaluate(()=>window.petPreview.getDiagnostics());
    let gray=await preview();assert(gray.ready&&gray.gray&&gray.id==='bunny');
    assert(gray.materialColors.length>0&&gray.materialColors.every(([r,g,b])=>Math.abs(r-g)<.001&&Math.abs(g-b)<.001),'locked model must really use grayscale materials');
    await page.evaluate(()=>window.petPreview.setCompanion('bunny',true));
    let colored=await preview();assert.equal(colored.gray,false);
    assert(colored.materialColors.some(([r,g,b])=>Math.abs(r-g)>.01||Math.abs(g-b)>.01),'unlock restores the model’s actual colors');
    const before=colored.camera;
    const bounds=await page.locator('#preview').boundingBox();
    await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width/2+100,bounds.y+bounds.height/2+20,{steps:8});await page.mouse.up();await page.waitForTimeout(200);
    assert.notDeepEqual((await preview()).camera,before,'dragging rotates the real model view');
    await page.evaluate(async()=>{await Promise.all([window.petPreview.setCompanion('squirrel',false),window.petPreview.setCompanion('fox',true)]);});
    assert.equal((await preview()).id,'fox','a slower previous selection cannot replace the latest one');
    await page.route('**/assets/models/companions/cat.glb',async route=>{await new Promise(resolve=>setTimeout(resolve,100));await route.fulfill({status:404,body:'not available'});});
    const stale=await page.evaluate(async()=>Promise.allSettled([window.petPreview.setCompanion('cat',false),window.petPreview.setCompanion('fox',true)]));
    assert(stale.every(result=>result.status==='fulfilled'),'an obsolete failed selection must not reject over a newer successful one');
    assert.equal((await preview()).id,'fox');assert.equal((await preview()).error,null);
    await page.unroute('**/assets/models/companions/cat.glb');
    const catalog=await page.evaluate(async base=>(await import(`${base}/src/companions.js`)).COMPANIONS.map(p=>p.id),base);
    await page.evaluate(ids=>window.petWorld.setCompanionsUnlocked(ids),catalog);
    for(const id of catalog){
      const point=await page.evaluate(id=>window.petWorld.getObjectScreenPoint(`home.${id}`),id);
      assert(point?.visible,`${id} should occupy a visible, truly pickable place at home`);
      await page.waitForTimeout(470);await page.mouse.click(point.x,point.y);
      assert.equal(await page.evaluate(()=>window.petClicks.at(-1)),`home.${id}`);
      const anchor=await page.evaluate(id=>window.petWorld.getActorScreenPoint(id),id);assert(anchor?.visible,`${id} needs a visible speech anchor`);
    }
    fs.mkdirSync('design/screenshots',{recursive:true});
    await page.screenshot({path:'design/screenshots/companions-home-layout.png',fullPage:false});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{document.querySelector('main').style.display='block';document.getElementById('world').style.cssText='width:100%;height:460px';document.getElementById('preview').style.display='none';});
    await page.waitForTimeout(200);
    for(const id of catalog){const point=await page.evaluate(id=>window.petWorld.getObjectScreenPoint(`home.${id}`),id);assert(point?.visible&&point.x>=0&&point.x<=390,`${id} must remain visible at phone width`);}
    await page.screenshot({path:'design/screenshots/companions-home-layout-mobile.png',fullPage:false});
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>{document.querySelector('main').style.display='flex';document.getElementById('world').style.cssText='width:930px;height:650px';document.getElementById('preview').style.display='';});
    await page.waitForTimeout(100);
    await page.evaluate(()=>window.petWorld.setScene('camp'));
    const camp=await page.evaluate(()=>window.petWorld.getDiagnostics());
    assert.deepEqual(camp.actors.filter(a=>a.visible).map(a=>a.name),['hero','guide','bunny'],'camp keeps the child, guide and one companion while all other friends remain at home');
    await page.evaluate(()=>window.petPreview.setActive(false));await page.waitForTimeout(100);const paused=await preview();await page.waitForTimeout(150);assert.equal((await preview()).frames,paused.frames);
    await page.evaluate(()=>window.petPreview.setActive(true));await page.waitForTimeout(100);assert((await preview()).frames>paused.frames);
    await page.evaluate(()=>window.petWorld.setActive(false));await page.waitForTimeout(100);const worldPaused=await page.evaluate(()=>window.petWorld.getDiagnostics().actors[0].animationTime);await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.petWorld.getDiagnostics().actors[0].animationTime),worldPaused);
    await page.evaluate(()=>{document.querySelector('main').style.display='block';document.getElementById('world').style.display='none';document.getElementById('preview').style.cssText='width:100%;height:420px';});
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
    await page.evaluate(()=>scrollTo(0,1200));await page.waitForTimeout(100);const offscreen=await preview();await page.waitForTimeout(150);assert.equal((await preview()).frames,offscreen.frames);
    await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(150);assert((await preview()).frames>offscreen.frames);
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(100);const reduced=await preview();await page.waitForTimeout(150);assert.equal((await preview()).frames,reduced.frames,'reduced motion does not animate endlessly');
    await page.evaluate(()=>window.petPreview.setCompanion('turtle',false));assert.equal((await preview()).id,'turtle');
    assert(await page.evaluate(()=>document.querySelectorAll('#preview canvas').length===1));
    await page.evaluate(()=>{window.petWorld.dispose();window.petPreview.dispose();});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:['real grayscale and restored-color materials','single canvas model selection and drag','latest async selection wins','eight genuinely pickable home companions and speech anchors','one camp follower','inactive and offscreen render pause','390px/reduced-motion and dispose'],errors}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
