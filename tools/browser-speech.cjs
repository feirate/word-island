const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';

// Observe real decoding and playback. No fake Audio implementation or physical microphone.
const observeSpeech=()=>{
  const NativeAudio=window.Audio;
  window.__speechTrace={players:[],plays:[],errors:[]};
  window.Audio=function(...args){
    const audio=new NativeAudio(...args),trace=window.__speechTrace,id=trace.players.length;
    trace.players.push(audio);audio.muted=true;
    const nativePlay=audio.play.bind(audio);
    audio.play=()=>{
      const entry={player:id,src:audio.src,rate:audio.playbackRate,preservesPitch:audio.preservesPitch,at:performance.now(),started:false};
      trace.plays.push(entry);
      return nativePlay().then(()=>{entry.started=true;},error=>{entry.rejected=error.name;throw error;});
    };
    audio.addEventListener('ended',()=>{
      const entry=[...trace.plays].reverse().find(item=>item.player===id);
      if(entry)entry.endedAt=performance.now();
    });
    audio.addEventListener('error',()=>trace.errors.push({player:id,src:audio.src,code:audio.error?.code}));
    return audio;
  };
  window.Audio.prototype=NativeAudio.prototype;
  const nativeMic=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const pending=[];
  window.__speechMic={calls:0,streams:[],async resolve(){
    const stream=await nativeMic({audio:true,video:false});
    this.streams.push(stream);pending.shift()(stream);
  }};
  Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value(){
    window.__speechMic.calls+=1;
    return new Promise(resolve=>pending.push(resolve));
  }});
};

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const passed=[];
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['microphone'],timezoneId:'Asia/Shanghai'});
    await context.addInitScript(()=>localStorage.setItem('word-island:guide:v1','{"version":1,"status":"skipped","intro":4}'));
    await context.addInitScript(observeSpeech);
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(12000);
    page.on('pageerror',error=>errors.push(String(error)));
    const state=()=>page.evaluate(()=>window.__wordIsland.getState());
    const ready=async()=>{await chooseTestProfile(page);await page.waitForFunction(()=>window.__wordIsland?.world.getDiagnostics().ready,{timeout:30000});await page.locator('#world-loading').waitFor({state:'hidden'});};
    const playCount=()=>page.evaluate(()=>window.__speechTrace.plays.length);
    const trace=()=>page.evaluate(()=>window.__speechTrace.plays);
    const enter=async skill=>{await page.locator('[data-nav="camp"]').first().click();await page.locator(`#notebook-content [data-task="${skill}"]`).click();await page.locator(skill==='read'?'#record-button':'[data-answer]').first().waitFor();};
    const clickAction=action=>page.locator(`[data-action="${action}"]`).click();
    const waitStarted=async index=>{
      await page.waitForFunction(index=>{const t=window.__speechTrace,p=t.plays[index];return p?.started&&t.players[p.player].currentTime>0.01;},index);
      return (await trace())[index];
    };
    const waitEnded=index=>page.waitForFunction(index=>Number.isFinite(window.__speechTrace.plays[index]?.endedAt),index);
    const play=async action=>{const index=await playCount();await clickAction(action);return {index,...await waitStarted(index)};};
    const prepareOffline=async()=>{
      await page.locator('#parent-button').click();await page.locator('#prepare-offline').click();
      await page.waitForFunction(()=>document.querySelector('#offline-detail')?.textContent.includes('已可离线'),{timeout:45000});
      await page.locator('[data-close="parent-dialog"]').click();
    };

    await page.goto(base);await ready();await enter('listen');
    assert.equal(await page.locator('[data-action="play-word-slow"]').count(),1,'children need a distinct slower word demonstration');
    const word=(await state()).activeWordId;
    const normal=await play('play-word');assert(normal.src.endsWith(`/word-${word}.m4a`));assert.equal(normal.rate,1);
    const slow=await play('play-word-slow');assert(slow.src.endsWith(`/word-${word}-slow.m4a`));assert.equal(slow.rate,1,'bundled slow speech is a separate local slow file played at its native rate');
    assert(await page.evaluate(index=>window.__speechTrace.players[index].paused,normal.player));
    passed.push('real normal and separate local slow word playback');

    await enter('read');const phrase0=(await state()).phraseId;
    const phraseNormal=await play('play-phrase');assert(phraseNormal.src.endsWith(`/phrase-${phrase0}.m4a`));
    const phraseSlow=await play('play-phrase-slow');assert(phraseSlow.src.endsWith(`/phrase-${phrase0}-slow.m4a`));assert.equal(phraseSlow.rate,1);
    await page.locator('[data-phrase="1"]').click();const phrase1=(await state()).phraseId;
    await page.locator('[data-phrase="0"]').click();
    passed.push('real normal and separate local slow sentence playback');

    // A short real AAC keeps cancellation tests quick while still exercising real Blob URLs.
    const sample=fs.readFileSync(path.resolve('assets/audio/word-milk.m4a'));
    await page.locator('#parent-button').click();
    await page.locator('#import-audio').setInputFiles([phrase0,phrase1].map(id=>({name:`phrase-${id}.m4a`,mimeType:'audio/mp4',buffer:sample})));
    await page.waitForFunction(()=>document.querySelector('#audio-import-status').textContent.includes('已保存 2 段'));
    await page.locator('[data-close="parent-dialog"]').click();
    const before=JSON.stringify((await state()).realProgress);
    const importedNormal=await play('play-phrase');assert(importedNormal.src.startsWith('blob:'));assert.equal(importedNormal.rate,1);
    const importedSlow=await play('play-phrase-slow');assert(importedSlow.src.startsWith('blob:'));assert.equal(importedSlow.rate,.82);assert.equal(importedSlow.preservesPitch,true);
    assert((await page.locator('#audio-source').innerText()).includes('导入'));
    passed.push('imported speech remains first choice, with pitch-preserving slow playback');

    assert.equal(await page.locator('#follow-status').getAttribute('aria-live'),'polite');
    const start=await playCount();await clickAction('practice-phrase');await waitStarted(start);await waitEnded(start);
    assert((await page.locator('#follow-status').innerText()).trim(),'a follow-along pause must tell the child it is their turn');
    await page.waitForFunction(start=>window.__speechTrace.plays.length>=start+2,start,{timeout:11000});
    const repeated=await waitStarted(start+1),first=(await trace())[start];
    const gap=repeated.at-first.endedAt;
    assert(gap>=2950&&gap<=8500,`the child needs a finite 3–8 second imitation pause; observed ${gap}ms`);
    assert(first.src.startsWith('blob:')&&repeated.src.startsWith('blob:'),'both demonstrations must use the imported recording');
    await waitEnded(start+1);await page.waitForTimeout(8500);
    assert.equal(await playCount(),start+2,'a follow-along practice must stop after the second demonstration');
    assert.equal(JSON.stringify((await state()).realProgress),before);
    assert.equal((await state()).readingDone,false,'hearing or waiting is not proof of speaking');
    passed.push('finite two-pass imported follow-along, real pause and no automatic learning credit');

    await prepareOffline();await context.setOffline(true);await page.reload();await ready();
    await page.locator('[data-action="open-books"]').first().click();await page.locator('[data-unit="kb3-u1"]').click();
    await page.locator('[data-free-word="aunt"]').click();
    const unheard=await play('play-word-slow');assert(unheard.src.endsWith('/word-aunt-slow.m4a'));
    await context.setOffline(false);
    passed.push('previously unheard slow speech plays after a fully offline reload');

    // Every cancelled session gets only its first play. One shared wait catches late old timers.
    const cancelledStart=await playCount();let cancelledSessions=0;
    const beginWaiting=async()=>{
      await enter('read');await page.locator('[data-phrase="0"]').click();
      const index=await playCount();await clickAction('practice-phrase');await waitStarted(index);await waitEnded(index);cancelledSessions+=1;
    };
    await beginWaiting();await page.locator('[data-phrase="1"]').click();
    await beginWaiting();await page.locator('[data-nav="home"]').first().click();
    await beginWaiting();await page.locator('[data-object="camp.sign"]').click();
    await beginWaiting();await clickAction('stop-speaking');
    await beginWaiting();
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
    await beginWaiting();await clickAction('record');
    assert.equal(await page.evaluate(()=>window.__speechMic.calls),1);
    const blockedAt=await playCount();
    const playbackActions=['play-phrase','play-phrase-slow','practice-phrase'];
    const checkBlocked=async()=>{
      for(const action of playbackActions)assert(await page.locator(`[data-action="${action}"]`).isDisabled(),`${action} must be disabled while the microphone is busy`);
      await page.evaluate(actions=>actions.forEach(action=>document.querySelector(`[data-action="${action}"]`).click()),playbackActions);
      assert.equal(await playCount(),blockedAt);
    };
    await checkBlocked();await page.evaluate(()=>window.__speechMic.resolve());
    await page.waitForFunction(()=>document.querySelector('#record-button')?.textContent.includes('结束录音'));
    await checkBlocked();await page.waitForTimeout(250);await clickAction('record');
    await page.locator('#recording-playback').waitFor({state:'visible'});
    assert(await page.evaluate(()=>window.__speechMic.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))));
    await clickAction('record');assert.equal(await page.evaluate(()=>window.__speechMic.calls),2);
    assert.equal(await page.locator('#recording-playback').evaluate(player=>player.controls),false,'old recording controls must be unavailable during a pending microphone request');
    assert(await page.locator('#recording-playback').evaluate(async player=>{player.muted=true;await player.play().catch(()=>{});return player.paused;}),'programmatic playback of an old recording must also stop while the microphone is busy');
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
    for(const action of playbackActions)assert(await page.locator(`[data-action="${action}"]`).isEnabled(),'cancelled microphone requests must restore playback controls before the old request settles');
    assert(await page.locator('#record-button').isEnabled(),'cancelled microphone requests must restore the recording button');
    assert.equal(await page.locator('#recording-playback').evaluate(player=>player.controls),true,'cancelling the microphone request must restore the saved recording controls');
    await page.evaluate(()=>window.__speechMic.resolve());
    await page.waitForFunction(()=>window.__speechMic.streams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')));
    assert(!(await page.locator('#record-button').innerText()).includes('结束录音'),'a stale permission result must not start recording');
    await page.waitForTimeout(8500);
    assert.equal(await playCount(),cancelledStart+cancelledSessions,'cancelled waits must never resume old demonstrations');
    passed.push('phrase/task/navigation/manual/background/recording cancellation stops all delayed replays');
    passed.push('pending and active fake-microphone recording blocks every demonstration action');
    passed.push('background cancellation restores controls and discards a stale microphone grant');

    for(const width of [390,768]){
      await page.setViewportSize({width,height:1000});
      for(const skill of ['listen','read']){
        await enter(skill);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${skill} overflows at ${width}px`);
        const slowButton=page.locator(`[data-action="${skill==='read'?'play-phrase-slow':'play-word-slow'}"]`);
        const bounds=await slowButton.boundingBox();assert(bounds.width>=44&&bounds.height>=44,'slow playback needs a usable touch target');
      }
    }
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__speechTrace.errors),[]);
    passed.push('390/768px speech controls and touch targets');
    console.log(JSON.stringify({passed,realAudioDecoding:true,allDemonstrationsMuted:true,fakeMicrophoneOnly:true,url:base}));
    await context.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
