import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialProgress, validateProgress, localDateKey, getDailyPlan,
  applyAnswer, completeDailyAdventure,
} from '../src/learning.js';
import { WORDS, CLUES, PHRASES, getWord } from '../src/content.js';

function finishPlan(progress, dateKey) {
  for (const item of getDailyPlan(progress, dateKey).required) {
    progress = applyAnswer(progress, { ...item, correct: true, usedHint: false, dateKey });
  }
  return progress;
}

test('content is local, has ten source-theme words and labels supplementary sentences', () => {
  assert.equal(WORDS.length, 10);
  assert.equal(getWord('chicken').zh, '鸡肉');
  assert.equal(CLUES.length, 7);
  assert.ok(PHRASES.every(phrase => phrase.source.includes('补充示例')));
});

test('local date keys follow device local calendar, including month boundaries', () => {
  assert.equal(localDateKey(new Date(2026, 0, 31, 23, 59)), '2026-01-31');
  assert.equal(localDateKey(new Date(2026, 1, 1, 0, 1)), '2026-02-01');
  assert.throws(() => localDateKey(new Date('invalid')));
});

test('daily plan has at most five new words and stays stable as answers arrive', () => {
  const original = createInitialProgress();
  const before = structuredClone(original);
  const plan = getDailyPlan(original, '2026-01-31');
  assert.equal(plan.newWordIds.length, 3);
  assert.equal(plan.required.length, 6);
  const answered = applyAnswer(original, {
    ...plan.required[0], correct: true, usedHint: false, dateKey: plan.dateKey,
  });
  assert.deepEqual(original, before, 'pure operations must preserve the source object');
  assert.deepEqual(getDailyPlan(answered, plan.dateKey), plan);
  assert.deepEqual(getDailyPlan(answered, plan.dateKey), getDailyPlan(answered, plan.dateKey));
  const externalPlan = getDailyPlan(answered, plan.dateKey);
  externalPlan.wordIds.length = 0;
  assert.deepEqual(getDailyPlan(answered, plan.dateKey), plan, 'a returned plan cannot mutate saved daily work');
});

test('listening and spelling have separate practice and due records', () => {
  const progress = applyAnswer(createInitialProgress(), {
    wordId: 'milk', skill: 'listen', correct: true, usedHint: false, dateKey: '2026-01-31',
  });
  assert.equal(progress.words.milk.listen.attempts, 1);
  assert.equal(progress.words.milk.listen.due, '2026-02-01');
  assert.equal(progress.words.milk.spell.attempts, 0);
  assert.equal(progress.words.milk.spell.due, null);
});

test('incomplete or incorrect-only practice cannot earn a reward', () => {
  let progress = createInitialProgress();
  assert.equal(completeDailyAdventure(progress, '2026-11-14').rewarded, false);
  for (const item of getDailyPlan(progress, '2026-11-14').required) {
    progress = applyAnswer(progress, { ...item, correct: false, usedHint: false, dateKey: '2026-11-14' });
  }
  assert.equal(completeDailyAdventure(progress, '2026-11-14').rewarded, false);
  const last = getDailyPlan(progress, '2026-11-14').required.at(-1);
  for (const item of getDailyPlan(progress, '2026-11-14').required.slice(0, -1)) {
    progress = applyAnswer(progress, { ...item, correct: true, usedHint: true, dateKey: '2026-11-14' });
  }
  assert.equal(completeDailyAdventure(progress, '2026-11-14').rewarded, false);
  progress = applyAnswer(progress, { ...last, correct: true, usedHint: true, dateKey: '2026-11-14' });
  assert.equal(completeDailyAdventure(progress, '2026-11-14').rewarded, true);
});

test('same local day is idempotent and first reward is counted only once', () => {
  const finished = finishPlan(createInitialProgress(), '2026-11-14');
  const first = completeDailyAdventure(finished, '2026-11-14');
  assert.equal(first.rewarded, true);
  assert.equal(first.companionUnlocked, false);
  assert.deepEqual(first.progress.rewardDates, ['2026-11-14']);
  const repeated = completeDailyAdventure(first.progress, '2026-11-14');
  assert.equal(repeated.rewarded, false);
  assert.deepEqual(repeated.progress, first.progress);
});

