import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMPANIONS, MAX_REWARD_DAYS, companionIdsForRewardCount } from '../src/companions.js';
import { createInitialProgress, validateProgress, getDailyPlan, applyAnswer, completeDailyAdventure } from '../src/learning.js';
import { exportProgress, importProgress } from '../src/storage.js';

const v1Fixture=JSON.parse(await readFile(new URL('./fixtures/kb2-v1-progress.json',import.meta.url),'utf8'));
const dateAt=index=>{
  const date=new Date('2027-01-01T12:00:00.000Z');
  date.setUTCDate(date.getUTCDate()+index*2);
  return date.toISOString().slice(0,10);
};
function finishPlan(progress,dateKey) {
  for(const item of getDailyPlan(progress,dateKey).required)
    progress=applyAnswer(progress,{...item,dateKey,correct:true,usedHint:false});
  return progress;
}
function played(days) {
  let progress=createInitialProgress();
  for(let i=0;i<days;i++)progress=completeDailyAdventure(finishPlan(progress,dateAt(i)),dateAt(i)).progress;
  return progress;
}
function v2Save() {
  const old=structuredClone(v1Fixture);
  old.version=2;old.selectedUnitId='kb3-u4';delete old.courseId;
  for(const day of Object.values(old.days))day.plan.unitId='kb2-u6';
  return old;
}

test('the current save format starts at v3 with the first seven-clue journey',()=>{
  const progress=createInitialProgress();
  assert.equal(progress.version,3);
  assert.deepEqual(progress.companions,[]);
  assert.deepEqual(progress.rewardDates,[]);
  assert.deepEqual(validateProgress(progress),progress);
});

test('eight partners unlock in catalog order on distinct seven-day boundaries, with an idempotent 56-day cap',()=>{
  assert.equal(MAX_REWARD_DAYS,56);
  let progress=createInitialProgress();
  for(let index=0;index<MAX_REWARD_DAYS;index++) {
    const date=dateAt(index);
    const ready=finishPlan(progress,date),before=structuredClone(ready);
    const result=completeDailyAdventure(ready,date);
    assert.equal(result.rewarded,true,`day ${index+1}`);
    const boundary=(index+1)%7===0;
    assert.equal(result.companionUnlocked,boundary);
    assert.equal(result.unlockedCompanionId,boundary?COMPANIONS[Math.floor(index/7)].id:null);
    assert.deepEqual(ready,before,'completion must not mutate its input');
    progress=result.progress;
    assert.deepEqual(progress.companions,companionIdsForRewardCount(index+1));
    if(boundary) {
      const repeat=completeDailyAdventure(progress,date);
      assert.equal(repeat.rewarded,false);
      assert.equal(repeat.companionUnlocked,false);
      assert.equal(repeat.unlockedCompanionId,null);
      assert.deepEqual(repeat.progress,progress);
      assert.deepEqual(validateProgress(progress),progress);
    }
  }
  assert.deepEqual(progress.companions,['bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox']);
  const last=completeDailyAdventure(finishPlan(progress,dateAt(56)),dateAt(56));
  assert.equal(last.rewarded,false);
  assert.equal(last.unlockedCompanionId,null);
  assert.equal(last.progress.rewardDates.length,56);
  assert.equal(last.progress.days[dateAt(56)].completed,true);
  assert.deepEqual(last.progress.companions,progress.companions);
  assert.deepEqual(validateProgress(last.progress),last.progress);
  const overCap=structuredClone(last.progress);
  overCap.rewardDates.push(dateAt(56));
  assert.throws(()=>validateProgress(overCap),'even a completed 57th date cannot be imported as an extra clue');
});

test('an incomplete day cannot create a clue or a partner even when the seventh clue is next',()=>{
  const progress=played(6);
  const result=completeDailyAdventure(progress,dateAt(6));
  assert.equal(result.rewarded,false);
  assert.equal(result.companionUnlocked,false);
  assert.equal(result.unlockedCompanionId,null);
  assert.deepEqual(result.progress,progress);
});

test('v1 and v2 migrate purely to v3 while preserving words, selection, old dates and the bunny',()=>{
  for(const original of [structuredClone(v1Fixture),v2Save()]) {
    const before=structuredClone(original);
    const next=validateProgress(original);
    assert.equal(next.version,3);
    assert.equal(next.selectedUnitId,original.version===1?'kb3-hello':'kb3-u4');
    assert.deepEqual(next.words,original.words);
    assert.deepEqual(next.rewardDates,original.rewardDates);
    assert.deepEqual(next.companions,['bunny']);
    assert.deepEqual(original,before);
    assert.deepEqual(importProgress(exportProgress(next)),next);
  }
});

test('an old completed day after the former cap is not retroactively rewarded; the next new date continues the journey',()=>{
  let old=v2Save();
  const cappedDate='2026-11-15';
  old=finishPlan(old,cappedDate);
  old.days[cappedDate].completed=true;
  const migrated=validateProgress(old);
  assert.equal(migrated.version,3);
  assert.equal(migrated.rewardDates.length,7);
  const repeated=completeDailyAdventure(migrated,cappedDate);
  assert.equal(repeated.rewarded,false,'revisiting an already-finished historical date is not a new learning day');
  assert.deepEqual(repeated.progress,migrated);
  const nextDate='2026-11-17';
  const continued=completeDailyAdventure(finishPlan(migrated,nextDate),nextDate);
  assert.equal(continued.rewarded,true);
  assert.equal(continued.progress.rewardDates.length,8);
  assert.deepEqual(continued.progress.companions,['bunny']);
});

test('old formats retain the old seven-clue boundary, and current partner records must match the exact earned order',()=>{
  for(const old of [structuredClone(v1Fixture),v2Save()]) {
    const expanded=structuredClone(old);
    expanded.rewardDates.push('2026-11-15');
    assert.throws(()=>validateProgress(expanded));
    const invalidPartners=structuredClone(old);
    invalidPartners.companions.push('squirrel');
    assert.throws(()=>validateProgress(invalidPartners));
  }
  const current=played(14);
  assert.deepEqual(validateProgress(current),current);
  for(const companions of [[],['bunny'],['squirrel','bunny'],['bunny','bunny'],['bunny','unknown']])
    assert.throws(()=>validateProgress({...current,companions}));
  const duplicate=structuredClone(current);duplicate.rewardDates.push(current.rewardDates[0]);
  assert.throws(()=>validateProgress(duplicate));
});
