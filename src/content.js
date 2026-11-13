export const COURSE = Object.freeze({
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

export const WORDS = Object.freeze([
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

export const PHRASES = Object.freeze([
  phrase('rice-please', 'Can I have some rice, please?', '请给我一些米饭，好吗？', ['rice']),
  phrase('fish-and-chips', 'I like fish and chips.', '我喜欢吃炸鱼和薯条。', ['fish', 'chips']),
  phrase('milk-breakfast', 'I have milk for breakfast.', '我早餐喝牛奶。', ['milk', 'breakfast']),
]);

export const CLUES = Object.freeze([
  { id: 'footprints', index: 1, title: '两排小脚印', description: '小路上出现一串轻巧的脚印，附近似乎住着一位新朋友。', emoji: '🐾', kind: 'clue' },
  { id: 'white-fluff', index: 2, title: '一团软软的白毛', description: '树枝上留着一点白色绒毛。新朋友的毛会是什么颜色？', emoji: '☁️', kind: 'clue' },
  { id: 'carrot-basket', index: 3, title: '小小的胡萝卜篮', description: '你找到一个小篮子，篮边画着胡萝卜。把它留作冒险纪念吧。', emoji: '🥕', kind: 'item' },
  { id: 'long-ears', index: 4, title: '树后的长耳朵', description: '树后探出两只长长的耳朵，又害羞地缩了回去。', emoji: '🌿', kind: 'clue' },
  { id: 'welcome-ribbon', index: 5, title: '欢迎小彩带', description: '你找到了准备欢迎餐的小彩带，可以带回小屋。', emoji: '🎀', kind: 'item' },
  { id: 'bunny-letter', index: 6, title: '团团的来信', description: '“你好，我是团团！听说你在准备欢迎餐，我想来认识你。”', emoji: '✉️', kind: 'clue' },
  { id: 'bunny-arrives', index: 7, title: '团团来到小屋', description: '原来是白白的团团！它带着小篮子，成为小屋里的第一位收藏伙伴。', emoji: '🐰', kind: 'clue' },
].map(Object.freeze));
