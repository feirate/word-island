import { WorldView } from './world.js';
import { COURSE, WORDS, PHRASES, CLUES, getWord } from './content.js';
import { createInitialProgress, localDateKey, getDailyPlan, applyAnswer, completeDailyAdventure } from './learning.js';
import { loadProgress, saveProgress, exportProgress, importProgress, getClip, putClip } from './storage.js';

const $ = selector => document.querySelector(selector);
const panel = $('#notebook-content');
const loaded = loadProgress();
let realProgress = loaded.progress;
let demoProgress = createInitialProgress();
let demo = false;
let demoDate = '2026-01-01';
let dateKey = localDateKey();
let page = 'home';
let phase = 'overview';
let activeWordId = null;
let freeWordId = null;
let feedback = null;
let hintUsed = false;
let phraseIndex = 0;
let pendingImport = null;
let toastTimeout;
let recording = null;
let recordingRequest = null;
let recordingTimer;
let audioUrl = null;
let activeAudio = null;
let activeAudioUrl = null;
let audioGeneration = 0;
const importedClips = new Map();
const pendingClips = new Set();
let readDays = new Set();
const demoReadDays = new Set();
let offlineRegistration = null;
try {
  const stored = JSON.parse(localStorage.getItem('word-island:reading:v1') || '[]');
  if (Array.isArray(stored)) readDays = new Set(stored.filter(x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)));
} catch { /* A reading flag can be repeated without changing any reward. */ }

const progress = () => demo ? demoProgress : realProgress;
const today = () => demo ? demoDate : dateKey;
const plan = () => getDailyPlan(progress(), today());
const completed = (id, skill) => Boolean(progress().days[today()]?.answers[id]?.[skill]?.completed);
const readingDone = () => (demo ? demoReadDays : readDays).has(today()) || Boolean(progress().days[today()]?.completed);
const doneCount = skill => plan().wordIds.filter(id => completed(id, skill)).length;
const allDone = skill => doneCount(skill) === plan().wordIds.length;
const escapeText = text => String(text).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const clueCount = () => progress().rewardDates.length;
const microphoneBusy = () => Boolean(recording || recordingRequest);

function scrollNotebook() {
  if (window.innerWidth <= 850) requestAnimationFrame(() => $('.notebook').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}));
}

function ensureToday() {
  if (demo || dateKey === localDateKey()) return true;
  dateKey = localDateKey(); phase='overview';activeWordId=null;freeWordId=null;feedback=null;
  stopAudio();recordingRequest=null;
  if(recording?.recorder.state!=='inactive')recording?.recorder.stop();
  render();toast('新的一天，今日任务已经更新。再点一下就能出发。');
  return false;
}

function toast(text, duration = 5000) {
  clearTimeout(toastTimeout);
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, duration);
}

function setProgress(next) {
  if (demo) { demoProgress = next; return; }
  realProgress = next;
  try {
    // Keep an unreadable original before the first recovery write.
    if (loaded.error) {
      const old = localStorage.getItem('word-island:progress:v1');
      if (old && !localStorage.getItem('word-island:unreadable-backup')) localStorage.setItem('word-island:unreadable-backup', old);
    }
    saveProgress(realProgress);
  } catch (error) { toast(error.message, 8000); }
}

function setReadingDone() {
  (demo ? demoReadDays : readDays).add(today());
  if (!demo) {
    try { localStorage.setItem('word-island:reading:v1', JSON.stringify([...readDays])); }
    catch { toast('朗读已完成；本机存储不可用，请及时导出学习进度。'); }
  }
}

const world = new WorldView($('#world-canvas'), {
  onInteract: handleWorldInteraction,
  onReady() { $('#world-loading').hidden = true; },
  onError(error) {
    $('#world-loading').innerHTML = '<span class="loading-seed">🌱</span><strong>小岛还没准备好</strong><span></span><button class="button" type="button" data-action="reload">重新打开</button>';
    $('#world-loading span:last-of-type').textContent = `模型加载失败：${error.message}。请联网重试，并确认设备支持 WebGL 2。`;
  },
});
world.ready.catch(() => {});

function handleWorldInteraction(id) {
  const actions = {
    'home.door': () => navigate('camp'),
    'home.bookshelf': () => { page = 'home'; phase = 'books'; render(); },
    'home.clues': () => navigate('clues'),
    'home.bunny': () => { toast('团团：谢谢你找到了我，我们一起慢慢学吧！'); world.celebrate(); },
    'camp.crate': () => enterTask('listen'),
    'camp.sign': () => enterTask('spell'),
    'camp.mailbox': () => enterTask('read'),
    'camp.chest': collectReward,
  };
  actions[id]?.();
}