test('seven nonconsecutive local days unlock one persistent bunny; later days cap rewards', () => {
  let progress = createInitialProgress();
  const dates = ['2026-01-29', '2026-01-31', '2026-02-02', '2026-02-05', '2026-02-09', '2026-03-01', '2026-03-03'];
  for (const [index, dateKey] of dates.entries()) {
    progress = finishPlan(progress, dateKey);
    const result = completeDailyAdventure(progress, dateKey);
    assert.equal(result.rewarded, true);
    assert.equal(result.companionUnlocked, index === 6);
    progress = result.progress;
    assert.deepEqual(validateProgress(progress), progress);
  }
  assert.deepEqual(progress.companions, ['bunny']);
  assert.deepEqual(progress.rewardDates, dates);
  const eighth = completeDailyAdventure(finishPlan(progress, '2026-03-09'), '2026-03-09');
  assert.equal(eighth.rewarded, false);
  assert.equal(eighth.progress.rewardDates.length, 7);
  assert.deepEqual(eighth.progress.companions, ['bunny']);
  assert.equal(eighth.progress.days['2026-03-09'].completed, true);
  assert.deepEqual(validateProgress(eighth.progress), eighth.progress);
});

test('due reviews take priority; errors and hints schedule an earlier return', () => {
  let progress = finishPlan(createInitialProgress(), '2026-01-30');
  progress = finishPlan(progress, '2026-01-31');
  assert.equal(progress.words.milk.listen.due, '2026-02-03');
  progress = applyAnswer(progress, {
    wordId: 'milk', skill: 'listen', correct: false, usedHint: false, dateKey: '2026-01-31',
  });
  assert.equal(progress.words.milk.listen.due, '2026-02-01');
  const tomorrow = getDailyPlan(progress, '2026-02-01');
  assert.equal(tomorrow.reviewWordIds[0], 'milk');
  progress = applyAnswer(progress, {
    wordId: 'milk', skill: 'listen', correct: true, usedHint: true, dateKey: '2026-02-01',
  });
  assert.equal(progress.words.milk.listen.due, '2026-02-02');
});

test('repeating a correct answer on one day does not inflate review intervals', () => {
  let progress = createInitialProgress();
  const answer = {wordId: 'milk', skill: 'listen', correct: true, usedHint: false, dateKey: '2026-01-31'};
  progress = applyAnswer(progress, answer);
  const due = progress.words.milk.listen.due;
  progress = applyAnswer(progress, answer);
  assert.equal(progress.words.milk.listen.due, due);
  assert.equal(progress.words.milk.listen.streak, 1);
});

test('import accepts its own JSON round trip as an independent copy', () => {
  const original = completeDailyAdventure(finishPlan(createInitialProgress(), '2026-11-14'), '2026-11-14').progress;
  const imported = validateProgress(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(imported, original);
  imported.rewardDates.push('2026-11-15');
  assert.equal(original.rewardDates.length, 1);
});

test('import rejects incompatible, invalid dates, duplicates and invented reward progress', () => {
  const base = createInitialProgress();
  assert.throws(() => validateProgress(null));
  assert.throws(() => validateProgress({ ...base, version: 99 }));
  assert.throws(() => validateProgress({ ...base, rewardDates: ['2026-02-30'] }));
  assert.throws(() => validateProgress({ ...base, rewardDates: ['2026-11-14', '2026-11-14'] }));
  assert.throws(() => validateProgress({ ...base, companions: ['bunny'] }));
  assert.throws(() => validateProgress({ ...base, rewardDates: ['2026-11-14'] }));
  assert.throws(() => validateProgress({ ...base, words: { invented: {} } }));
  const completed = completeDailyAdventure(finishPlan(base, '2026-11-14'), '2026-11-14').progress;
  completed.days['2026-11-14'].plan.required.pop();
  assert.throws(() => validateProgress(completed));
  assert.throws(() => getDailyPlan(base, '2026-02-30'));
});

test('hinted practice does not increase the number of new words in a later plan', () => {
  let progress = createInitialProgress();
  const dateKey = '2026-01-31';
  // Practising one optional word must not imply readiness for five new words.
  for (let repeat = 0; repeat < 3; repeat += 1) {
    for (const skill of ['listen', 'spell']) {
      progress = applyAnswer(progress, { wordId: 'milk', skill, correct: true, usedHint: true, dateKey });
    }
  }
  const next = getDailyPlan(progress, '2026-02-01');
  assert.equal(next.reviewWordIds.length, 1);
  assert.equal(next.newWordIds.length, 3);
});
