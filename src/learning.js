import { DEFAULT_UNIT_ID, WORDS, getUnit, getWord, getPhrase, getWordsForUnit, getPhrasesForUnit } from './content.js';
import { MAX_REWARD_DAYS, companionIdsForRewardCount } from './companions.js';

const SKILLS = ['listen', 'spell'];
// A small scheduling heuristic, not a claimed universal forgetting curve.
const REVIEW_DAYS = [1, 3, 7, 14, 30];
const DAILY_WORD_LIMIT = 5;
// This is the frozen vocabulary/schema understood by the shipped v1 application.
const LEGACY_UNIT_ID = 'kb2-u6';
const LEGACY_WORD_IDS = new Set(['milk', 'rice', 'chicken', 'fish', 'chips', 'fruit', 'meat', 'breakfast', 'lunch', 'dinner']);
const copy = value => structuredClone(value);
const emptySkill = () => ({ attempts: 0, correct: 0, streak: 0, due: null, lastDate: null });
const emptyWord = () => ({ listen: emptySkill(), spell: emptySkill() });

function requireUnit(unitId) {
  const unit = getUnit(unitId);
  if (!unit) throw new Error('找不到所选教材单元，请从书架重新选择。');
  return unit;
}

export function createInitialProgress(unitId = DEFAULT_UNIT_ID) {
  requireUnit(unitId);
  return { version: 3, selectedUnitId: unitId, words: {}, days: {}, rewardDates: [], companions: [] };
}

export function selectUnit(progress, unitId) {
  requireUnit(unitId);
  const next = copy(progress);
  next.selectedUnitId = unitId;
  return next;
}

export function localDateKey(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('无效的本地日期。');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function checkDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('日期格式应为 YYYY-MM-DD。');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('日期不存在。');
  return value;
}

function addDays(dateKey, count) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function requiredFor(wordIds) {
  return wordIds.flatMap(wordId => SKILLS.map(skill => ({ wordId, skill })));
}

export function getDailyPlan(progress, dateKey) {
  checkDate(dateKey);
  if (progress.days[dateKey]) return copy(progress.days[dateKey].plan);
  const unit = requireUnit(progress.selectedUnitId);
  const unitWords = getWordsForUnit(unit.id);
  const phrase = getPhrasesForUnit(unit.id)[0];
  if (unitWords.length === 0 || !phrase) throw new Error('这个单元暂时缺少可练习的词语或短句，请选择其他单元。');
  const dueDate = id => {
    const word = progress.words[id];
    return SKILLS.map(skill => word?.[skill].due ?? '0000-01-01').sort()[0];
  };
  const reviewWordIds = WORDS.filter(word => {
    const learned = progress.words[word.id];
    return learned && SKILLS.some(skill => learned[skill].attempts === 0 || learned[skill].due <= dateKey);
  }).map(word => word.id).sort((a, b) => dueDate(a).localeCompare(dueDate(b)) || WORDS.findIndex(w => w.id === a) - WORDS.findIndex(w => w.id === b)).slice(0, DAILY_WORD_LIMIT);
  const recentAnswers = Object.entries(progress.days).filter(([key]) => key < dateKey)
    .sort(([a], [b]) => a.localeCompare(b)).slice(-7)
    .flatMap(([, day]) => Object.values(day.answers).flatMap(answers => Object.values(answers)));
  const independent = recentAnswers.filter(answer => answer.completed && !answer.usedHint && !answer.hadError).length;
  const maximum = Math.min(unit.maxNewWords, DAILY_WORD_LIMIT);
  const newLimit = recentAnswers.length >= 6 && independent / recentAnswers.length >= 0.8 ? maximum : Math.min(3, maximum);
  const newWordIds = unitWords.filter(word => !progress.words[word.id]).slice(0, Math.min(newLimit, DAILY_WORD_LIMIT - reviewWordIds.length)).map(word => word.id);
  const wordIds = [...reviewWordIds, ...newWordIds];
  // Once all words are ahead of schedule, offer a short voluntary review.
  if (wordIds.length === 0) {
    wordIds.push(...unitWords.map(word => word.id).sort((a, b) => dueDate(a).localeCompare(dueDate(b))).slice(0, 3));
    reviewWordIds.push(...wordIds);
  }
  return { dateKey, unitId: unit.id, newWordIds, reviewWordIds, wordIds, required: requiredFor(wordIds), phraseId: phrase.id };
}

