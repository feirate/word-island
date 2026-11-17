import test from 'node:test';
import assert from 'node:assert/strict';
import { readGuide, nextIntro, endGuide, guidePrompt, adventurePrompt, INTRO_COUNT } from '../src/story.js';

const home = { page:'home', phase:'overview', listenDone:false, spellDone:false, readDone:false, dailyFinished:false, clueCount:0 };

test('a first visit introduces the island, the purpose, the route and seven kept clues at the child’s pace', () => {
  let guide=readGuide(null);
  const ids=[];
  for(let i=0;i<INTRO_COUNT;i++) {
    const prompt=guidePrompt(guide,home);
    ids.push(prompt.id);
    assert.equal(prompt.action,'next');
    assert(prompt.text.length<100);
    guide=nextIntro(guide);
  }
  assert.equal(new Set(ids).size,4);
  assert.equal(guidePrompt(guide,home).id,'depart');
  assert.equal(guidePrompt(guide,home).action,'camp');
  assert.equal(nextIntro(guide).intro,INTRO_COUNT);
});

test('guidance follows real learning work without advancing or inventing any answers or rewards', () => {
  let guide=readGuide(null);
  for(let i=0;i<INTRO_COUNT;i++)guide=nextIntro(guide);
  const context={...home,page:'camp'};
  const before=structuredClone(context);
  assert.equal(guidePrompt(guide,context).action,'listen');
  assert.deepEqual(context,before);
  assert.equal(guidePrompt(guide,{...context,phase:'listen'}).action,'practice');
  assert.equal(guidePrompt(guide,{...context,listenDone:true}).action,'spell');
  assert.equal(guidePrompt(guide,{...context,listenDone:true,spellDone:true}).action,'read');
  assert.equal(guidePrompt(guide,{...context,listenDone:true,spellDone:true,readDone:true}).action,'collect');
  assert.equal(guidePrompt(guide,{...context,dailyFinished:true,clueCount:1}).action,'home');
  assert.equal(guidePrompt(guide,{...home,dailyFinished:true,clueCount:1}).action,'finish');
});

test('skip and finish persist independently; malformed local guide settings recover safely', () => {
  const initial=readGuide(null);
  for(const status of ['skipped','finished']) {
    const ended=endGuide(initial,status);
    assert.equal(guidePrompt(readGuide(JSON.stringify(ended)),home),null);
    assert.equal(adventurePrompt(home).action,'camp','asking the character still gives a useful next step');
  }
  for(const raw of ['{',JSON.stringify({version:9,status:'active',intro:0}),JSON.stringify({version:1,status:'active',intro:-1}),JSON.stringify({version:1,status:'active',intro:99})])assert.deepEqual(readGuide(raw),initial);
  assert.deepEqual(initial,{version:1,status:'active',intro:0});
});

test('free practice and book browsing stay free of daily guidance; seven-clue welcome matches the unlocked story', () => {
  const guide={version:1,status:'active',intro:INTRO_COUNT};
  assert.equal(guidePrompt(guide,{...home,phase:'books'}),null);
  assert.equal(guidePrompt(guide,{...home,page:'growth'}),null);
  assert.equal(guidePrompt(guide,{...home,page:'camp',freePractice:true}),null);
  const returned=guidePrompt(guide,{...home,dailyFinished:true,clueCount:7});
  assert.match(returned.text,/团团/);
  assert.equal(returned.action,'finish');
});

test('a child choosing tasks in a different order gets help for the task already open', () => {
  const guide={version:1,status:'active',intro:INTRO_COUNT};
  for(const skill of ['listen','spell','read']) {
    const prompt=guidePrompt(guide,{...home,page:'camp',phase:skill});
    assert.equal(prompt.id,`${skill}-help`);
    assert.equal(prompt.action,'practice');
  }
});

test('later companion rounds describe the current friend rather than repeating the first bunny welcome',()=>{
  const context={...home,dailyFinished:true};
  assert.match(adventurePrompt({...context,clueCount:10}).text,/栗栗/);
  assert.match(adventurePrompt({...context,clueCount:14}).text,/栗栗/);
  assert.match(adventurePrompt({...context,clueCount:14}).text,/米米/);
  assert.match(adventurePrompt({...context,clueCount:56}).text,/八位/);
});
