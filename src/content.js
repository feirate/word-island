import { KB3_UNITS, KB3_WORDS, KB3_PHRASES } from './kb3.js';
import { FIRST_COMPANION_CLUES } from './companions.js';

const LEGACY_COURSE = Object.freeze({
  id: 'kb2-u6',
  title: 'Kid’s Box 2 · Unit 6',
  series: '剑桥国际少儿英语 · Kid’s Box',
  level: 2,
  unit: 6,
  unitTitle: 'Dinner time',
  sourceNote: '依据已提供的 KB2 U6 食物与三餐主题词表；释义、拼读提示及练习由本软件整理。',
  estimatedMinutes: '10–15',
  maxNewWords: 5,
});

const word = (id, zh, emoji, phonics, phrase) => Object.freeze({
  id, en: id, english: id, zh, chinese: zh, emoji, phonics, phrase,
});

const LEGACY_WORDS = Object.freeze([
  word('milk', '牛奶', '🥛', 'm /m/，i /ɪ/；听听词尾的 /lk/。', 'I have milk for breakfast.'),
  word('rice', '米饭', '🍚', 'i 和词尾不发音的 e 配合，i 读 /aɪ/；c 在这里读 /s/。', 'Can I have some rice, please?'),
  word('chicken', '鸡肉', '🍗', 'ch 合起来读 /tʃ/；在 kitchen 里也能听到这个声音。', 'Can I have some chicken, please?'),
  word('fish', '鱼；鱼肉', '🐟', 'sh 合起来读 /ʃ/；i 在这里读 /ɪ/。', 'I like fish and chips.'),
  word('chips', '薯条', '🍟', 'ch 合起来读 /tʃ/；词尾 ps 两个声音都要读到。', 'I like fish and chips.'),
  word('fruit', '水果', '🍎', '先把 fr 连起来；这个词里的 ui 读 /uː/。', 'I like fruit.'),
  word('meat', '肉', '🥩', 'ea 合起来读 /iː/；和 meet 听起来一样。', 'Can I have some meat, please?'),
  word('breakfast', '早餐', '🥣', '分成 break + fast 来记；这个词里的 ea 读 /e/。', 'I have milk for breakfast.'),
  word('lunch', '午餐', '🥪', 'u 在这里读 /ʌ/；词尾 ch 读 /tʃ/。', 'I have rice for lunch.'),
  word('dinner', '晚餐', '🍽️', '分成 din + ner 来读，重音在前面。', 'I have chicken for dinner.'),
]);

export function getWord(id) {
  return WORDS.find(item => item.id === id);
}

const phrase = (id, en, zh, wordIds) => Object.freeze({
  id, en, english: en, zh, chinese: zh, wordIds,
  source: '软件补充示例句；内置英音合成示范，非教材原音。',
});

const LEGACY_PHRASES = Object.freeze([
  phrase('rice-please', 'Can I have some rice, please?', '请给我一些米饭，好吗？', ['rice']),
  phrase('fish-and-chips', 'I like fish and chips.', '我喜欢吃炸鱼和薯条。', ['fish', 'chips']),
  phrase('milk-breakfast', 'I have milk for breakfast.', '我早餐喝牛奶。', ['milk', 'breakfast']),
]);

export const CLUES = FIRST_COMPANION_CLUES;

// Stable vocabulary IDs share listening/spelling history across books.
function uniqueById(records) {
  const items=new Map();
  for(const item of records)if(!items.has(item.id))items.set(item.id,item);
  return Object.freeze([...items.values()]);
}
export const WORDS = uniqueById([...LEGACY_WORDS, ...KB3_WORDS]);
export const PHRASES = uniqueById([...LEGACY_PHRASES, ...KB3_PHRASES]);
export const DEFAULT_UNIT_ID = 'kb3-hello';
export const COURSE = Object.freeze({
  ...LEGACY_COURSE,
  bookId:'kb2', theme:'食物与三餐',
  wordIds:LEGACY_WORDS.map(word=>word.id), phraseIds:LEGACY_PHRASES.map(phrase=>phrase.id),
  phonics:{title:'听见 ch 的声音',description:'ch 可以读 /tʃ/：chicken、chips。把声音和字母联系起来。'},
});
export const UNITS = Object.freeze([...KB3_UNITS, COURSE]);
export const COURSES = Object.freeze([
  Object.freeze({id:'kb3',title:'Kid’s Box 3',subtitle:'学生用书 3 · 从 Hello! 开始',units:KB3_UNITS}),
  Object.freeze({id:'kb2',title:'Kid’s Box 2',subtitle:'之前的食物单元练习',units:[COURSE]}),
]);

export function getUnit(id) { return UNITS.find(unit=>unit.id===id); }
export function getPhrase(id) { return PHRASES.find(phrase=>phrase.id===id); }
export function getWordsForUnit(id) {
  const unit=getUnit(id);
  if(!unit)throw new Error('没有找到这个教材单元，请重新选择。');
  return unit.wordIds.map(getWord);
}
export function getPhrasesForUnit(id) {
  const unit=getUnit(id);
  if(!unit)throw new Error('没有找到这个教材单元，请重新选择。');
  return unit.phraseIds.map(getPhrase);
}