export function beginDailyAdventure(progress, dateKey) {
  const plan = getDailyPlan(progress, dateKey);
  const next = copy(progress);
  next.days[dateKey] ??= { plan, answers: {}, completed: false };
  return next;
}

function checkAnswer({ wordId, skill, correct, usedHint, dateKey }) {
  checkDate(dateKey);
  if (!getWord(wordId) || !SKILLS.includes(skill) || typeof correct !== 'boolean' || typeof usedHint !== 'boolean') throw new Error('无效的练习答案。');
}

function recordWordAnswer(next, { wordId, skill, correct, usedHint, hadError = false, dateKey }) {
  next.words[wordId] ??= emptyWord();
  const record = next.words[wordId][skill];
  const sameDay = record.lastDate === dateKey;
  record.attempts += 1;
  if (correct) record.correct += 1;
  if (!correct || usedHint || hadError) record.streak = 0;
  else if (!sameDay) record.streak = Math.min(REVIEW_DAYS.length, record.streak + 1);
  record.due = addDays(dateKey, REVIEW_DAYS[Math.max(0, record.streak - 1)]);
  record.lastDate = dateKey;
}

export function applyPracticeAnswer(progress, { wordId, skill, correct, usedHint = false, dateKey }) {
  const answer = { wordId, skill, correct, usedHint, dateKey };
  checkAnswer(answer);
  const next = copy(progress);
  // Optional practice informs future reviews without starting or completing today's adventure.
  recordWordAnswer(next, answer);
  return next;
}

export function applyAnswer(progress, { wordId, skill, correct, usedHint = false, dateKey }) {
  checkAnswer({ wordId, skill, correct, usedHint, dateKey });
  const plan = getDailyPlan(progress, dateKey);
  const next = copy(progress);
  next.days[dateKey] ??= { plan, answers: {}, completed: false };
  const day = next.days[dateKey];
  day.answers[wordId] ??= {};
  const daily = day.answers[wordId][skill] ?? { attempts: 0, completed: false, usedHint: false, hadError: false };
  daily.attempts += 1;
  daily.completed ||= correct;
  daily.usedHint ||= usedHint;
  daily.hadError ||= !correct;
  day.answers[wordId][skill] = daily;
  recordWordAnswer(next, { wordId, skill, correct, usedHint: daily.usedHint, hadError: daily.hadError, dateKey });
  return next;
}

function isDayComplete(day) {
  return Boolean(day && day.plan.required.length > 0 && day.plan.required.every(({ wordId, skill }) => day.answers[wordId]?.[skill]?.completed));
}

