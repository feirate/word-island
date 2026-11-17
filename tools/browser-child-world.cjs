const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
    page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(`${base}/vendor/THREE-LICENSE.txt`);
    await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:20px}#stage{width:1100px;height:720px}#after{height:1800px}</style><script type="importmap">{"imports":{"three":"${base}/vendor/three.module.js"}}</script><div id="stage"></div><div id="after"></div>`);
    await page.evaluate(async base=>{
      const {WorldView}=await import(`${base}/src/world.js`);
      window.childClicks=[];window.childFrames=0;
      window.childWorld=new WorldView(document.getElementById('stage'),{onInteract:id=>window.childClicks.push(id),onFrame:()=>window.childFrames++});
      await window.childWorld.ready;
    },base);
    assert.equal(await page.evaluate(()=>typeof window.childWorld.setPlayerName),'function','the child avatar needs a player identity independent from the guide');
    await page.evaluate(()=>window.childWorld.setPlayerName('小明Alex'));
    const diagnostic=()=>page.evaluate(()=>window.childWorld.getDiagnostics());
    let current=await diagnostic();
    assert.equal(current.playerName,'小明Alex');
    assert(current.models.includes('child')&&current.models.includes('hero'));
    assert.deepEqual(current.actors.filter(actor=>actor.visible).map(actor=>actor.name),['hero','guide']);
    assert.equal(current.actors.find(actor=>actor.name==='hero').modelAsset,'child');
    assert.equal(current.actors.find(actor=>actor.name==='guide').modelAsset,'hero');
    assert.match(await page.locator('canvas').getAttribute('aria-label'),/小明Alex/);
    const pick=async id=>{
      const point=await page.evaluate(id=>window.childWorld.getObjectScreenPoint(id),id);
      assert(point?.visible,`${id} must have a real visible click target`);
      await page.waitForTimeout(460);await page.mouse.click(point.x,point.y);
      assert.equal(await page.evaluate(()=>window.childClicks.at(-1)),id);
    };
    fs.mkdirSync('design/screenshots',{recursive:true});
    for(const scene of ['home','camp']){
      await page.evaluate(scene=>window.childWorld.setScene(scene),scene);
      for(const actor of ['hero','guide']){
        const anchor=await page.evaluate(actor=>window.childWorld.getActorScreenPoint(actor),actor);
        assert(anchor?.visible,`${scene} ${actor} needs a speech anchor`);
        await pick(`character.${actor}`);
      }
      for(const id of scene==='home'?['home.door','home.bookshelf','home.clues']:['camp.crate','camp.sign','camp.mailbox','camp.chest'])await pick(id);
      await page.screenshot({path:`design/screenshots/child-world-${scene}.png`,fullPage:false});
    }
    const ids=['bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox'];
    await page.evaluate(async ids=>{await window.childWorld.setScene('home');await window.childWorld.setCompanionsUnlocked(ids);},ids);
    for(const id of ['character.hero','character.guide',...ids.map(id=>`home.${id}`)])await pick(id);
    await page.screenshot({path:'design/screenshots/child-world-home-all.png',fullPage:false});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>document.getElementById('stage').style.cssText='width:100%;height:460px');
    await page.waitForTimeout(150);
    for(const actor of ['hero','guide',...ids])assert((await page.evaluate(actor=>window.childWorld.getActorScreenPoint(actor),actor))?.visible,`${actor} must remain in the mobile scene`);
    for(const id of ['character.hero','character.guide',...ids.map(id=>`home.${id}`)])assert((await page.evaluate(id=>window.childWorld.getObjectScreenPoint(id),id))?.visible,`${id} must be pickable in the mobile scene`);
    await page.screenshot({path:'design/screenshots/child-world-home-all-mobile.png',fullPage:false});
    await page.evaluate(()=>window.childWorld.setScene('camp'));await page.waitForTimeout(150);
    for(const id of ['character.hero','character.guide','home.bunny']){
      if(id==='home.bunny')assert((await page.evaluate(()=>window.childWorld.getActorScreenPoint('bunny')))?.visible);
      else await pick(id);
    }
    for(const id of ['camp.crate','camp.sign','camp.mailbox','camp.chest'])assert((await page.evaluate(id=>window.childWorld.getObjectScreenPoint(id),id))?.visible,`${id} must not be blocked by the child, guide or bunny`);
    await page.screenshot({path:'design/screenshots/child-world-camp-mobile.png',fullPage:false});
    await page.evaluate(()=>window.childWorld.setPlayerName('Amy'));
    assert.equal((await diagnostic()).playerName,'Amy');
    assert.equal((await diagnostic()).actors.find(actor=>actor.name==='guide').displayName,'芽芽');
    assert(!JSON.stringify(await diagnostic()).includes('小明Alex'));
    await page.evaluate(()=>scrollTo(0,1400));await page.waitForTimeout(200);
    const stopped=await page.evaluate(()=>window.childFrames);await page.waitForTimeout(180);
    assert.equal(await page.evaluate(()=>window.childFrames),stopped);
    await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(180);
    assert(await page.evaluate(n=>window.childFrames>n,stopped));
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(150);
    const reduced=await page.evaluate(()=>window.childFrames);await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>window.childFrames),reduced);
    await page.evaluate(()=>{window.childWorld.setActive(false);window.childWorld.setPlayerName('小林');window.childWorld.setActive(true);});
    await page.waitForTimeout(150);assert.equal((await diagnostic()).playerName,'小林');
    await page.evaluate(()=>window.childWorld.dispose());
    assert.equal(await page.evaluate(()=>window.childWorld.getActorScreenPoint('hero')),null);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:['distinct child and guide assets','named child identity without renaming guide','both-scene real child and guide clicks and anchors','all task props remain pickable','ten-character home and mobile layout','offscreen pause and reduced motion','name switch and disposal'],errors}));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
