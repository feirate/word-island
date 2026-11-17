import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_UNIT_ID, UNITS, getUnit, getWordsForUnit, getPhrasesForUnit } from '../src/content.js';
import {
  createInitialProgress, validateProgress, selectUnit, beginDailyAdventure,
  getDailyPlan, applyAnswer, completeDailyAdventure,
} from '../src/learning.js';
import { loadProgress, exportProgress, importProgress } from '../src/storage.js';

// Generated with the shipped v1 engine at 469de4ac907fbbae880dedf106b3ab120b0991fe:
// seven nonconsecutive completed days, ten learned words, and an initial incorrect answer.
const legacyFixture = JSON.parse(await readFile(new URL('./fixtures/kb2-v1-progress.json', import.meta.url), 'utf8'));

function finishDay(progress, dateKey) {
  for (const item of getDailyPlan(progress, dateKey).required) {
    progress = applyAnswer(progress, { ...item, dateKey, correct: true, usedHint: false });
  }
  return completeDailyAdventure(progress, dateKey).progress;
}

// The old v1 shape is frozen here: no selectedUnitId and no per-plan unitId.
function legacyProgress() {
  return structuredClone(legacyFixture);
}

test('new progress starts at the confirmed KB3 opening while an explicit unit remains available', () => {
  const progress = createInitialProgress();
  assert.equal(progress.version, 3);
  assert.equal(progress.selectedUnitId, 'kb3-hello');
  assert.equal(progress.selectedUnitId, DEFAULT_UNIT_ID);
  assert.equal(Object.hasOwn(progress, 'courseId'), false);
  assert.equal(createInitialProgress('kb2-u6').selectedUnitId, 'kb2-u6');
  assert.throws(() => createInitialProgress('not-a-unit'), /单元|教材/);
});

test('a valid v1 save migrates without losing old words, daily work, seven rewards or the bunny', () => {
  const legacy = legacyProgress();
  const before = structuredClone(legacy);
  const migrated = validateProgress(legacy);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.selectedUnitId, DEFAULT_UNIT_ID);
  assert.deepEqual(migrated.words, legacy.words);
  assert.equal(Object.keys(migrated.words).length, 10);
  assert.deepEqual(migrated.rewardDates, legacy.rewardDates);
  assert.deepEqual(migrated.companions, ['bunny']);
  assert.equal(Object.hasOwn(migrated, 'courseId'), false);
  for (const [date, day] of Object.entries(legacy.days)) {
    assert.equal(migrated.days[date].plan.unitId, 'kb2-u6');
    const { unitId, ...oldPlan } = migrated.days[date].plan;
    assert.deepEqual(oldPlan, day.plan);
    assert.deepEqual(migrated.days[date].answers, day.answers);
    assert.equal(migrated.days[date].completed, true);
  }
  assert.deepEqual(legacy, before, 'migration is pure and does not rewrite its source');
  assert.deepEqual(validateProgress(migrated), migrated);
});

test('v1 is strictly validated as the old KB2 format before migration', () => {
  const unknownToV1 = getWordsForUnit(DEFAULT_UNIT_ID).find(word => !['milk', 'rice', 'chicken', 'fish', 'chips', 'fruit', 'meat', 'breakfast', 'lunch', 'dinner'].includes(word.id));
  assert.ok(unknownToV1, 'the new opening must provide vocabulary outside the old ten-word unit');
  for (const mutate of [
    progress => { progress.courseId = DEFAULT_UNIT_ID; },
    progress => { progress.selectedUnitId = DEFAULT_UNIT_ID; },
    progress => { progress.words[unknownToV1.id] = structuredClone(progress.words.milk); },
    progress => { progress.days['2026-10-01'].plan.unitId = 'kb2-u6'; },
    progress => { progress.days['2026-10-01'].plan.phraseId = getPhrasesForUnit(DEFAULT_UNIT_ID)[0].id; },
    progress => { progress.days['2026-10-01'].plan.required.pop(); },
    progress => { progress.companions = []; },
  ]) {
    const legacy = legacyProgress(); mutate(legacy);
    assert.throws(() => validateProgress(legacy));
  }
});