function stopAudio() {
  audioGeneration += 1;
  activeAudio?.pause(); activeAudio = null;
  if(activeAudioUrl){URL.revokeObjectURL(activeAudioUrl);activeAudioUrl=null;}
  document.querySelectorAll('audio').forEach(player=>player.pause());
}

function preparePrompt(key) {
  if(importedClips.has(key)||pendingClips.has(key))return;
  pendingClips.add(key);
  getClip(key).then(blob=>importedClips.set(key,blob)).catch(()=>importedClips.set(key,null)).finally(()=>pendingClips.delete(key));
}

function navigate(next) {
  if (microphoneBusy()) { toast('先结束录音或等待麦克风请求完成，再去别处看看。'); return; }
  stopAudio();
  page = next;
  phase = 'overview';
  freeWordId = null;
  feedback = null;
  render();
  if(next==='clues'||next==='growth')scrollNotebook();
}

function enterTask(skill, wordId = null) {
  if (!ensureToday()) return;
  if (microphoneBusy()) { toast('先结束录音或等待麦克风请求完成。'); return; }
  stopAudio();
  page = 'camp'; phase = skill; freeWordId = wordId;
  activeWordId = wordId || plan().wordIds.find(id => !completed(id, skill)) || null;
  feedback = null; hintUsed = false;
  render();
  world.focusObject(skill === 'listen' ? 'camp.crate' : skill === 'spell' ? 'camp.sign' : 'camp.mailbox');
  if (skill === 'read') loadRecording();
  scrollNotebook();
}

function clueTrack() {
  return `<div class="clue-track" aria-label="已经获得 ${clueCount()} 条线索，共七条">${CLUES.map((clue, i) => `<span class="clue-dot ${i < clueCount() ? 'found' : ''}">${i < clueCount() ? '✦' : i + 1}</span>`).join('')}</div>`;
}

function taskList() {
  return `<ul class="task-list">${[
    ['listen', '听懂营地的小点单', `${doneCount('listen')} / ${plan().wordIds.length} 个词 · 去食物木箱`, allDone('listen')],
    ['spell', '拼出路牌上的秘密', `${doneCount('spell')} / ${plan().wordIds.length} 个词 · 去探险路牌`, allDone('spell')],
    ['read', '给新朋友留一句话', readingDone() ? '今天已经开口练习过' : '听、跟读、录下自己的声音', readingDone()],
  ].map(([skill, title, detail, done]) => `<li><button type="button" data-task="${skill}"><span class="task-mark ${done ? 'complete' : ''}">${done ? '✓' : skill === 'listen' ? '1' : skill === 'spell' ? '2' : '3'}</span><span><strong>${title}</strong><small>${detail}</small></span><span class="task-arrow">↗</span></button></li>`).join('')}</ul>`;
}

function overview() {
  const count = clueCount();
  const rewardedToday = Boolean(progress().days[today()]?.completed);
  const known = plan().reviewWordIds.length;
  const newCount = plan().newWordIds.length;
  return `<div class="notebook-label"><span>TODAY’S LITTLE ADVENTURE</span><span class="small-tag">${demo ? '演示存档' : '约 10–15 分钟'}</span></div><h2>${count === 7 ? '团团，欢迎来到小屋！' : rewardedToday ? '今天的线索已收好' : page === 'home' ? '新朋友在等你发现' : '欢迎餐的秘密'}</h2><p class="description">${count === 7 ? '七条线索拼成了一次相遇。团团已经住进小屋，今后的冒险还有芽芽陪着你。' : rewardedToday ? '你又向新朋友走近了一步。可以回小屋看看，也可以再练几个词。' : '听说林间住着一位害羞的新朋友。帮芽芽准备欢迎餐，找到今天的线索吧。'}</p><div class="course-label">▤ ${COURSE.title} · ${COURSE.unitTitle}</div><div class="section-divider"></div><div class="progress-caption"><span>寻找第一位伙伴</span><span>${count} / 7 条线索</span></div>${clueTrack()}<p class="next-clue">${count === 7 ? '伙伴已入住 · 奶白小兔「团团」' : '七次累计完成就能相遇，漏一天也保留。'}</p>${page === 'home' ? `<button type="button" class="button primary wide" data-nav="camp">${rewardedToday || count === 7 ? '再去营地练一练' : '出发，找新朋友'} <span>→</span></button><div class="pet-message"><span>🦊</span><p>芽芽的今日计划<br>${known ? `先找回 ${known} 个熟悉的词` : '从三个小小的单词开始'}${newCount ? `，再认识 ${newCount} 个新词。` : '，慢慢记牢就很好。'}</p></div><button type="button" class="button subtle wide" data-action="open-books">自己挑一个词练习</button>` : `${taskList()}<button type="button" class="button primary wide" data-action="collect">${rewardedToday ? '查看已找到的线索' : count === 7 ? '收好今天的练习' : '打开线索宝箱'} →</button><div class="pet-message"><span>🌿</span><p>不必一次全对。想不起来，就看看提示，再试一次。</p></div>`}${demo && rewardedToday ? '<button type="button" class="button wide" data-action="demo-next">继续下一次冒险（演示） →</button>' : ''}`;
}

