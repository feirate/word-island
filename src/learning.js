import { COURSE, WORDS, getWord } from './content.js';

const SKILLS = ['listen', 'spell'];
// A small scheduling heuristic, not a claimed universal forgetting curve.
const REVIEW_DAYS = [1, 3, 7, 14, 30];
const DAILY_WORD_LIMIT = 5;
const copy = value => structuredClone(value);
const emptySkill = () => ({ attempts: 0, correct: 0, streak: 0, due: null, lastDate: null });
const emptyWord = () => ({ listen: emptySkill(), spell: emptySkill() });

export function createInitialProgress() {
  return { version: 1, courseId: COURSE.id, words: {}, days: {}, rewardDates: [], companions: [] };
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
  const dueDate = id => {
    const word = progress.words[id];
    return SKILLS.map(skill => word[skill].due ?? '0000-01-01').sort()[0];
  };
  const reviewWordIds = WORDS.filter(word => {
    const learned = progress.words[word.id];
    return learned && SKILLS.some(skill => learned[skill].attempts === 0 || learned[skill].due <= dateKey);
  }).map(word => word.id).sort((a, b) => dueDate(a).localeCompare(dueDate(b)) || WORDS.findIndex(w => w.id === a) - WORDS.findIndex(w => w.id === b)).slice(0, DAILY_WORD_LIMIT);
  const recentAnswers = Object.entries(progress.days).filter(([key]) => key < dateKey)
    .sort(([a], [b]) => a.localeCompare(b)).slice(-7)
    .flatMap(([, day]) => Object.values(day.answers).flatMap(answers => Object.values(answers)));
  const independent = recentAnswers.filter(answer => answer.completed && !answer.usedHint && !answer.hadError).length;
  const newLimit = recentAnswers.length >= 6 && independent / recentAnswers.length >= 0.8 ? COURSE.maxNewWords : 3;
  const newWordIds = WORDS.filter(word => !progress.words[word.id]).slice(0, Math.min(newLimit, DAILY_WORD_LIMIT - reviewWordIds.length)).map(word => word.id);
  const wordIds = [...reviewWordIds, ...newWordIds];
  // Once all words are ahead of schedule, offer a short voluntary review.
  if (wordIds.length === 0) {
    wordIds.push(...WORDS.map(word => word.id).sort((a, b) => dueDate(a).localeCompare(dueDate(b))).slice(0, 3));
    reviewWordIds.push(...wordIds);
  }
  return { dateKey, newWordIds, reviewWordIds, wordIds, required: requiredFor(wordIds), phraseId: 'milk-breakfast' };
}

export function applyAnswer(progress, { wordId, skill, correct, usedHint = false, dateKey }) {
  checkDate(dateKey);
  if (!getWord(wordId) || !SKILLS.includes(skill) || typeof correct !== 'boolean' || typeof usedHint !== 'boolean') throw new Error('无效的练习答案。');
  const plan = getDailyPlan(progress, dateKey);
  const next = copy(progress);
  next.days[dateKey] ??= { plan, answers: {}, completed: false };
  next.words[wordId] ??= emptyWord();
  const day = next.days[dateKey];
  day.answers[wordId] ??= {};
  const daily = day.answers[wordId][skill] ?? { attempts: 0, completed: false, usedHint: false, hadError: false };
  daily.attempts += 1;
  daily.completed ||= correct;
  daily.usedHint ||= usedHint;
  daily.hadError ||= !correct;
  day.answers[wordId][skill] = daily;
  const record = next.words[wordId][skill];
  const sameDay = record.lastDate === dateKey;
  record.attempts += 1;
  if (correct) record.correct += 1;
  if (!correct || daily.usedHint || daily.hadError) record.streak = 0;
  else if (!sameDay) record.streak = Math.min(REVIEW_DAYS.length, record.streak + 1);
  record.due = addDays(dateKey, REVIEW_DAYS[Math.max(0, record.streak - 1)]);
  record.lastDate = dateKey;
  return next;
}

function isDayComplete(day) {
  return Boolean(day && day.plan.required.length > 0 && day.plan.required.every(({ wordId, skill }) => day.answers[wordId]?.[skill]?.completed));
}

export function completeDailyAdventure(progress, dateKey) {
  checkDate(dateKey);
  if (!isDayComplete(progress.days[dateKey])) return { progress: copy(progress), rewarded: false, companionUnlocked: false };
  const next = copy(progress);
  next.days[dateKey].completed = true;
  const rewarded = !next.rewardDates.includes(dateKey) && next.rewardDates.length < 7;
  if (rewarded) next.rewardDates.push(dateKey);
  const companionUnlocked = next.rewardDates.length === 7 && !next.companions.includes('bunny');
  if (companionUnlocked) next.companions.push('bunny');
  return { progress: next, rewarded, companionUnlocked };
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
function ids(value, max = WORDS.length) {
  ensure(Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every(id => getWord(id)));
}

export function validateProgress(input) {
  keys(input, ['version', 'courseId', 'words', 'days', 'rewardDates', 'companions']);
  ensure(input.version === 1 && input.courseId === COURSE.id, '这份进度属于不兼容的软件版本或教材。');
  ensure(record(input.words) && record(input.days));
  ensure(Object.keys(input.words).length <= WORDS.length && Object.keys(input.days).length <= 10000);
  for (const [wordId, word] of Object.entries(input.words)) {
    ensure(Boolean(getWord(wordId)));
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
    keys(plan, ['dateKey', 'newWordIds', 'reviewWordIds', 'wordIds', 'required', 'phraseId']);
    ensure(plan.dateKey === dateKey && plan.phraseId === 'milk-breakfast');
    ids(plan.newWordIds, 5); ids(plan.reviewWordIds, 5); ids(plan.wordIds, 5);
    ensure(plan.wordIds.length > 0 && JSON.stringify(plan.wordIds) === JSON.stringify([...plan.reviewWordIds, ...plan.newWordIds]));
    ensure(JSON.stringify(plan.required) === JSON.stringify(requiredFor(plan.wordIds)));
    for (const [wordId, answers] of Object.entries(day.answers)) {
      ensure(Boolean(getWord(wordId)) && Boolean(input.words[wordId]));
      keys(answers, SKILLS);
      for (const answer of Object.values(answers)) {
        keys(answer, ['attempts', 'completed', 'usedHint', 'hadError']);
        count(answer.attempts);
        ensure(answer.attempts > 0 && ['completed', 'usedHint', 'hadError'].every(key => typeof answer[key] === 'boolean'));
      }
    }
    if (day.completed) ensure(isDayComplete(day), '进度中的已完成任务缺少练习记录。');
  }
  ensure(Array.isArray(input.rewardDates) && input.rewardDates.length <= 7 && new Set(input.rewardDates).size === input.rewardDates.length);
  for (const dateKey of input.rewardDates) { checkDate(dateKey); ensure(input.days[dateKey]?.completed === true, '奖励记录缺少已完成的每日任务。'); }
  ensure(Array.isArray(input.companions) && JSON.stringify(input.companions) === JSON.stringify(input.rewardDates.length === 7 ? ['bunny'] : []), '伙伴记录与冒险进度不一致。');
  return copy(input);
}