test('old local and exported v1 saves remain readable through the unchanged storage entry points', () => {
  const legacy = legacyProgress();
  const oldText = JSON.stringify(legacy);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let writes = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem(key) { assert.equal(key, 'word-island:progress:v1'); return oldText; },
    setItem() { writes += 1; },
  } });
  try {
    const loaded = loadProgress();
    assert.equal(loaded.error, null);
    assert.equal(loaded.progress.version, 3);
    assert.deepEqual(loaded.progress.rewardDates, legacy.rewardDates);
    assert.equal(writes, 0, 'reading or migrating must not silently overwrite the old saved JSON');
    const imported = importProgress(JSON.stringify({ app: 'word-island', version: 1, exportedAt: '2026-11-14T01:00:00.000Z', progress: legacy }));
    assert.deepEqual(imported, loaded.progress);
    assert.deepEqual(importProgress(exportProgress(imported)), imported);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('selecting a unit preserves global growth and does not modify an already-started day', () => {
  const date = '2026-11-15';
  const initial = beginDailyAdventure(createInitialProgress('kb2-u6'), date);
  const oldPlan = getDailyPlan(initial, date);
  const selected = selectUnit(initial, DEFAULT_UNIT_ID);
  assert.equal(selected.selectedUnitId, DEFAULT_UNIT_ID);
  assert.deepEqual(getDailyPlan(selected, date), oldPlan);
  assert.equal(oldPlan.unitId, 'kb2-u6');
  assert.deepEqual(selected.words, initial.words);
  assert.deepEqual(selected.rewardDates, initial.rewardDates);
  assert.deepEqual(selected.companions, initial.companions);
  assert.equal(initial.selectedUnitId, 'kb2-u6');
  assert.deepEqual(validateProgress(selected), selected);
  assert.throws(() => selectUnit(selected, 'unknown-unit'), /单元|教材/);
});

test('beginning a day pins its plan before the first answer and remains idempotent', () => {
  const initial = createInitialProgress();
  const started = beginDailyAdventure(initial, '2026-11-15');
  assert.equal(Object.keys(initial.days).length, 0);
  assert.deepEqual(started.days['2026-11-15'].answers, {});
  assert.equal(started.days['2026-11-15'].completed, false);
  assert.deepEqual(beginDailyAdventure(started, '2026-11-15'), started);
  assert.equal(completeDailyAdventure(started, '2026-11-15').rewarded, false);
  const plan = getDailyPlan(started, '2026-11-15'); plan.wordIds.length = 0;
  assert.ok(started.days['2026-11-15'].plan.wordIds.length > 0);
  assert.deepEqual(validateProgress(started), started);
});

test('new vocabulary and a reading prompt come from the selected unit; due reviews can cross units', () => {
  let progress = applyAnswer(createInitialProgress('kb2-u6'), { wordId: 'milk', skill: 'listen', correct: true, dateKey: '2026-11-14' });
  progress = selectUnit(progress, DEFAULT_UNIT_ID);
  const plan = getDailyPlan(progress, '2026-11-15');
  const unit = getUnit(DEFAULT_UNIT_ID);
  assert.equal(plan.unitId, unit.id);
  assert.ok(plan.reviewWordIds.includes('milk'));
  assert.ok(plan.newWordIds.length > 0);
  assert.ok(plan.newWordIds.every(id => unit.wordIds.includes(id)));
  assert.ok(unit.phraseIds.includes(plan.phraseId));
  assert.ok(plan.wordIds.length <= 5);
  assert.deepEqual(plan, getDailyPlan(progress, '2026-11-15'));
});

test('free practice after changing selection does not substitute for the pinned daily task', () => {
  const date = '2026-11-15';
  let progress = beginDailyAdventure(createInitialProgress('kb2-u6'), date);
  const originalPlan = getDailyPlan(progress, date);
  progress = selectUnit(progress, DEFAULT_UNIT_ID);
  const optional = getWordsForUnit(DEFAULT_UNIT_ID).find(word => !originalPlan.wordIds.includes(word.id));
  assert.ok(optional);
  for (const skill of ['listen', 'spell']) progress = applyAnswer(progress, { wordId: optional.id, skill, correct: true, dateKey: date });
  assert.deepEqual(getDailyPlan(progress, date), originalPlan);
  assert.equal(progress.words[optional.id].listen.correct, 1);
  assert.equal(completeDailyAdventure(progress, date).rewarded, false);
  assert.deepEqual(validateProgress(progress), progress);
});

test('every selectable catalog unit can create and validate a local plan with its own new words and prompt', () => {
  assert.equal(new Set(UNITS.map(unit => unit.id)).size, UNITS.length);
  for (const unit of UNITS) {
    const started = beginDailyAdventure(createInitialProgress(unit.id), '2026-11-15');
    const plan = getDailyPlan(started, '2026-11-15');
    assert.equal(plan.unitId, unit.id);
    assert.ok(plan.wordIds.length > 0 && plan.wordIds.length <= 5, unit.id);
    assert.ok(plan.newWordIds.every(id => unit.wordIds.includes(id)), unit.id);
    assert.ok(unit.phraseIds.includes(plan.phraseId), unit.id);
    assert.deepEqual(validateProgress(started), started);
  }
});

test('current progress preserves its existing selection and rejects unknown units or mismatched historical prompts', () => {
  const alternate = UNITS.find(unit => unit.id !== DEFAULT_UNIT_ID && unit.wordIds.length && unit.phraseIds.length);
  const progress = beginDailyAdventure(createInitialProgress(alternate.id), '2026-11-15');
  assert.equal(validateProgress(progress).selectedUnitId, alternate.id);
  assert.throws(() => validateProgress({ ...progress, selectedUnitId: 'unknown-unit' }));
  assert.throws(() => validateProgress({ ...progress, courseId: 'kb2-u6' }));
  const bad = structuredClone(progress);
  bad.days['2026-11-15'].plan.unitId = 'unknown-unit';
  assert.throws(() => validateProgress(bad));
  const foreign = getPhrasesForUnit(DEFAULT_UNIT_ID).find(phrase => !alternate.phraseIds.includes(phrase.id));
  assert.ok(foreign);
  bad.days['2026-11-15'].plan.unitId = alternate.id;
  bad.days['2026-11-15'].plan.phraseId = foreign.id;
  assert.throws(() => validateProgress(bad));
});

test('seven days across unit changes share one reward history and a single persistent companion', () => {
  let progress = createInitialProgress();
  for (let index = 0; index < 7; index += 1) {
    progress = selectUnit(progress, index % 2 === 0 ? DEFAULT_UNIT_ID : 'kb2-u6');
    progress = finishDay(progress, `2026-11-${String(index + 1).padStart(2, '0')}`);
  }
  assert.equal(progress.rewardDates.length, 7);
  assert.deepEqual(progress.companions, ['bunny']);
  const selected = selectUnit(progress, 'kb2-u6');
  assert.deepEqual(selected.rewardDates, progress.rewardDates);
  assert.deepEqual(selected.companions, ['bunny']);
  assert.deepEqual(selected.words, progress.words);
  assert.deepEqual(validateProgress(selected), selected);
});