function skillFinished(skill) {
  return `<div class="exercise-header"><button type="button" class="text-button" data-action="back-task">← 今日任务</button><span class="small-tag">已完成</span></div><span class="eyebrow">YOU DID IT</span><h2>${skill === 'listen' ? '耳朵找到线索啦' : '这些词，你拼出来了'}</h2><p class="description">今天这里的 ${plan().wordIds.length} 个词已经练过。去${skill === 'listen' ? '路牌拼一拼' : '邮筒说一句话'}，完成欢迎餐的下一步吧。</p><button type="button" class="button primary wide" data-task="${skill === 'listen' ? 'spell' : 'read'}">${skill === 'listen' ? '继续拼一拼' : '和新朋友说句话'} →</button><button type="button" class="button subtle wide" data-action="back-task">回到营地手记</button>`;
}

function question(skill) {
  if (!activeWordId) return skillFinished(skill);
  const word = getWord(activeWordId);
  const ids = freeWordId ? [freeWordId] : plan().wordIds;
  const n = freeWordId ? 1 : ids.indexOf(word.id) + 1;
  const choices = [word, ...WORDS.filter(w => w.id !== word.id).slice((n - 1) % 5, (n - 1) % 5 + 2)];
  const rotated = choices.slice(n % 3).concat(choices.slice(0, n % 3));
  return `<div class="exercise-header"><button type="button" class="text-button" data-action="back-task">← 今日任务</button><span class="exercise-counter">${freeWordId ? '自由练习' : `${n} / ${ids.length}`}</span></div><span class="eyebrow">${skill === 'listen' ? 'LISTEN & FIND' : 'LISTEN & SPELL'}</span><h2 class="question-title">${skill === 'listen' ? '听听，芽芽需要哪一样？' : `试着拼出“${word.zh}”`}</h2><button type="button" class="audio-button" data-action="play-word" aria-label="播放单词示范音">▷</button><p class="audio-caption" id="audio-source">轻点播放 · 优先使用已导入音频</p>${skill === 'listen' ? `<div class="answer-grid">${rotated.map(w => `<button type="button" class="answer ${feedback?.selected === w.id ? feedback.correct ? 'correct' : 'wrong' : ''}" data-answer="${w.id}" ${feedback?.correct ? 'disabled' : ''}><span class="emoji" aria-hidden="true">${w.emoji}</span>${w.zh}</button>`).join('')}</div>` : `<input class="spell-input" id="spell-input" aria-label="输入英语单词" placeholder="在这里拼一拼" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" ${feedback?.correct ? 'disabled' : ''}><button type="button" class="button wide" data-action="check-spell" ${feedback?.correct ? 'disabled' : ''}>检查一下</button>`}<div class="feedback ${feedback && !feedback.correct ? 'error' : ''}" role="status">${feedback ? escapeText(feedback.text) : skill === 'listen' ? '可以多听几次，慢慢找到它。' : `试着听声音来拼，或想想 ${word.en[0]} 开头的词。`}</div>${hintUsed || feedback?.correct ? `<div class="word-reveal">${word.en}</div><div class="phonics">${word.phonics}</div>` : ''}${feedback?.correct ? '<button type="button" class="button primary wide" data-action="next-question">收好这个词，继续 →</button>' : '<button type="button" class="button subtle wide" data-action="hint">给我一点提示</button>'}`;
}

function reading() {
  const phrase = PHRASES[phraseIndex];
  return `<div class="exercise-header"><button type="button" class="text-button" data-action="back-task">← 今日任务</button><span class="small-tag">${readingDone() ? '今天已练习' : '开口就很棒'}</span></div><span class="eyebrow">A MESSAGE FOR A FRIEND</span><h2 class="question-title">留一句欢迎的话</h2><div class="phrase-selector">${PHRASES.map((p, i) => `<button type="button" data-phrase="${i}" class="${i === phraseIndex ? 'active' : ''}">短句 ${i + 1}</button>`).join('')}</div><div class="phrase-card"><p class="english">${phrase.en}</p><p class="chinese">${phrase.zh}</p></div><p class="record-help">补充示例句 · 非教材原音</p><button type="button" class="button wide" data-action="play-phrase">▷ 听一句示范</button><p class="audio-caption" id="audio-source">优先使用导入的本地音频</p><div class="button-row"><button type="button" class="record-button ${recording ? 'recording' : ''}" id="record-button" data-action="record">${recording ? '■ 结束录音' : '● 录下我的声音'}</button></div><p class="recording-status" id="recording-status">${recording ? '正在录音，最长 30 秒…' : ''}</p><audio class="recording-playback" id="recording-playback" controls hidden></audio><p class="record-help">录音只留在这台设备。可以听听自己的声音，也可以先读给家长听。</p><button type="button" class="button primary wide" data-action="finish-reading">${readingDone() ? '已读过，去找线索 →' : '我已经开口读过了 →'}</button>`;
}

