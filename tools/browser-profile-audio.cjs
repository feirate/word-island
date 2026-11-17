// Real browser regression: a cancelled permission request must not affect a new learner.
// Uses Chrome's fake microphone in fresh contexts; never accesses a real microphone.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';

async function checkPermissionRace(browser,outcome) {
  const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['microphone']});
  const errors=[];
  try {
    await context.addInitScript(()=>{
      const nativeGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const capture=async(constraints,owner)=>{
        const stream=await nativeGetUserMedia(constraints);
        window.__profileAudioQA.streams.push({stream,owner});
        return stream;
      };
      const qa=window.__profileAudioQA={deferNext:false,pending:[],streams:[]};
      navigator.mediaDevices.getUserMedia=constraints=>{
        const owner=window.__wordIsland.getState().activeProfile.id;
        if(!qa.deferNext)return capture(constraints,owner);
        qa.deferNext=false;
        return new Promise((resolve,reject)=>qa.pending.push({constraints,owner,resolve,reject}));
      };
      qa.settle=async outcome=>{
        const pending=qa.pending.shift();
        if(!pending)throw new Error('No permission request is pending');
        if(outcome==='reject')pending.reject(new DOMException('Deferred test permission denial','NotAllowedError'));
        else pending.resolve(await capture(pending.constraints,pending.owner));
        // Allow the app's await/catch/finally handlers to finish before assertions.
        await new Promise(resolve=>setTimeout(resolve,0));
      };
      // Launch also mutes audio; this covers any dynamically created playback nodes.
      document.addEventListener('play',event=>{if(event.target instanceof HTMLMediaElement){event.target.muted=true;event.target.volume=0;}},true);
    });
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(String(error)));
    const picker=page.locator('#profile-dialog');
    const state=()=>page.evaluate(()=>window.__wordIsland.getState());
    const create=async name=>{
      await picker.waitFor({state:'visible'});
      await page.locator('#profile-name').fill(name);
      await page.locator('#create-profile').click();
      await picker.waitFor({state:'hidden'});
      return (await state()).activeProfile;
    };
    const enterReading=async()=>{
      const skip=page.locator('[data-story-action="skip"]');
      if(await skip.isVisible())await skip.click();
      await page.locator('[data-nav="camp"]').first().click();
      await page.locator('[data-task="read"]').click();
    };
    await page.goto(base);
    const a=await create('小明');
    await page.waitForFunction(()=>window.__wordIsland.world.getDiagnostics().ready);
    await enterReading();
    await page.evaluate(()=>{window.__profileAudioQA.deferNext=true;});
    await page.locator('#record-button').click();
    await page.waitForFunction(()=>window.__profileAudioQA.pending.length===1);
    assert(await page.locator('#record-button').isDisabled(),'A is waiting for microphone permission');

    // Browsers can resolve or reject a permission promise long after backgrounding.
    await page.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.locator('#user-button').click();
    const b=await create('Lucy');
    await enterReading();
    await page.locator('#record-button').click();
    await page.waitForFunction(()=>document.querySelector('#record-button').textContent.includes('结束录音'));
    assert.equal((await state()).activeProfile.id,b.id);
    await page.waitForTimeout(450);
    await page.evaluate(outcome=>window.__profileAudioQA.settle(outcome),outcome);

    const playButtons=page.locator('[data-action="play-phrase"],[data-action="play-phrase-slow"],[data-action="practice-phrase"]');
    assert.equal(await playButtons.count(),3);
    for(const button of await playButtons.all())assert(await button.isDisabled(),`stale A permission ${outcome} must keep B's playback disabled during B's recording`);
    const streams=await page.evaluate(()=>window.__profileAudioQA.streams.map(({owner,stream})=>({owner,states:stream.getTracks().map(track=>track.readyState)})));
    assert(streams.some(stream=>stream.owner===b.id&&stream.states.every(value=>value==='live')),'B microphone remains live until B chooses to stop');
    if(outcome==='grant')assert(streams.filter(stream=>stream.owner===a.id).every(stream=>stream.states.every(value=>value==='ended')),'stale A granted stream must be stopped immediately');

    await page.locator('#record-button').click();
    await page.locator('#recording-playback').waitFor({state:'visible',timeout:10000});
    const current=await state();
    const clipKey=`recording:${current.dateKey}:${current.phraseId}`;
    const saved=await page.evaluate(async({a,b,clipKey})=>{
      const storage=await import('./src/storage.js');
      const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('word-island-audio',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      const keys=await new Promise((resolve,reject)=>{const transaction=db.transaction('clips');const request=transaction.objectStore('clips').getAllKeys();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      db.close();
      return {aHasClip:Boolean(await storage.getClip(clipKey,a)),bBytes:(await storage.getClip(clipKey,b))?.size||0,recordingKeys:keys.filter(key=>String(key).includes('recording:')),liveStreams:window.__profileAudioQA.streams.filter(({stream})=>stream.getTracks().some(track=>track.readyState==='live')).length};
    },{a:a.id,b:b.id,clipKey});
    assert.equal(saved.aHasClip,false,'cancelled A request must not save any recording');
    assert(saved.bBytes>0,'B can stop and save its real fake-microphone recording');
    assert.deepEqual(saved.recordingKeys,[`profile:${b.id}:${clipKey}`],'the recording belongs only to B');
    assert.equal(saved.liveStreams,0,'all microphone tracks stop when B finishes');
    assert(await page.locator('[data-action="play-phrase"]').isEnabled(),'playback becomes available after B stops');
    assert.deepEqual(errors,[]);
    return {outcome,passed:['old permission settlement preserves current recorder','B stops and saves only its own recording','A has no recording','all fake tracks stop'],bytes:saved.bBytes};
  } finally { await context.close(); }
}

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--mute-audio']});
  const results=[];
  try {
    for(const outcome of ['reject','grant']) {
      try {results.push(await checkPermissionRace(browser,outcome));}
      catch(error){results.push({outcome,error:error.stack||String(error)});}
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify({results},null,2));
  assert.equal(results.filter(result=>result.error).length,0,'profile audio permission race regressions must pass');
})().catch(error=>{console.error(error);process.exitCode=1;});
