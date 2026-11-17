import test from 'node:test';
import assert from 'node:assert/strict';
import { KB3_UNITS, KB3_WORDS, KB3_PHRASES } from '../src/kb3.js';

const sharedKb2Ids = new Set(['milk', 'rice', 'chicken', 'fish', 'chips', 'fruit', 'meat', 'breakfast', 'lunch', 'dinner']);

test('verified KB3 content covers Hello and eight named units with printed/PDF evidence', () => {
  assert.equal(KB3_UNITS.length, 9);
  assert.deepEqual(KB3_UNITS.map(unit => unit.id), ['kb3-hello', ...Array.from({ length: 8 }, (_, i) => `kb3-u${i + 1}`)]);
  assert.deepEqual(KB3_UNITS.map(unit => unit.unitTitle), ['Hello!', 'Family matters', 'Home sweet home', 'A day in the life', 'In the city', 'Fit and well', 'A day in the country', 'World of animals', 'Weather report']);
  assert.deepEqual(KB3_UNITS.map(unit => unit.printedPages[0]), [2, 8, 16, 26, 34, 44, 52, 62, 70]);
  for (const unit of KB3_UNITS) {
    assert.equal(unit.bookId, 'kb3');
    assert.equal(unit.level, 3);
    assert.deepEqual(unit.pdfPages, unit.printedPages.map(page => page + 7));
    assert.ok(unit.sourceNote.includes('扫描'));
    assert.ok(unit.phonics.title && unit.phonics.description);
    assert.ok(unit.wordIds.length >= (unit.unit === 0 ? 6 : 8) && unit.wordIds.length <= 12);
    assert.equal(unit.maxNewWords, 5);
    assert.equal(unit.phraseIds.length, 2);
  }
});

test('core vocabulary IDs are shared across books with no duplicate definitions', () => {
  const ids = new Set(KB3_WORDS.map(word => word.id));
  assert.equal(ids.size, KB3_WORDS.length);
  for (const word of KB3_WORDS) {
    assert.match(word.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(sharedKb2Ids.has(word.id), false, `${word.id} must reuse the existing KB2 definition`);
    assert.equal(word.en, word.english);
    assert.equal(word.zh, word.chinese);
    assert.ok(word.emoji && word.phonics && word.phrase);
    assert.ok(Number.isInteger(word.sourcePage) && word.sourcePage >= 2 && word.sourcePage <= 79);
    assert.equal(word.sourcePdfPage, word.sourcePage + 7);
  }
  for (const unit of KB3_UNITS) {
    assert.equal(new Set(unit.wordIds).size, unit.wordIds.length);
    for (const id of unit.wordIds) assert.ok(ids.has(id) || sharedKb2Ids.has(id), `${unit.id}: unknown word ${id}`);
  }
});

test('short speaking exercises are explicitly supplementary and all references resolve', () => {
  assert.equal(KB3_PHRASES.length, 18);
  assert.equal(new Set(KB3_PHRASES.map(phrase => phrase.id)).size, 18);
  const words = new Set([...KB3_WORDS.map(word => word.id), ...sharedKb2Ids]);
  for (const phrase of KB3_PHRASES) {
    assert.ok(phrase.en && phrase.zh && phrase.source.includes('软件补充示例句') && phrase.source.includes('非教材原音'));
    for (const id of phrase.wordIds) assert.ok(words.has(id), `${phrase.id}: unknown word ${id}`);
  }
  for (const unit of KB3_UNITS) {
    for (const id of unit.phraseIds) assert.ok(KB3_PHRASES.some(phrase => phrase.id === id));
  }
});