function clues() {
  return `<div class="notebook-label"><span>SEVEN LITTLE DISCOVERIES</span><span class="small-tag">${clueCount()} / 7</span></div><h2>一次相遇，慢慢靠近</h2><p class="description">每完成一天的学习，就带回来一个小发现。所有线索都会留下来。</p><div class="companion-teaser ${clueCount() === 7 ? 'unlocked' : ''}"><span class="teaser-icon">🐰</span><div><h3>${clueCount() === 7 ? '团团 · 已经入住' : clueCount() >= 4 ? '长耳朵的新朋友' : '神秘的第一位伙伴'}</h3><p class="description" style="margin-top:4px">${clueCount() === 7 ? '一只爱分享的奶白小兔' : '它会是什么模样呢？'}</p></div></div>${clueTrack()}<div class="clue-list">${CLUES.map((clue, i) => `<div class="clue-item ${i >= clueCount() ? 'locked' : ''}"><span>${i < clueCount() ? clue.emoji : '·'}</span><div><h3>${i < clueCount() ? clue.title.replaceAll('兔兔','团团') : `第 ${i + 1} 次冒险`}</h3><p>${i < clueCount() ? clue.description.replaceAll('兔兔','团团') : '完成学习以后，故事会再展开一点。'}</p></div></div>`).join('')}</div><button type="button" class="button primary wide" data-nav="${clueCount() === 7 ? 'home' : 'camp'}">${clueCount() === 7 ? '回小屋看看团团' : '去找今天的线索'} →</button>`;
}

function growth() {
  const p = progress();
  const days = Object.keys(p.days).filter(d => p.days[d].completed);
  const correct = skill => Object.values(p.words).reduce((sum, word) => sum + word[skill].correct, 0);
  const attempts = skill => Object.values(p.words).reduce((sum, word) => sum + word[skill].attempts, 0);
  const rate = skill => attempts(skill) ? `${Math.round(correct(skill) / attempts(skill) * 100)}%` : '—';
  const current = new Date(`${today()}T12:00:00`);
  const lastWeek = Array.from({length:7}, (_, i) => { const d = new Date(current); d.setDate(d.getDate() - 6 + i); return localDateKey(d); });
  return `<div class="notebook-label"><span>SMALL STEPS, REAL GROWTH</span><span class="small-tag">${demo ? '演示数据' : '本机真实记录'}</span></div><h2>每一步，都算数</h2><p class="description">近七天完成 ${lastWeek.filter(d => days.includes(d)).length} 天。听懂和拼写分别记录，录音练习不当作发音评分。</p><div class="week-strip">${lastWeek.map(d => `<div class="week-day ${days.includes(d) ? 'done' : ''}">${Number(d.slice(-2))}日<strong>${days.includes(d) ? '✓' : '·'}</strong></div>`).join('')}</div><div class="growth-stats"><div class="stat"><strong>${days.length}</strong><span>累计完成天数</span></div><div class="stat"><strong>${Object.keys(p.words).length}</strong><span>已经接触的单词</span></div><div class="stat"><strong>${rate('listen')}</strong><span>听辨作答正确率</span></div><div class="stat"><strong>${rate('spell')}</strong><span>拼写作答正确率</span></div></div><p class="record-help">正确率包含重试与提示后的作答，不能单独代表掌握程度。隔天能否独立想起更值得关注。</p><table class="word-status"><thead><tr><th>单词</th><th>听辨 / 拼写</th><th>下次再见</th></tr></thead><tbody>${WORDS.filter(w => p.words[w.id]).map(w => {const r=p.words[w.id];const due=[r.listen.due,r.spell.due].filter(Boolean).sort()[0]; return `<tr><td>${w.en}</td><td>${r.listen.correct} / ${r.spell.correct} 次答对</td><td>${due ? due.slice(5) : '待练习'}</td></tr>`;}).join('') || '<tr><td colspan="3">开始第一次冒险后，这里就会留下足迹。</td></tr>'}</tbody></table><button type="button" class="button wide" data-action="open-parent">备份或转移学习进度</button>`;
}

