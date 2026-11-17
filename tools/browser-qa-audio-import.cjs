const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chooseTestProfile}=require('./profile-test-helpers.cjs');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:4173';

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--enable-unsafe-swiftshader','--mute-audio']});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block'});
    await context.addInitScript(()=>{
      const NativeAudio=window.Audio;
      window.__qaPlays=[];
      window.Audio=function(...args){
        const audio=new NativeAudio(...args),nativePlay=audio.play.bind(audio);
        audio.play=()=>{const entry={src:audio.src,started:false,audio};window.__qaPlays.push(entry);return nativePlay().then(()=>{entry.started=true;});};
        return audio;
      };
      window.Audio.prototype=NativeAudio.prototype;
    });
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(base);await chooseTestProfile(page,'测试');
    const skip=page.locator('[data-story-action="skip"]');if(await skip.isVisible())await skip.click();
    await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="listen"]').click();
    await page.locator('[data-answer]').first().waitFor();
    const word=await page.evaluate(()=>window.__wordIsland.getState().activeWordId);
    const play=async()=>{
      const count=await page.evaluate(()=>window.__qaPlays.length);
      await page.locator('[data-action="play-word"]').click();
      await page.waitForFunction(count=>window.__qaPlays[count]?.started&&window.__qaPlays[count].audio.currentTime>.01,count);
      return page.evaluate(count=>window.__qaPlays[count].src,count);
    };
    const importFile=async buffer=>{
      await page.locator('#parent-button').click();
      await page.locator('#import-audio').setInputFiles({name:`${word}.m4a`,mimeType:'audio/mp4',buffer});
      await page.waitForFunction(()=>document.querySelector('#import-audio').value===''&&document.querySelector('#audio-import-status').textContent.includes('已保存'));
      const message=await page.locator('#audio-import-status').innerText();
      await page.locator('[data-close="parent-dialog"]').click();
      return message;
    };
    assert((await play()).endsWith(`/word-${word}.m4a`),'the bundled word demonstration must decode before importing');
    const bad=Buffer.from('This is not a playable audio file.');
    const rejected=await importFile(bad);
    assert.match(rejected,/已保存 0 段/,'invalid audio must be rejected before replacing the bundled demonstration');
    assert((await play()).endsWith(`/word-${word}.m4a`),'a bad file must leave bundled speech available');
    const valid=fs.readFileSync(path.resolve('assets/audio/word-milk.m4a'));
    const accepted=await importFile(valid);assert.match(accepted,/已保存 1 段/);
    assert((await play()).startsWith('blob:'),'a valid local import must still take precedence and actually decode');
    const rejectedAgain=await importFile(bad);assert.match(rejectedAgain,/已保存 0 段/);
    assert((await play()).startsWith('blob:'),'rejecting a bad replacement must preserve the earlier valid recording');
    // Fixture-backed compatibility branch: emulate an unreadable clip saved by
    // an older app. This intentionally bypasses the now-validating import UI.
    await page.evaluate(async word=>{const m=await import('./src/storage.js');await m.putClip(`word:${word}`,new Blob(['legacy unreadable audio'],{type:'audio/mp4'}));},word);
    await page.reload();await chooseTestProfile(page);
    await page.locator('[data-nav="camp"]').first().click();await page.locator('[data-task="listen"]').click();await page.locator('[data-answer]').first().waitFor();
    const legacyStart=await page.evaluate(()=>window.__qaPlays.length);
    await page.locator('[data-action="play-word"]').click();
    await page.waitForFunction(({index,word})=>window.__qaPlays.slice(index).some(entry=>entry.started&&entry.src.endsWith(`/word-${word}.m4a`)&&entry.audio.currentTime>.01),{index:legacyStart,word});
    assert.match(await page.locator('#toast').innerText(),/内置示范/);
    const legacyBlob=await page.evaluate(async word=>(await(await import('./src/storage.js')).getClip(`word:${word}`)).text(),word);
    assert.equal(legacyBlob,'legacy unreadable audio','the fallback must not delete the original imported file');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:['real bundled speech before import','corrupt audio rejected without replacing bundled speech','valid imported AAC actually plays','corrupt replacement preserves existing valid import','FIXTURE_BACKED old unreadable import falls back to real bundled speech without deleting original'],realAudioDecoding:true,url:base}));
    await context.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
