import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesSpelling, answerChoices } from '../src/practice.js';

test('spelling checks the displayed English, not its storage slug', () => {
  const word={id:'get-up',en:'get up'};
  assert(matchesSpelling(word,'  GET   UP  '));
  assert(!matchesSpelling(word,'get-up'));
  assert(matchesSpelling({id:'t-shirt',en:'T-shirt',accepted:['t shirt']},'T SHIRT'));
  assert(!matchesSpelling({id:'uncle',en:'uncle'},'aunt'));
});

test('listening choices remain stable, unique in meaning, and include the target once', () => {
  const target={id:'aunt',en:'aunt',zh:'姑姑；姨妈'};
  const pool=[target,{id:'uncle',en:'uncle',zh:'叔叔；舅舅'},{id:'cousin',en:'cousin',zh:'堂兄弟姐妹'},{id:'aunt-duplicate',en:'auntie',zh:'姑姑；姨妈'}];
  const choices=answerChoices(target,pool,[], '2026-11-15');
  assert.equal(choices.length,3);
  assert.equal(choices.filter(choice=>choice.id===target.id).length,1);
  assert.equal(new Set(choices.map(choice=>choice.zh)).size,3);
  assert.deepEqual(choices,answerChoices(target,pool,[],'2026-11-15'));
});
