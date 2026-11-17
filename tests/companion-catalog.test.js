import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPANIONS, MAX_REWARD_DAYS, companionIdsForRewardCount, getCompanion, getCompanionJourney, getCompanionState, getClueForReward } from '../src/companions.js';

test('the first season has the eight requested animals with real model paths and seven individual clues each',()=>{
  assert.deepEqual(COMPANIONS.map(p=>p.id),['bunny','squirrel','cat','dog','hedgehog','turtle','raccoon','fox']);
  assert.equal(MAX_REWARD_DAYS,56);
  for(const pet of COMPANIONS){
    assert(pet.name&&pet.species&&pet.message&&pet.personality);
    assert.match(pet.modelFile,/\.glb$/);
    assert.equal(pet.home.length,3);assert(pet.scale>0);
    assert.equal(pet.clues.length,7);
    assert(pet.clues.every(clue=>clue.title&&clue.description));
  }
  assert.equal(getCompanion('bunny').name,'团团');
  assert.notEqual(getCompanion('fox').name,'芽芽');
});

test('gallery status and the seven-clue display follow a shared reward history across all companions',()=>{
  for(const count of [0,3,7,10,14,55,56]){
    const progress={rewardDates:Array(count).fill('date'),companions:companionIdsForRewardCount(count)};
    const journey=getCompanionJourney(progress);
    assert.equal(journey.roundCount,count===56?7:count%7);
    assert.equal(journey.current?.id,COMPANIONS[Math.floor(count/7)]?.id);
    assert.equal(progress.companions.length,Math.floor(count/7));
    for(const pet of COMPANIONS){
      const state=getCompanionState(progress,pet.id);
      assert.equal(state.status,progress.companions.includes(pet.id)?'unlocked':journey.current?.id===pet.id?'current':'locked');
    }
  }
});

test('a collected clue belongs to its exact companion round, retaining the original first encounter',()=>{
  assert.equal(getClueForReward(0).title,'两排小脚印');
  assert.equal(getClueForReward(6).companion.id,'bunny');
  assert.equal(getClueForReward(7).companion.id,'squirrel');
  assert.equal(getClueForReward(55).companion.id,'fox');
  assert.throws(()=>getClueForReward(56));
  assert.throws(()=>companionIdsForRewardCount(-1));
  assert.throws(()=>companionIdsForRewardCount(57));
});
