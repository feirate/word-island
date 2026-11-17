import test from 'node:test';
import assert from 'node:assert/strict';
import { COURSES, UNITS, DEFAULT_UNIT_ID, getUnit, getWordsForUnit, getPhrasesForUnit, getWord, getPhrase } from '../src/content.js';

test('the supplied KB3 starts at Hello and exposes all eight main units', () => {
  assert.equal(DEFAULT_UNIT_ID, 'kb3-hello');
  const kb3 = COURSES.find(book => book.id === 'kb3');
  assert.deepEqual(kb3.units.map(unit => unit.id), ['kb3-hello',...Array.from({length:8},(_,i)=>`kb3-u${i+1}`)]);
  assert.equal(getUnit(DEFAULT_UNIT_ID).unitTitle, 'Hello!');
  assert(UNITS.some(unit => unit.id === 'kb2-u6'));
});

test('every selectable unit resolves real vocabulary and its own supplementary phrases', () => {
  for (const unit of UNITS) {
    const words=getWordsForUnit(unit.id), phrases=getPhrasesForUnit(unit.id);
    assert(words.length>=3,unit.id);
    assert(phrases.length>=1,unit.id);
    assert(words.every(word => getWord(word.id) === word && word.en && word.zh));
    assert(phrases.every(phrase => getPhrase(phrase.id) === phrase));
    assert.equal(new Set(words.map(word=>word.id)).size,words.length);
  }
  assert.equal(getWord('milk').en,'milk');
  assert.equal(getPhrase('milk-breakfast').en,'I have milk for breakfast.');
});