function books() {
  return `<div class="exercise-header"><button type="button" class="text-button" data-nav="home">← 回到小屋</button><span class="small-tag">教材书架</span></div><h2>从熟悉的一课出发</h2><div class="shelf-book"><div class="book-cover"><span>Kid’s Box</span><strong>2</strong></div><div><h3>Unit 6 · Dinner time</h3><p class="description" style="margin-top:5px">食物、三餐与欢迎餐</p></div></div><p class="description">今日计划由软件安排，也可以先挑一个词自由练习。自由练习不会跳过今日任务。</p><button type="button" class="button primary wide" data-nav="camp">按今日计划出发 →</button><div class="word-chips">${WORDS.map(w => `<button type="button" data-free-word="${w.id}">${w.en}</button>`).join('')}</div><div class="phonics">拼读小发现<br>ch 可以读 /tʃ/：chicken、chips。把听到的声音和看到的字母联系起来。</div><div class="future-book">＋ 更多册数与教材<br>等确认教材以后，继续放进同一个书架。伙伴和冒险进度都会保留。</div><p class="record-help">本版围绕提供的 KB2 U6 主题整理，练习句由软件补充。未公开整本教材或配套原音。</p>`;
}

function render() {
  document.querySelectorAll('.main-nav button').forEach(button => {
    if (button.dataset.nav === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('.nav-count').textContent = `${clueCount()}/7`;
  $('#demo-banner').hidden = !demo;
  $('#demo-toggle').textContent = demo ? '返回真实存档 ↗' : '试玩七日故事 ↗';
  const sceneName = page === 'camp' ? 'camp' : 'home';
  world.setScene(sceneName);
  world.setCompanionUnlocked(progress().companions.includes('bunny'));
  $('#scene-kicker').textContent = demo ? '演示存档 · 可以快进故事，不写入真实进度' : page === 'camp' ? '今天，再向新朋友靠近一点' : '一个慢慢长大的小世界';
  $('#scene-title').textContent = page === 'camp' ? '林间营地，有新的发现' : clueCount() === 7 ? '小屋里，多了一位朋友' : '欢迎回到你的小屋';
  $('#world-location').textContent = sceneName === 'home' ? '暖暖小屋' : '林间营地';
  $('#world-caption').textContent = sceneName === 'home' ? '轻点门去冒险，轻点书柜选单词，线索板记着你找到的每一次惊喜。' : '营地里的木箱、路牌、邮筒都藏着一个小任务。也可以用下面的入口开始。';
  $('#scene-shortcuts').innerHTML = (sceneName === 'home' ? [
    ['home.door','↗','推门出发','去找新的伙伴'],['home.bookshelf','▤','翻翻书架','也能自己挑单词'],['home.clues','✧','看看线索','每一步都会留下来'],
  ] : [
    ['camp.crate','◖','听音找食物',`${doneCount('listen')} / ${plan().wordIds.length} 已完成`],['camp.sign','Aa','拼写小秘密',`${doneCount('spell')} / ${plan().wordIds.length} 已完成`],['camp.mailbox','♪','给朋友留言',readingDone() ? '已经开口练习过' : '听、跟读、录下来'],
  ]).map(([id, icon, title, subtitle]) => `<button type="button" class="shortcut" data-object="${id}"><span class="shortcut-icon" aria-hidden="true">${icon}</span><span><strong>${title}</strong><small>${subtitle}</small></span></button>`).join('');
  panel.innerHTML = page === 'clues' ? clues() : page === 'growth' ? growth() : phase === 'books' ? books() : phase === 'listen' || phase === 'spell' ? question(phase) : phase === 'read' ? reading() : overview();
  if((phase==='listen'||phase==='spell')&&activeWordId)preparePrompt(`word:${activeWordId}`);
  if(phase==='read')preparePrompt(`phrase:${PHRASES[phraseIndex].id}`);
}

function playPrompt(key) {
  stopAudio();
  const generation=audioGeneration;
  const source = $('#audio-source');
  const blob=importedClips.get(key);
  const url=blob?URL.createObjectURL(blob):new URL(`../assets/audio/${key.replace(':','-')}.m4a`,import.meta.url).href;
  const audio=new Audio(url);activeAudio=audio;if(blob)activeAudioUrl=url;
  const label=blob?'已导入的本地音频':'内置英音示范 · 合成音，非教材原音';
  const release=()=>{if(blob)URL.revokeObjectURL(url);if(activeAudioUrl===url)activeAudioUrl=null;};
  audio.addEventListener('ended',release,{once:true});
  audio.addEventListener('error',release,{once:true});
  // Playback begins in the tap handler; IndexedDB is prepared before the tap for iOS.
  audio.play().then(()=>{if(generation===audioGeneration&&source?.isConnected)source.textContent=label;}).catch(error=>{
    release();if(generation!==audioGeneration)return;
    if(error.name!=='AbortError')toast('这段声音暂时无法播放，请再点一次；也可以联网准备资源或重新导入音频。');
  });
}

function answer(correct, selected = null) {
  if(!ensureToday())return;
  if (!activeWordId || feedback?.correct) return;
  const word = getWord(activeWordId);
  setProgress(applyAnswer(progress(), {wordId:word.id,skill:phase,correct,usedHint:hintUsed,dateKey:today()}));
  feedback = {correct,selected,text:correct ? `找到了！${word.en} 是${word.zh}。` : phase === 'spell' ? '再试一次。可以听一听声音，也可以看看拼读提示。' : '还差一点点，再听一次，或者看看提示。'};
  if (correct) world.celebrate();
  render();
}

function nextQuestion() {
  if(!ensureToday())return;
  stopAudio();
  if (freeWordId) {
    if (phase === 'listen') { enterTask('spell', freeWordId); return; }
    freeWordId = null; phase = 'books'; page = 'home'; feedback = null; render(); return;
  }
  activeWordId = plan().wordIds.find(id => !completed(id, phase)) || null;
  feedback = null; hintUsed = false; render();
}

function collectReward() {
  if(!ensureToday())return;
  if (progress().days[today()]?.completed) { navigate('clues'); return; }
  if (!allDone('listen') || !allDone('spell') || !readingDone()) {
    toast('先完成木箱的听辨、路牌的拼写，再到邮筒开口读一句。线索宝箱会等着你。', 6500);
    page='camp'; phase='overview'; render(); return;
  }
  const before = clueCount();
  const result = completeDailyAdventure(progress(), today());
  setProgress(result.progress);
  if (!result.rewarded) { toast('今天的练习已完成，团团在小屋等你。'); render(); return; }
  world.celebrate();
  const clue = CLUES[before];
  $('#reward-emoji').textContent = clue.emoji;
  $('#reward-title').textContent = clue.title.replaceAll('兔兔','团团');
  $('#reward-description').textContent = clue.description.replaceAll('兔兔','团团');
  $('#reward-dots').innerHTML = CLUES.map((_,i) => `<span class="${i<clueCount()?'done':''}"></span>`).join('');
  $('#reward-continue').textContent = result.companionUnlocked ? '带团团回家 →' : '把线索带回小屋 →';
  render(); $('#reward-dialog').showModal();
}

function startDemo(ending = false) {
  if (microphoneBusy()) { toast('先结束录音或等待麦克风请求完成，再进入演示。'); return; }
  stopAudio();
  demo = true; demoProgress = createInitialProgress(); demoDate = '2026-01-01'; demoReadDays.clear();
  if (ending) {
    for (let n=0; n<7; n++) {
      demoDate = `2026-01-${String(n+1).padStart(2,'0')}`;
      for (const item of getDailyPlan(demoProgress,demoDate).required) demoProgress = applyAnswer(demoProgress,{...item,correct:true,usedHint:false,dateKey:demoDate});
      demoReadDays.add(demoDate);
      demoProgress = completeDailyAdventure(demoProgress,demoDate).progress;
    }
  }
  $('#parent-dialog').close();
  navigate('home');
  if (ending) { world.focusObject('home.bunny'); toast('这是演示结局：团团入住啦。真实学习记录没有变化。',6500); }
  else toast('进入独立演示存档，可以体验完整的七次冒险。');
}

function exitDemo() { if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;} demo=false; navigate('home'); toast('已回到真实学习存档。'); }

async function loadRecording() {
  try {
    const blob = await getClip(`recording:${demo?'demo-':''}${today()}`);
    if (blob && phase==='read') showRecording(blob);
  } catch { /* Recording is optional; playback errors are shown when recording is saved. */ }
}
function showRecording(blob) {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  const player = $('#recording-playback');
  if (player) { player.src=audioUrl; player.hidden=false; }
}

async function toggleRecording() {
  if (recording) { recording.recorder.stop(); return; }
  if(recordingRequest)return;
  if(!ensureToday())return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('这台浏览器暂不支持录音。可以用 Safari 打开，或者先读给家长听。'); return; }
  stopAudio();
  const request={demo,date:today(),phrase:phraseIndex};recordingRequest=request;
  const button=$('#record-button'); if(button)button.disabled=true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    if(recordingRequest!==request||phase!=='read'||demo!==request.demo||today()!==request.date||phraseIndex!==request.phrase){stream.getTracks().forEach(track=>track.stop());return;}
    const type = ['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
    const recorder = type ? new MediaRecorder(stream,{mimeType:type}) : new MediaRecorder(stream);
    const chunks=[];
    const clipKey=`recording:${request.demo?'demo-':''}${request.date}`;
    recorder.addEventListener('dataavailable',event=>{if(event.data.size)chunks.push(event.data);});
    recorder.addEventListener('stop',async()=>{
      clearInterval(recordingTimer);stream.getTracks().forEach(track=>track.stop());recording=null;
      const blob=new Blob(chunks,{type:recorder.mimeType||'audio/mp4'});
      if(phase==='read')render();
      if(!blob.size){toast('这次没有录到声音，再试一次吧。');return;}
      try {await putClip(clipKey,blob); if(phase==='read'){showRecording(blob);$('#recording-status').textContent='录好了。听听自己的声音吧。';}}
      catch(error){if(phase==='read')showRecording(blob);toast(`${error.message} 这段录音仍可在当前页面回听。`,7000);}
    },{once:true});
    recorder.addEventListener('error',()=>{toast('录音中断了，可以重新试一次。');if(recorder.state!=='inactive')recorder.stop();},{once:true});
    recorder.start();recordingRequest=null;recording={recorder,stream,started:Date.now()};render();
    recordingTimer=setInterval(()=>{
      if(!recording)return;
      const seconds=Math.floor((Date.now()-recording.started)/1000);
      const status=$('#recording-status');if(status)status.textContent=`正在录音 ${seconds} 秒 · 最长 30 秒`;
      if(seconds>=30&&recording.recorder.state!=='inactive')recording.recorder.stop();
    },500);
  } catch(error) {
    stream?.getTracks().forEach(track=>track.stop()); recording=null;
    if(button?.isConnected)button.disabled=false;
    toast(error.name==='NotAllowedError'?'麦克风尚未允许。可以在浏览器设置里打开，今天也可以先读给家长听。':'录音暂时无法开始，请检查麦克风是否被其他程序使用。',6500);
  } finally {if(recordingRequest===request)recordingRequest=null;if(button?.isConnected)button.disabled=false;}
}

function download(text, filename) {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

async function prepareOffline() {
  const detail=$('#offline-detail');detail.textContent='正在准备程序和三维场景…';
  try {
    if(!('serviceWorker' in navigator))throw new Error('这个浏览器暂不支持离线资源缓存。');
    offlineRegistration ||= await navigator.serviceWorker.register('./sw.js');
    const registration=await navigator.serviceWorker.ready;
    const channel=new MessageChannel();
    const result=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('离线资源准备超时，请保持联网再试一次。')),45000);
      channel.port1.onmessage=event=>{clearTimeout(timeout);channel.port1.close();resolve(event.data);};
      registration.active.postMessage({type:'CACHE_MODELS'},[channel.port2]);
    });
    if(!result.ok)throw new Error('有模型尚未准备好，请保持联网后重新准备。');
    detail.textContent='程序、内置英音和四个模型已可离线。自己导入的音频也保存在本机。';
    $('#offline-status').textContent='小岛已准备好离线探索';
    navigator.storage?.persist?.().catch(()=>{});
  } catch(error){detail.textContent=error.message;$('#offline-status').textContent='联网探索 · 可准备离线';}
}

