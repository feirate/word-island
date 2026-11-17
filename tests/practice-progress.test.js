import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialProgress, selectUnit, getDailyPlan, beginDailyAdventure,
  applyAnswer, applyPracticeAnswer, completeDailyAdventure, validateProgress,
} from '../src/learning.js';
import { exportProgress, importProgress } from '../src/storage.js';

const answer={wordId:'milk',skill:'listen',correct:true,usedHint:false,dateKey:'2026-11-16'};

test('free practice records both skills without freezing an unstarted daily adventure',()=>{
  const original=createInitialProgress();
  const before=structuredClone(original);
  let progress=applyPracticeAnswer(original,answer);
  progress=applyPracticeAnswer(progress,{...answer,skill:'spell'});
  assert.deepEqual(original,before,'practice must not mutate the previous save');
  assert.deepEqual(progress.days,{});
  assert.deepEqual(progress.rewardDates,[]);
  assert.deepEqual(progress.companions,[]);
  assert.equal(progress.words.milk.listen.attempts,1);
  assert.equal(progress.words.milk.spell.correct,1);
  assert.equal(progress.words.milk.listen.due,'2026-11-17');
  assert.equal(progress.words.milk.spell.due,'2026-11-17');
  progress=selectUnit(progress,'kb3-u1');
  assert.equal(getDailyPlan(progress,answer.dateKey).unitId,'kb3-u1');
  assert.equal(completeDailyAdventure(progress,answer.dateKey).rewarded,false);
});

test('free practice leaves a started daily plan and its required answers untouched',()=>{
  let progress=beginDailyAdventure(createInitialProgress('kb2-u6'),answer.dateKey);
  const first=getDailyPlan(progress,answer.dateKey).required[0];
  progress=applyAnswer(progress,{...first,dateKey:answer.dateKey,correct:true});
  const days=structuredClone(progress.days);
  const required=getDailyPlan(progress,answer.dateKey).required;
  for(const item of required)progress=applyPracticeAnswer(progress,{...item,dateKey:answer.dateKey,correct:true});
  assert.deepEqual(progress.days,days,'optional answers must not complete any daily requirement');
  assert.equal(completeDailyAdventure(progress,answer.dateKey).rewarded,false);
  assert.deepEqual(progress.rewardDates,[]);
  assert.deepEqual(progress.companions,[]);
});

test('free-practice errors and hints keep reviews near without inflating a same-day streak',()=>{
  let progress=createInitialProgress();
  progress=applyPracticeAnswer(progress,{...answer,dateKey:'2026-11-14'});
  progress=applyPracticeAnswer(progress,{...answer,dateKey:'2026-11-15'});
  assert.equal(progress.words.milk.listen.streak,2);
  assert.equal(progress.words.milk.listen.due,'2026-11-18');
  progress=applyPracticeAnswer(progress,{...answer,dateKey:'2026-11-15',correct:false});
  progress=applyPracticeAnswer(progress,{...answer,dateKey:'2026-11-15'});
  assert.equal(progress.words.milk.listen.streak,0);
  assert.equal(progress.words.milk.listen.due,'2026-11-16');
  progress=applyPracticeAnswer(progress,{...answer,usedHint:true});
  progress=applyPracticeAnswer(progress,answer);
  assert.equal(progress.words.milk.listen.streak,0);
  assert.equal(progress.words.milk.listen.due,'2026-11-17');
  assert.equal(progress.words.milk.listen.attempts,6);
  assert.equal(progress.words.milk.listen.correct,5);
  assert(getDailyPlan(progress,'2026-11-17').reviewWordIds.includes('milk'));
});

test('practice after a completed adventure preserves rewards, companions and completed-day evidence',()=>{
  let progress=createInitialProgress('kb2-u6');
  for(const item of getDailyPlan(progress,answer.dateKey).required)
    progress=applyAnswer(progress,{...item,dateKey:answer.dateKey,correct:true});
  progress=completeDailyAdventure(progress,answer.dateKey).progress;
  const days=structuredClone(progress.days),rewards=[...progress.rewardDates],companions=[...progress.companions];
  progress=applyPracticeAnswer(progress,{...answer,correct:false});
  assert.deepEqual(progress.days,days);
  assert.deepEqual(progress.rewardDates,rewards);
  assert.deepEqual(progress.companions,companions);
  assert.equal(completeDailyAdventure(progress,answer.dateKey).rewarded,false);
  assert.deepEqual(validateProgress(progress),progress);
});

test('practice-only progress survives validation and backup round trips without invented days',()=>{
  let progress=applyPracticeAnswer(createInitialProgress(),answer);
  progress=applyPracticeAnswer(progress,{...answer,skill:'spell',correct:false});
  assert.deepEqual(validateProgress(JSON.parse(JSON.stringify(progress))),progress);
  assert.deepEqual(importProgress(exportProgress(progress)),progress);
  assert.deepEqual(progress.days,{});
  for(const invalid of [
    {...answer,wordId:'invented'}, {...answer,skill:'read'}, {...answer,correct:'yes'},
    {...answer,usedHint:'yes'}, {...answer,dateKey:'2026-02-30'},
  ])assert.throws(()=>applyPracticeAnswer(progress,invalid));
});