export function completeDailyAdventure(progress, dateKey) {
  checkDate(dateKey);
  if (!isDayComplete(progress.days[dateKey])) return { progress: copy(progress), rewarded: false, companionUnlocked: false, unlockedCompanionId: null };
  const next = copy(progress);
  const alreadyCompleted = next.days[dateKey].completed;
  next.days[dateKey].completed = true;
  // Historical completed days may predate the expanded reward cap. They are not new learning days.
  const rewarded = !alreadyCompleted && !next.rewardDates.includes(dateKey) && next.rewardDates.length < MAX_REWARD_DAYS;
  if (rewarded) next.rewardDates.push(dateKey);
  const earned = companionIdsForRewardCount(next.rewardDates.length);
  const unlockedCompanionId = rewarded ? earned.find(id => !next.companions.includes(id)) || null : null;
  if (unlockedCompanionId) next.companions = earned;
  return { progress: next, rewarded, companionUnlocked: Boolean(unlockedCompanionId), unlockedCompanionId };
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function ensure(condition, message = '学习进度文件格式不正确。') {
  if (!condition) throw new Error(message);
}
function keys(value, allowed) {
  ensure(record(value) && Object.keys(value).every(key => allowed.includes(key)));
}
function count(value) {
  ensure(Number.isSafeInteger(value) && value >= 0);
}
function ids(value, max, knownWord) {
  ensure(Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every(knownWord));
}

function validateData(input, version) {
  const legacy = version === 1;
  keys(input, ['version', legacy ? 'courseId' : 'selectedUnitId', 'words', 'days', 'rewardDates', 'companions']);
  ensure(legacy ? input.version === 1 && input.courseId === LEGACY_UNIT_ID
    : input.version === version && Boolean(getUnit(input.selectedUnitId)), '这份进度属于不兼容的软件版本或教材单元。');
  const knownWord = id => typeof id === 'string' && (legacy ? LEGACY_WORD_IDS.has(id) : Boolean(getWord(id)));
  ensure(record(input.words) && record(input.days));
  ensure(Object.keys(input.words).length <= (legacy ? LEGACY_WORD_IDS.size : WORDS.length) && Object.keys(input.days).length <= 10000);
  for (const [wordId, word] of Object.entries(input.words)) {
    ensure(knownWord(wordId));
    keys(word, SKILLS);
    for (const skill of SKILLS) {
      const item = word[skill];
      keys(item, ['attempts', 'correct', 'streak', 'due', 'lastDate']);
      count(item.attempts); count(item.correct); count(item.streak);
      ensure(item.correct <= item.attempts && item.streak <= REVIEW_DAYS.length);
      if (item.attempts === 0) ensure(item.correct === 0 && item.streak === 0 && item.due === null && item.lastDate === null);
      else { checkDate(item.due); checkDate(item.lastDate); ensure(item.due > item.lastDate); }
    }
  }
  for (const [dateKey, day] of Object.entries(input.days)) {
    checkDate(dateKey);
    keys(day, ['plan', 'answers', 'completed']);
    ensure(typeof day.completed === 'boolean' && record(day.answers));
    const plan = day.plan;
    keys(plan, ['dateKey', ...(legacy ? [] : ['unitId']), 'newWordIds', 'reviewWordIds', 'wordIds', 'required', 'phraseId']);
    const unit = getUnit(legacy ? LEGACY_UNIT_ID : plan.unitId);
    ensure(plan.dateKey === dateKey && Boolean(unit));
    ensure(legacy ? plan.phraseId === 'milk-breakfast'
      : Boolean(getPhrase(plan.phraseId)) && unit.phraseIds.includes(plan.phraseId));
    ids(plan.newWordIds, 5, knownWord); ids(plan.reviewWordIds, 5, knownWord); ids(plan.wordIds, 5, knownWord);
    if (!legacy) ensure(plan.newWordIds.every(id => unit.wordIds.includes(id)), '每日新词与计划中的教材单元不一致。');
    ensure(plan.wordIds.length > 0 && JSON.stringify(plan.wordIds) === JSON.stringify([...plan.reviewWordIds, ...plan.newWordIds]));
    ensure(JSON.stringify(plan.required) === JSON.stringify(requiredFor(plan.wordIds)));
    for (const [wordId, answers] of Object.entries(day.answers)) {
      ensure(knownWord(wordId) && Boolean(input.words[wordId]));
      keys(answers, SKILLS);
      for (const answer of Object.values(answers)) {
        keys(answer, ['attempts', 'completed', 'usedHint', 'hadError']);
        count(answer.attempts);
        ensure(answer.attempts > 0 && ['completed', 'usedHint', 'hadError'].every(key => typeof answer[key] === 'boolean'));
      }
    }
    if (day.completed) ensure(isDayComplete(day), '进度中的已完成任务缺少练习记录。');
  }
  const rewardLimit = version < 3 ? 7 : MAX_REWARD_DAYS;
  ensure(Array.isArray(input.rewardDates) && input.rewardDates.length <= rewardLimit && new Set(input.rewardDates).size === input.rewardDates.length);
  for (const dateKey of input.rewardDates) { checkDate(dateKey); ensure(input.days[dateKey]?.completed === true, '奖励记录缺少已完成的每日任务。'); }
  const earned = version < 3 ? input.rewardDates.length === 7 ? ['bunny'] : [] : companionIdsForRewardCount(input.rewardDates.length);
  ensure(Array.isArray(input.companions) && JSON.stringify(input.companions) === JSON.stringify(earned), '伙伴记录与冒险进度不一致。');
}

function migrateLegacy(input) {
  const old = copy(input);
  const next = { version: 3, selectedUnitId: DEFAULT_UNIT_ID, words: old.words, days: old.days,
    rewardDates: old.rewardDates, companions: old.companions };
  for (const day of Object.values(next.days)) day.plan.unitId = LEGACY_UNIT_ID;
  return next;
}

export function validateProgress(input) {
  ensure(record(input));
  const version = input.version;
  ensure([1, 2, 3].includes(version), '这份进度属于不兼容的软件版本。');
  validateData(input, version);
  if (version === 3) return copy(input);
  // Validate each old format under its original seven-clue limit before upgrading it.
  const next = version === 1 ? migrateLegacy(input) : { ...copy(input), version: 3 };
  validateData(next, 3);
  return next;
}