document.addEventListener('click',event=>{
  const close=event.target.closest('[data-close]');if(close){document.getElementById(close.dataset.close).close();return;}
  const button=event.target.closest('button');if(!button||button.disabled)return;
  const d=button.dataset;
  if(d.nav){navigate(d.nav);return;}
  if(d.object){handleWorldInteraction(d.object);return;}
  if(d.task){enterTask(d.task);return;}
  if(d.freeWord){enterTask('listen',d.freeWord);return;}
  if(d.answer){answer(d.answer===activeWordId,d.answer);return;}
  if(d.phrase!==undefined){if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}stopAudio();phraseIndex=Number(d.phrase);render();loadRecording();return;}
  const actions={
    'open-books':()=>{phase='books';page='home';render();scrollNotebook();},
    'open-parent':()=>$('#parent-dialog').showModal(),
    'back-task':()=>{if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}stopAudio();phase='overview';freeWordId=null;feedback=null;render();},
    'play-word':()=>playPrompt(`word:${activeWordId}`,getWord(activeWordId).en),
    'play-phrase':()=>playPrompt(`phrase:${PHRASES[phraseIndex].id}`,PHRASES[phraseIndex].en),
    'check-spell':()=>{const input=$('#spell-input');const text=input?.value.trim().toLowerCase();if(!text){toast('先拼出一点，再检查。');return;}answer(text===activeWordId);},
    hint:()=>{hintUsed=true;feedback={correct:false,text:`提示：${getWord(activeWordId).en} 是${getWord(activeWordId).zh}。记住它，再试一次。`};render();},
    'next-question':nextQuestion,
    collect:collectReward,
    record:toggleRecording,
    'finish-reading':()=>{if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}if(!ensureToday())return;setReadingDone();phase='overview';render();toast('愿意开口就很好。今天这句话已练习过。');},
    'start-demo':()=>startDemo(false),
    'demo-ending':()=>startDemo(true),
    'exit-demo':exitDemo,
    'demo-next':()=>{const d=new Date(`${demoDate}T12:00:00`);d.setDate(d.getDate()+1);demoDate=localDateKey(d);navigate('camp');},
    reload:()=>location.reload(),
  };
  if(d.action)actions[d.action]?.();
});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.id==='spell-input'){event.preventDefault();$('[data-action="check-spell"]')?.click();}});
$('#parent-button').addEventListener('click',()=>{try{$('#export-backup').hidden=!localStorage.getItem('word-island:before-import');}catch{}$('#parent-dialog').showModal();});
$('#camera-reset').addEventListener('click',()=>world.resetCamera());
$('#demo-toggle').addEventListener('click',()=>demo?exitDemo():startDemo(false));
$('#reward-continue').addEventListener('click',()=>{$('#reward-dialog').close();navigate('home');if(clueCount()===7)world.focusObject('home.bunny');});
$('#export-progress').addEventListener('click',()=>{try{download(exportProgress(realProgress),`word-island-${localDateKey()}.json`);}catch(error){toast(error.message);}});
$('#export-backup').addEventListener('click',()=>{try{const text=localStorage.getItem('word-island:before-import');if(text)download(text,'word-island-before-import.json');}catch(error){toast(error.message);}});
$('#import-progress').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  try {
    if(file.size>=1024*1024)throw new Error('进度文件需小于 1 MiB。');
    pendingImport=importProgress(await file.text());
    $('#import-summary').textContent=`这份备份有 ${Object.keys(pendingImport.days).length} 天练习记录、${pendingImport.rewardDates.length} 条线索、${pendingImport.companions.length} 位伙伴。确认后在本机接着学习。`;
    $('#parent-dialog').close();$('#import-dialog').showModal();
  }catch(error){toast(error.message);}finally{event.target.value='';}
});
$('#confirm-import').addEventListener('click',()=>{
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成，再导入进度。');return;}
  if(!pendingImport)return;
  try {
    localStorage.setItem('word-island:before-import',exportProgress(realProgress));
    saveProgress(pendingImport);realProgress=pendingImport;pendingImport=null;demo=false;
    $('#import-dialog').close();navigate('home');toast('备份已导入，之前的本机进度也保留了一份备份。');
  }catch(error){toast(error.message);}
});
$('#import-audio').addEventListener('change',async event=>{
  let saved=0;const errors=[];
  for(const file of event.target.files){
    const name=file.name.replace(/\.[^.]+$/,'').toLowerCase();
    const key=getWord(name)?`word:${name}`:name.startsWith('phrase-')&&PHRASES.some(p=>p.id===name.slice(7))?`phrase:${name.slice(7)}`:null;
    if(!key){errors.push(`${file.name} 未找到对应单词或短句`);continue;}
    const mime=file.type.startsWith('audio/')?file.type:/\.m4a$/i.test(file.name)?'audio/mp4':/\.wav$/i.test(file.name)?'audio/wav':/\.mp3$/i.test(file.name)?'audio/mpeg':null;
    if(!mime){errors.push(`${file.name} 音频格式无法识别`);continue;}
    try{const blob=file.type===mime?file:new Blob([file],{type:mime});await putClip(key,blob);importedClips.set(key,blob);saved++;}catch(error){errors.push(error.message);}
  }
  $('#audio-import-status').textContent=`已保存 ${saved} 段本地音频。${errors.length?` ${errors.slice(0,3).join('；')}`:'只在这台设备使用。'}`;
  event.target.value='';
});
$('#prepare-offline').addEventListener('click',prepareOffline);
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){stopAudio();recordingRequest=null;if(recording&&recording.recorder.state!=='inactive')recording.recorder.stop();}
  else ensureToday();
});
window.addEventListener('pagehide',()=>{stopAudio();recording?.stream.getTracks().forEach(track=>track.stop());if(audioUrl)URL.revokeObjectURL(audioUrl);});
render();
if(loaded.error)toast(loaded.error,8500);
world.ready.then(prepareOffline).catch(()=>{});
// Read-only inspection surface for browser QA; never uploads or modifies progress.
window.__wordIsland={world,getState:()=>structuredClone({demo,page,phase,dateKey:today(),progress:progress(),realProgress,readingDone:readingDone(),activeWordId}),getDiagnostics:()=>world.getDiagnostics()};
