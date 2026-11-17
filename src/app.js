import { WorldView } from './world.js';
import { CompanionView } from './companion-view.js';
import { COMPANIONS, MAX_REWARD_DAYS, getCompanion, getCompanionJourney, getCompanionState, getClueForReward } from './companions.js';
import { COURSES, DEFAULT_UNIT_ID, WORDS, PHRASES, getWord, getUnit, getWordsForUnit, getPhrasesForUnit } from './content.js';
import { createInitialProgress, localDateKey, getDailyPlan, beginDailyAdventure, selectUnit, applyAnswer, applyPracticeAnswer, completeDailyAdventure } from './learning.js';
import { matchesSpelling, answerChoices } from './practice.js';
import { audioVariant, followAlongGapMs } from './speech-audio.js';
import { INTRO_COUNT, readGuide, nextIntro, endGuide, guidePrompt, adventurePrompt } from './story.js';
import { loadProgress, updateProgress, exportProgress, importProgress, getClip, putClip } from './storage.js';
import { MAX_PROFILES, PROFILE_REGISTRY_KEY, loadProfiles, createProfile, deleteProfile, getProfile, profileStorageKey, withProfileStorageLock } from './profiles.js';

const $ = selector => document.querySelector(selector);
const APP_VERSION='0.6.4';
const panel = $('#notebook-content');
let activeProfile=null;
let profileEpoch=0;
let profileBusy=false;
let progressBusy=false;
let profileToDelete=null;
let loaded = {progress:createInitialProgress(),error:null};
let realProgress = loaded.progress;
let demoProgress = createInitialProgress();
let demo = false;
let demoDate = '2026-01-01';
let dateKey = localDateKey();
let page = 'home';
let phase = 'overview';
let activeWordId = null;
let freeWordId = null;
let freeUnitId = null;
let shelfBookId = getUnit(realProgress.selectedUnitId || DEFAULT_UNIT_ID).bookId;
let feedback = null;
let hintUsed = false;
let phraseIndex = 0;
let pendingImport = null;
let pendingImportOwner=null;
let toastTimeout;
let recording = null;
let recordingRequest = null;
let audioUrl = null;
let activeAudio = null;
let activeAudioUrl = null;
let audioGeneration = 0;
let speechSession=null;
let followAlongTimer=null;
const importedClips = new Map();
const pendingClips = new Set();
let readDays = new Set();
const demoReadDays = new Set();
let offlineRegistration = null;
let offlineRegistrationTask=null;
let offlinePreparing=false;
let guide=readGuide(null);
let speech=null;
let speechOverride=null;
let storyPointerButton=null;
let selectedCompanionId=getCompanionJourney(realProgress).current?.id||'bunny';
let companionView=null;
let companionPreviewKey=null;
let rewardCompanionId=null;
const quietPrompts=new Set();

const progress = () => demo ? demoProgress : realProgress;
const today = () => demo ? demoDate : dateKey;
const plan = () => getDailyPlan(progress(), today());
const selectedUnit = () => getUnit(progress().selectedUnitId);
const dailyUnit = () => getUnit(plan().unitId);
const readingUnit = () => getUnit(freeUnitId || plan().unitId);
const phrases = () => getPhrasesForUnit(readingUnit().id);
const currentPhrase = () => phrases()[phraseIndex] || phrases()[0];
const readingContext = () => `${activeProfile?.id}:${profileEpoch}:${demo}:${today()}:${currentPhrase().id}`;
const spellingContext = () => `${activeProfile?.id}:${profileEpoch}:${demo}:${today()}:${phase}:${freeWordId||'daily'}:${activeWordId}`;
const completed = (id, skill) => Boolean(progress().days[today()]?.answers[id]?.[skill]?.completed);
const readingDone = (unitId=readingUnit().id) => {
  const days=demo?demoReadDays:readDays;
  return days.has(`${today()}:${unitId}`) || (unitId==='kb2-u6'&&days.has(today())) || (unitId===plan().unitId&&Boolean(progress().days[today()]?.completed));
};
const doneCount = skill => plan().wordIds.filter(id => completed(id, skill)).length;
const allDone = skill => doneCount(skill) === plan().wordIds.length;
const escapeText = text => String(text).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const clueCount = () => progress().rewardDates.length;
const journey = () => getCompanionJourney(progress());
const microphoneBusy = () => Boolean(recording || recordingRequest);
const personalKey = kind => profileStorageKey(activeProfile.id,kind);

function scrollNotebook() {
  if (window.innerWidth <= 850) requestAnimationFrame(() => $('.notebook').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'}));
}

function ensureToday() {
  if (demo || dateKey === localDateKey()) return true;
  dateKey = localDateKey(); phase='overview';activeWordId=null;freeWordId=null;freeUnitId=null;feedback=null;
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

async function setProgress(change,{real=false,...options}={}) {
  if(!activeProfile||progressBusy)return false;
  if(demo&&!real){demoProgress=change(demoProgress);return true;}
  const owner=activeProfile.id,epoch=profileEpoch;
  progressBusy=true;
  try {
    const next=await updateProgress(owner,change,{allowRecovery:Boolean(loaded.error),...options});
    if(activeProfile?.id!==owner||profileEpoch!==epoch)return false;
    realProgress=next;loaded={progress:next,error:null};return true;
  }catch(error){toast(error.message,8000);return false;}
  finally{progressBusy=false;if(!activeProfile)showProfileChooser();}
}

function parseReadingFlags(raw) {
  const flags=JSON.parse(raw||'[]');
  return new Set(Array.isArray(flags)?flags.filter(x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}(?::[a-z0-9-]+)?$/.test(x)):[]);
}

async function setReadingDone() {
  if(!activeProfile||progressBusy)return false;
  const flag=`${today()}:${readingUnit().id}`;
  if(demo){demoReadDays.add(flag);return true;}
  const owner=activeProfile.id,epoch=profileEpoch,key=personalKey('reading');
  progressBusy=true;
  try {
    const flags=await withProfileStorageLock(()=>{
      if(!getProfile(owner))throw new Error('这个名字已被删除，请重新选择。');
      let latest;try{latest=parseReadingFlags(localStorage.getItem(key));}catch{latest=new Set();}
      latest.add(flag);localStorage.setItem(key,JSON.stringify([...latest]));return latest;
    });
    if(activeProfile?.id!==owner||profileEpoch!==epoch)return false;
    readDays=flags;return true;
  }catch{toast('朗读记录尚未保存，请检查本机存储后再试一次。');return false;}
  finally{progressBusy=false;if(!activeProfile)showProfileChooser();}
}

function resetLearningContext() {
  profileEpoch+=1;stopAudio();
  if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl=null;}
  demo=false;demoProgress=createInitialProgress();demoReadDays.clear();
  pendingImport=null;pendingImportOwner=null;feedback=null;activeWordId=null;freeWordId=null;freeUnitId=null;phraseIndex=0;
  speechOverride=null;quietPrompts.clear();dateKey=localDateKey();page='home';phase='overview';
  companionPreviewKey=null;rewardCompanionId=null;
  clearTimeout(toastTimeout);$('#toast').hidden=true;
}

function renderProfileList() {
  const data=loadProfiles();
  $('#profile-list').innerHTML=data.profiles.map(profile=>{
    const stored=loadProgress(profile.id),days=Object.values(stored.progress.days).filter(day=>day.completed).length;
    return `<div class="profile-row"><button type="button" class="profile-select" data-profile-select="${profile.id}" ${profileBusy?'disabled':''}><img src="./assets/models/child-portrait.png" alt="" width="54" height="54"><span><strong>${escapeText(profile.name)}</strong><small>${stored.error?'记录暂时需要恢复':`完成 ${days} 天 · ${stored.progress.companions.length} 位伙伴`}</small></span><span aria-hidden="true">→</span></button><button type="button" class="profile-delete" data-profile-delete="${profile.id}" aria-label="删除${escapeText(profile.name)}及其进度" ${profileBusy?'disabled':''}>删除</button></div>`;
  }).join('');
  $('#profile-legacy').hidden=!data.legacyAvailable;
  $('#profile-name').disabled=profileBusy||Boolean(data.error)||data.profiles.length>=MAX_PROFILES;
  $('#create-profile').disabled=profileBusy||Boolean(data.error)||data.profiles.length>=MAX_PROFILES;
  $('#create-profile').textContent=profileBusy?'正在准备…':data.profiles.length>=MAX_PROFILES?'已有三个名字':'新建并出发';
  $('#profile-cancel').hidden=!activeProfile;
  $('#profile-cancel').disabled=profileBusy;
  if(data.error)$('#profile-error').textContent=data.error;
}

function showProfileChooser() {
  if(progressBusy){toast('正在收好这一步，请稍等一下。');return;}
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成，再切换名字。');return;}
  stopAudio();pendingImport=null;pendingImportOwner=null;
  for(const dialog of document.querySelectorAll('dialog[open]'))if(dialog.id!=='profile-dialog')dialog.close();
  $('#profile-error').textContent='';renderProfileList();
  if(!$('#profile-dialog').open)$('#profile-dialog').showModal();
  world.setActive(false);companionView?.setActive(false);
}

function activateProfile(id) {
  if(profileBusy||microphoneBusy())return;
  try {
    const profile=getProfile(id);if(!profile)throw new Error('这个名字已经不在本机了，请重新选择。');
    resetLearningContext();activeProfile=profile;loaded=loadProgress(id);realProgress=loaded.progress;
    readDays=new Set();guide=readGuide(null);
    try {
      guide=readGuide(localStorage.getItem(personalKey('guide')));
      readDays=parseReadingFlags(localStorage.getItem(personalKey('reading')));
    }catch { /* Learning can continue if an optional reading flag needs repeating. */ }
    shelfBookId=getUnit(realProgress.selectedUnitId).bookId;
    selectedCompanionId=getCompanionJourney(realProgress).current?.id||'bunny';
    world.setPlayerName(profile.name);
    $('#profile-dialog').close();render();
    if(loaded.error)toast(loaded.error,8500);
  }catch(error){$('#profile-error').textContent=error.message;renderProfileList();}
}

async function createNamedProfile(event) {
  event.preventDefault();if(profileBusy)return;
  profileBusy=true;$('#profile-error').textContent='';renderProfileList();
  try {
    const profile=await createProfile($('#profile-name').value);
    profileBusy=false;$('#profile-name').value='';activateProfile(profile.id);
  }catch(error){profileBusy=false;$('#profile-error').textContent=error.message;renderProfileList();}
}

function askDeleteProfile(id) {
  if(profileBusy)return;
  try {
    const profile=getProfile(id);if(!profile)return;
    profileToDelete=profile;$('#delete-profile-name').textContent=profile.name;$('#delete-profile-error').textContent='';
    $('#delete-profile-dialog').showModal();
  }catch(error){$('#profile-error').textContent=error.message;}
}

async function confirmDeleteProfile() {
  if(!profileToDelete||profileBusy)return;
  const id=profileToDelete.id;profileBusy=true;$('#confirm-delete-profile').disabled=true;
  try {
    await deleteProfile(id);
    if(activeProfile?.id===id){resetLearningContext();activeProfile=null;realProgress=createInitialProgress();readDays=new Set();guide=readGuide(null);loaded={progress:realProgress,error:null};render();}
    profileToDelete=null;$('#delete-profile-dialog').close();
  }catch(error){$('#delete-profile-error').textContent=error.message;}
  finally {profileBusy=false;$('#confirm-delete-profile').disabled=false;renderProfileList();}
}

function showWorldLoading({loaded=0,total=3,label='正在准备小岛…',bytesLoaded=0,elapsedMs=0}={}) {
  const loading=$('#world-loading');loading.hidden=false;
  if(loading.dataset.state!=='loading'){
    loading.dataset.state='loading';
    loading.innerHTML='<span class="loading-seed" aria-hidden="true">🌱</span><strong></strong><span></span><small>首次打开会下载三维场景，慢网时请稍等。</small>';
  }
  loading.querySelector('strong').textContent=label;
  const received=bytesLoaded>0?` · 已接收 ${Math.round(bytesLoaded/1024)} KB`:'';
  const elapsed=elapsedMs>=1000?` · ${Math.floor(elapsedMs/1000)} 秒`:'';
  loading.querySelector('span:last-of-type').textContent=`已准备 ${loaded} / ${total}${received}${elapsed}`;
}

function showWorldError(error) {
  const loading=$('#world-loading');loading.hidden=false;
  loading.dataset.state='error';
  loading.innerHTML='<span class="loading-seed" aria-hidden="true">🌱</span><strong>画面还没准备好</strong><span></span><button class="button" type="button" data-action="retry-world">再试一次</button><small></small><details><summary>查看加载信息</summary><pre></pre></details>';
  loading.querySelector('span:last-of-type').textContent=error.message;
  loading.querySelector('small').textContent=`学习记录还在。请保持联网，再试一次。版本 ${APP_VERSION}`;
  loading.querySelector('pre').textContent=JSON.stringify({version:APP_VERSION,...error.details},null,2);
}

async function retryWorld() {
  if(!world.renderer||/画面暂时中断|重新打开页面/.test(world.getDiagnostics().error||'')){location.reload();return;}
  $('#world-asset-retry').disabled=true;
  try {
    await world.retryLoads();
    if(world.getDiagnostics().sceneReady)$('#world-loading').hidden=true;
    $('#world-asset-retry').hidden=Object.keys(world.getDiagnostics().assetErrors).length===0;
  }catch(error){showWorldError(error);}
  finally{$('#world-asset-retry').disabled=false;}
}

const world = new WorldView($('#world-canvas'), {
  onInteract: handleWorldInteraction,
  onLoading:showWorldLoading,
  onReady() {},
  onSceneReady(){ $('#world-loading').hidden=true; },
  onAssetError(){ $('#world-asset-retry').hidden=false;toast('伙伴还在路上，先继续探索吧。稍后可以点“再接伙伴”。'); },
  onFrame: positionSpeech,
  onError:showWorldError,
});
world.ready.catch(() => {});

function handleWorldInteraction(id) {
  if(progressBusy){toast('正在收好这一步，请稍等一下。');return;}
  const pet=id.startsWith('home.')?getCompanion(id.slice(5)):null;
  if(pet&&progress().companions.includes(pet.id)){say({id:pet.id,actor:pet.id,title:'有你一起，真好',text:pet.message,button:`你好，${pet.name}！`,action:'close'});world.celebrate();return;}
  const actions = {
    'home.door': () => navigate('camp'),
    'home.bookshelf': openBooks,
    'home.clues': () => navigate('clues'),
    'character.guide': askHero,
    'character.hero':()=>{if(activeProfile)say({id:'player',actor:'hero',title:`${activeProfile.name}的小岛分身`,text:'准备好啦！和芽芽一起听听、拼拼、说一句，去认识小岛上的朋友。',button:'一起去探险',action:'camp'});},
    'camp.crate': () => enterTask('listen'),
    'camp.sign': () => enterTask('spell'),
    'camp.mailbox': () => enterTask('read'),
    'camp.chest': collectReward,
  };
  actions[id]?.();
}

function stopAudio() {
  audioGeneration += 1;
  clearTimeout(followAlongTimer);followAlongTimer=null;speechSession=null;
  activeAudio?.pause(); activeAudio = null;
  if(activeAudioUrl){URL.revokeObjectURL(activeAudioUrl);activeAudioUrl=null;}
  document.querySelectorAll('audio').forEach(player=>player.pause());
  speechStatus('');
}

function speechStatus(text,canStop=false) {
  const status=$('#follow-status');if(status)status.textContent=text;
  const stop=$('[data-action="stop-speaking"]');if(stop)stop.hidden=!canStop;
}

function speechAvailability() {
  document.querySelectorAll('[data-action="play-word"],[data-action="play-word-slow"],[data-action="play-phrase"],[data-action="play-phrase-slow"],[data-action="practice-phrase"]').forEach(button=>{button.disabled=!activeProfile||microphoneBusy();});
  const record=$('#record-button');if(record)record.disabled=!activeProfile||Boolean(recordingRequest);
  const playback=$('#recording-playback');if(playback)playback.controls=!microphoneBusy();
}

function preparePrompt(key) {
  if(importedClips.has(key)||pendingClips.has(key))return;
  pendingClips.add(key);
  getClip(key).then(blob=>importedClips.set(key,blob)).catch(()=>importedClips.set(key,null)).finally(()=>pendingClips.delete(key));
}

function navigate(next) {
  if(progressBusy){toast('正在收好这一步，请稍等一下。');return;}
  if (microphoneBusy()) { toast('先结束录音或等待麦克风请求完成，再去别处看看。'); return; }
  stopAudio();
  if(next==='camp')leaveIntro();
  page = next;
  phase = 'overview';
  freeWordId = null;
  freeUnitId = null;
  feedback = null;
  render();
  if(['home','camp','clues'].includes(next))bringSceneIntoView();
  else if(next==='growth')scrollNotebook();
}

function openBooks(bookId=selectedUnit().bookId) {
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}
  stopAudio();page='home';phase='books';freeWordId=null;freeUnitId=null;
  shelfBookId=COURSES.some(book=>book.id===bookId)?bookId:selectedUnit().bookId;render();scrollNotebook();
}

async function chooseUnit(id) {
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}
  stopAudio();if(!await setProgress(latest=>selectUnit(latest,id)))return false;
  shelfBookId=getUnit(id).bookId;
  phase='books';page='home';freeWordId=null;freeUnitId=null;phraseIndex=0;render();
  if(plan().unitId!==id)toast('这个单元已选好。今天开始过的任务会保留，你也可以先自由练习新单元。',6500);
  return true;
}

async function enterTask(skill, wordId = null, unitId = null) {
  if (!ensureToday()) return;
  if (microphoneBusy()) { toast('先结束录音或等待麦克风请求完成。'); return; }
  stopAudio();
  leaveIntro();
  if(!wordId&&!unitId){const date=today();if(!await setProgress(latest=>beginDailyAdventure(latest,date)))return;}
  page = 'camp'; phase = skill; freeWordId = wordId;freeUnitId=unitId;
  if(skill==='read')phraseIndex=Math.max(0,phrases().findIndex(phrase=>phrase.id===plan().phraseId));
  activeWordId = skill==='read'?null:wordId || plan().wordIds.find(id => !completed(id, skill)) || null;
  feedback = null; hintUsed = false;
  render();
  if(speech?.guided)world.resetCamera();
  else world.focusObject(skill === 'listen' ? 'camp.crate' : skill === 'spell' ? 'camp.sign' : 'camp.mailbox');
  if (skill === 'read') loadRecording();
  if(speech?.guided)bringSceneIntoView();else scrollNotebook();
}

function clueTrack(count=journey().roundCount) {
  return `<div class="clue-track" aria-label="这一轮已经获得 ${count} 条线索，共七条">${Array.from({length:7},(_,i)=>`<span class="clue-dot ${i<count?'found':''}">${i<count?'✦':i+1}</span>`).join('')}</div>`;
}

function taskList() {
  return `<ul class="task-list">${[
    ['listen', '听懂营地的新发现', `${doneCount('listen')} / ${plan().wordIds.length} 个词 · 去探索木箱`, allDone('listen')],
    ['spell', '拼出路牌上的秘密', `${doneCount('spell')} / ${plan().wordIds.length} 个词 · 去探险路牌`, allDone('spell')],
    ['read', '给新朋友留一句话', readingDone() ? '今天已经开口练习过' : '听、跟读、录下自己的声音', readingDone()],
  ].map(([skill, title, detail, done]) => `<li><button type="button" data-task="${skill}"><span class="task-mark ${done ? 'complete' : ''}">${done ? '✓' : skill === 'listen' ? '1' : skill === 'spell' ? '2' : '3'}</span><span><strong>${title}</strong><small>${detail}</small></span><span class="task-arrow">↗</span></button></li>`).join('')}</ul>`;
}

function overview() {
  const unit=dailyUnit(), daily=plan(), route=journey(), allFriends=!route.current;
  const finished=Boolean(progress().days[today()]?.completed);
  const known=daily.reviewWordIds.length, fresh=daily.newWordIds.length;
  const locked=daily.unitId!==selectedUnit().id;
  return `<div class="notebook-label"><span>TODAY’S LITTLE ADVENTURE</span><span class="small-tag">${demo?'演示存档':'约 10–15 分钟'}</span></div>
    <h2>${allFriends?'和朋友们一起，继续探索':finished?'今天的小任务已收好':page==='home'?'新朋友在等你发现':`${unit.theme}的小秘密`}</h2>
    <p class="description">${allFriends?'八位伙伴都住进小屋啦。每天听一点、拼一点，和朋友们一起发现新故事。':finished?'今天又向新朋友走近了一步。可以回小屋看看，也可以自由练习。':`今天探索“${unit.theme}”。帮芽芽听懂、拼出这些词，再给新朋友留一句话。`}</p>
    <button type="button" class="course-label course-link" data-action="open-books">▤ ${unit.title} <span>换单元 ↗</span></button>
    ${locked?`<p class="plan-note">今天已开始这个单元的任务。书架新选的 ${selectedUnit().unitTitle} 将用于下一次新计划，也可以先自由练习。</p>`:''}
    <div class="section-divider"></div><div class="progress-caption"><span>${allFriends?'八位伙伴都到家了':`正在寻找 ${route.current.name}`}</span><span>${route.roundCount} / 7 条线索</span></div>${clueTrack()}
    <p class="next-clue">${allFriends?'相遇的朋友会一直留下，接着一起慢慢学。':'每七次累计完成迎来一位伙伴，漏一天也保留。'}</p>
    ${page==='home'?`<button type="button" class="button primary wide" data-nav="camp">${finished||allFriends?'再去营地练一练':'出发，找新朋友'} →</button><div class="pet-message"><span>🦊</span><p>芽芽的今日计划<br>${known?`先复习 ${known} 个词`:'从几个小小的单词开始'}${fresh?`，再认识 ${fresh} 个新词。`:'，慢慢记牢就很好。'}</p></div><button type="button" class="button subtle wide" data-nav="clues">看看八位伙伴，谁在等着我们？</button><button type="button" class="button subtle wide" data-action="open-books">打开教材书架，自己挑一挑</button>`:
    `${taskList()}<button type="button" class="button primary wide" data-action="collect">${finished?'查看已找到的线索':allFriends?'收好今天的练习':'打开线索宝箱'} →</button><div class="pet-message"><span>🌿</span><p>不必一次全对。想不起来，就看看提示，再试一次。</p></div>`}
    ${demo&&finished?'<button type="button" class="button wide" data-action="demo-next">继续下一次冒险（演示） →</button>':''}`;
}

function skillFinished(skill) {
  const next=!allDone('listen')?'listen':!allDone('spell')?'spell':!readingDone(plan().unitId)?'read':null;
  const labels={listen:['木箱听一听','继续听一听'],spell:['路牌拼一拼','继续拼一拼'],read:['邮筒说一句话','和新朋友说句话']};
  const detail=next?`去${labels[next][0]}，完成今天探索的下一步吧。`:'三个小任务都完成了，去宝箱收好今天的线索吧。';
  return `<div class="exercise-header"><button type="button" class="text-button" data-action="back-task">← 今日任务</button><span class="small-tag">已完成</span></div><span class="eyebrow">YOU DID IT</span><h2>${skill === 'listen' ? '耳朵找到线索啦' : '这些词，你拼出来了'}</h2><p class="description">今天这里的 ${plan().wordIds.length} 个词已经练过。${detail}</p><button type="button" class="button primary wide" ${next?`data-task="${next}"`:'data-action="collect"'}>${next?labels[next][1]:'打开线索宝箱'} →</button><button type="button" class="button subtle wide" data-action="back-task">回到营地手记</button>`;
}

function question(skill) {
  if (!activeWordId) return skillFinished(skill);
  const word = getWord(activeWordId);
  const ids = freeWordId ? [freeWordId] : plan().wordIds;
  const n = freeWordId ? 1 : ids.indexOf(word.id) + 1;
  const rotated = answerChoices(word,getWordsForUnit(dailyUnit().id),WORDS,today());
  return `<div class="exercise-header"><button type="button" class="text-button" data-action="back-task">← 今日任务</button><span class="exercise-counter">${freeWordId ? '自由练习' : `${n} / ${ids.length}`}</span></div><span class="eyebrow">${skill === 'listen' ? 'LISTEN & FIND' : 'LISTEN & SPELL'}</span><h2 class="question-title">${skill === 'listen' ? '听听，芽芽需要哪一样？' : `试着拼出“${word.zh}”`}</h2><button type="button" class="audio-button" data-action="play-word" aria-label="播放单词常速示范音">▷</button><p class="audio-caption" id="audio-source">轻点播放常速 · 可以多听几遍</p><div class="word-audio-options"><button type="button" class="button" data-action="play-word-slow">▷ 慢一点听</button></div>${skill === 'listen' ? `<div class="answer-grid">${rotated.map(w => `<button type="button" class="answer ${feedback?.selected === w.id ? feedback.correct ? 'correct' : 'wrong' : ''}" data-answer="${w.id}" ${feedback?.correct ? 'disabled' : ''}><span class="emoji" aria-hidden="true">${w.emoji}</span>${w.zh}</button>`).join('')}</div>` : `<input class="spell-input" id="spell-input" aria-label="输入英语单词" placeholder="在这里拼一拼" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" ${feedback?.correct ? 'disabled' : ''}><button type="button" class="button wide" data-action="check-spell" ${feedback?.correct ? 'disabled' : ''}>检查一下</button>`}<div class="feedback ${feedback && !feedback.correct ? 'error' : ''}" role="status">${feedback ? escapeText(feedback.text) : skill === 'listen' ? '可以多听几次，慢慢找到它。' : `试着听声音来拼，或想想 ${word.en[0]} 开头的词。`}</div>${hintUsed || feedback?.correct ? `<div class="word-reveal">${word.en}</div><div class="phonics">${word.phonics}</div>` : ''}${feedback?.correct ? '<button type="button" class="button primary wide" data-action="next-question">收好这个词，继续 →</button>' : '<button type="button" class="button subtle wide" data-action="hint">给我一点提示</button>'}`;
}

function reading() {
  const phrase=currentPhrase(), unit=readingUnit(), list=phrases();
  return `<div class="exercise-header"><button type="button" class="text-button" data-action="back-task">← ${freeUnitId?'回教材书架':'今日任务'}</button><span class="small-tag">${readingDone()?'本单元今天已练习':'开口就很棒'}</span></div>
    <span class="eyebrow">A MESSAGE FOR A FRIEND</span><h2 class="question-title">和芽芽说说${unit.theme}</h2>
    <p class="record-help">${unit.title}${freeUnitId?' · 自由跟读':''}</p>
    <div class="phrase-selector">${list.map((p,i)=>`<button type="button" data-phrase="${i}" class="${i===phraseIndex?'active':''}">短句 ${i+1}</button>`).join('')}</div>
    <div class="phrase-card"><p class="english">${phrase.en}</p><p class="chinese">${phrase.zh}</p></div><p class="record-help">软件补充示例句 · 合成示范，非教材原音</p>
    <div class="phrase-audio-options"><button type="button" class="button" data-action="play-phrase">▷ 听常速</button><button type="button" class="button" data-action="play-phrase-slow">▷ 听慢读</button></div><p class="audio-caption" id="audio-source">先听整句，再试着跟读</p>
    <button type="button" class="button wide" data-action="practice-phrase">听一句，跟一句 →</button><p class="follow-status" id="follow-status" role="status" aria-live="polite"></p><button type="button" class="text-button" data-action="stop-speaking" hidden>暂停这轮跟读</button>
    <div class="button-row"><button type="button" class="record-button ${recording?'recording':''}" id="record-button" data-action="record">${recording?'■ 结束录音':'● 录下我的声音'}</button></div>
    <p class="recording-status" id="recording-status">${recording?'正在录音，最长 30 秒…':''}</p><audio class="recording-playback" id="recording-playback" controls hidden></audio>
    <p class="record-help">每一句分别保存录音，只留在这台设备。可以听听自己的声音，也可以先读给家长听。</p>
    <button type="button" class="button primary wide" data-action="finish-reading">${readingDone()?'已读过，继续探索 →':'我已经开口读过了 →'}</button>`;
}

function clues() {
  const selected=getCompanionState(progress(),selectedCompanionId), pet=selected.pet, route=journey();
  const status=selected.status==='unlocked'?'已入住':selected.status==='current'?'寻找中':'未相遇';
  return `<div class="notebook-label"><span>OUR LITTLE FRIENDS</span><span class="small-tag">${progress().companions.length} / ${COMPANIONS.length} 已入住</span></div><h2>等你认识的朋友</h2><p class="description">点一位伙伴，就能转着看看它。每攒七条线索，邀请一位朋友住进小屋。</p>
    <div class="companion-grid">${COMPANIONS.map(item=>{const state=getCompanionState(progress(),item.id);return `<button type="button" class="companion-card ${state.status==='unlocked'?'unlocked':''}" data-companion="${item.id}" aria-pressed="${pet.id===item.id}" aria-label="${item.name}，${item.species}，${state.status==='unlocked'?'已入住':state.status==='current'?'寻找中':'未相遇'}"><img src="./${item.portraitFile}" alt="${item.name}的三维形象" width="128" height="108"><strong>${item.name} · ${item.species}</strong><small>${state.status==='unlocked'?'✓ 已入住':state.status==='current'?'寻找中':'未相遇'}</small></button>`;}).join('')}</div>
    <div class="companion-profile"><div class="progress-caption"><h3>${pet.name} · ${pet.species}</h3><span class="small-tag">${status}</span></div><p class="description">${pet.personality}<br>${pet.description}</p>${clueTrack(selected.clueCount)}
    <p class="record-help">${selected.status==='unlocked'?`${pet.name}已经住进小屋，会一直陪着你。`:selected.status==='current'?`已找到 ${selected.clueCount} / 7 条线索，再完成 ${7-selected.clueCount} 天学习就能相遇。`:`先找到${route.current.name}，再沿着小路认识后面的朋友。`}</p>
    ${selected.status==='unlocked'?'<button type="button" class="button primary wide" data-action="visit-companion">回小屋和它说句话 →</button>':`<button type="button" class="button primary wide" data-nav="camp">去找${route.current.name}的线索 →</button>`}</div>
    <div class="clue-list">${pet.clues.map((clue,i)=>`<div class="clue-item ${i>=selected.clueCount?'locked':''}"><span>${i<selected.clueCount?clue.emoji:'·'}</span><div><h3>${i<selected.clueCount?clue.title:`第 ${i+1} 次小发现`}</h3><p>${i<selected.clueCount?clue.description:'完成学习以后，这一页故事会亮起来。'}</p></div></div>`).join('')}</div>`;
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
  const book=COURSES.find(book=>book.id===shelfBookId)||COURSES[0];
  const chosen=selectedUnit();
  const unit=book.units.find(unit=>unit.id===chosen.id)||book.units[0];
  const words=getWordsForUnit(unit.id), phrases=getPhrasesForUnit(unit.id);
  const seen=words.filter(word=>progress().words[word.id]).length;
  const pages=unit.printedPages?`教材 p${unit.printedPages[0]}–${unit.printedPages[1]}`:'之前的单元练习';
  return `<div class="exercise-header"><button type="button" class="text-button" data-nav="home">← 回到小屋</button><span class="small-tag">教材书架</span></div>
    <h2>今天，翻开哪一课？</h2><label class="book-picker-label" for="book-select">选择教材</label><select id="book-select" class="book-picker">${COURSES.map(book=>`<option value="${book.id}" ${book.id===shelfBookId?'selected':''}>${book.title} · ${book.units.length} 个单元</option>`).join('')}</select>
    <div class="unit-grid">${book.units.map(item=>`<button type="button" class="unit-tile" data-unit="${item.id}" aria-pressed="${item.id===chosen.id}"><span>${item.unit===0?'开篇':'Unit '+item.unit}</span><strong>${item.unitTitle}</strong><small>${item.theme}</small></button>`).join('')}</div>
    <div class="shelf-book"><div class="book-cover"><span>Kid’s Box</span><strong>${unit.level}</strong></div><div><h3>${unit.unitTitle}</h3><p class="description" style="margin-top:5px">${unit.theme}</p><p class="record-help">${pages} · ${words.length} 个核心词 · 已接触 ${seen} 个</p></div></div>
    <button type="button" class="button primary wide" data-action="start-unit" data-start-unit="${unit.id}">${unit.id===plan().unitId?'从这个单元开始':'选择这个单元并出发'} →</button>
    <p class="record-help">${progress().days[today()]&&unit.id!==plan().unitId?'今天开始过的计划会保留。新选择用于下一次新计划，下面可以先自由练习。':'每日计划会先安排到期复习，再加入本单元新词。也可以自己挑一个词。'}</p>
    <div class="word-chips">${words.map(word=>`<button type="button" data-free-word="${word.id}">${word.en}</button>`).join('')}</div>
    <button type="button" class="button wide" data-reading-unit="${unit.id}">听听、读读本单元的 ${phrases.length} 句短语 →</button>
    <div class="phonics">${unit.phonics.title}<br>${unit.phonics.description}</div>
    <p class="record-help">对应教材练核心词，短句和拼读提示帮助你开口。每天一点，熟悉的词也会在别的单元再次见面。</p>`;
}

function render() {
  const previousInput=$('#spell-input');
  const draft=previousInput?.dataset.context===spellingContext()?{value:previousInput.value,start:previousInput.selectionStart,end:previousInput.selectionEnd,focused:document.activeElement===previousInput}:null;
  $('#active-user-name').textContent=activeProfile?.name||'选择名字';
  $('#user-button').setAttribute('aria-label',activeProfile?`当前用户${activeProfile.name}，切换或管理名字`:'选择本地用户');
  $('#parent-profile-title').textContent=activeProfile?`${activeProfile.name}的学习进度`:'当前用户的学习进度';
  document.querySelectorAll('.main-nav button').forEach(button => {
    if (button.dataset.nav === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('.nav-count').textContent = `${progress().companions.length}/${COMPANIONS.length}`;
  $('#demo-banner').hidden = !demo;
  $('#demo-toggle').textContent = demo ? '返回真实存档 ↗' : '试玩七日故事 ↗';
  const sceneName = page === 'camp' ? 'camp' : 'home';
  world.setScene(sceneName);
  world.setCompanionsUnlocked(progress().companions);
  $('#scene-kicker').textContent = demo ? '演示存档 · 可以快进故事，不写入真实进度' : page === 'camp' ? '今天，再向新朋友靠近一点' : '一个慢慢长大的小世界';
  $('#scene-title').textContent = page === 'camp' ? '林间营地，有新的发现' : activeProfile?`${activeProfile.name}的小屋`:'欢迎来到词遇岛';
  $('#world-location').textContent = sceneName === 'home' ? '暖暖小屋' : '林间营地';
  $('#world-caption').textContent = sceneName === 'home' ? '轻点门去冒险，轻点书柜选单词，线索板记着你找到的每一次惊喜。' : '营地里的木箱、路牌、邮筒都藏着一个小任务。也可以用下面的入口开始。';
  $('#scene-shortcuts').innerHTML = (sceneName === 'home' ? [
    ['home.door','↗','推门出发','去找新的伙伴'],['home.bookshelf','▤','翻翻书架','也能自己挑单词'],['home.clues','✧','看看线索','每一步都会留下来'],
  ] : [
    ['camp.crate','◖','听音找线索',`${doneCount('listen')} / ${plan().wordIds.length} 已完成`],['camp.sign','Aa','拼写小秘密',`${doneCount('spell')} / ${plan().wordIds.length} 已完成`],['camp.mailbox','♪','给朋友留言',readingDone(plan().unitId) ? '已经开口练习过' : '听、跟读、录下来'],
  ]).map(([id, icon, title, subtitle]) => `<button type="button" class="shortcut" data-object="${id}"><span class="shortcut-icon" aria-hidden="true">${icon}</span><span><strong>${title}</strong><small>${subtitle}</small></span></button>`).join('');
  if(page==='clues') {
    const state=getCompanionState(progress(),selectedCompanionId), pet=state.pet;
    const previous=COMPANIONS[(pet.index+COMPANIONS.length-1)%COMPANIONS.length], next=COMPANIONS[(pet.index+1)%COMPANIONS.length];
    $('#scene-kicker').textContent=demo?'演示图鉴 · 不影响真实学习进度':'八位小伙伴 · 等你慢慢认识';
    $('#scene-title').textContent=`${pet.name} · ${pet.species}`;
    $('#world-location').textContent=state.status==='unlocked'?'已入住 · 恢复了自己的颜色':state.status==='current'?'寻找中 · 七条线索就能相遇':'未相遇 · 它在小岛的前方等你';
    $('#world-caption').textContent=`${pet.personality}。${pet.description} 拖动可以看看侧面和背后。`;
    $('#scene-shortcuts').innerHTML=`<button type="button" class="shortcut" data-companion-switch="${previous.id}"><span class="shortcut-icon">←</span><span><strong>上一位朋友</strong><small>${previous.name}</small></span></button><button type="button" class="shortcut" data-nav="home"><span class="shortcut-icon">⌂</span><span><strong>看看我的小屋</strong><small>${progress().companions.length} 位伙伴已入住</small></span></button><button type="button" class="shortcut" data-companion-switch="${next.id}"><span class="shortcut-icon">→</span><span><strong>下一位朋友</strong><small>${next.name}</small></span></button>`;
  }
  syncCompanionPreview();
  panel.innerHTML = page === 'clues' ? clues() : page === 'growth' ? growth() : phase === 'books' ? books() : phase === 'listen' || phase === 'spell' ? question(phase) : phase === 'read' ? reading() : overview();
  const input=$('#spell-input');
  if(input){
    input.dataset.context=spellingContext();
    if(draft){
      input.value=draft.value;input.setSelectionRange(draft.start,draft.end);
      if(draft.focused&&!input.disabled)input.focus({preventScroll:true});
    }
  }
  if((phase==='listen'||phase==='spell')&&activeWordId)preparePrompt(`word:${activeWordId}`);
  if(phase==='read')preparePrompt(`phrase:${currentPhrase().id}`);
  renderStory();
  speechAvailability();
}

function syncCompanionPreview() {
  const showing=page==='clues';
  $('#world-canvas').hidden=showing;
  $('#companion-preview').hidden=!showing;
  $('#ask-hero').hidden=showing;
  world.setActive(!showing&&Boolean(activeProfile)&&!$('#profile-dialog').open);
  if(!showing){companionView?.setActive(false);$('#companion-loading').hidden=true;return;}
  if(!companionView) {
    companionView=new CompanionView($('#companion-preview'));
    companionView.ready.catch(()=>{});
  }
  companionView.setActive(Boolean(activeProfile)&&!$('#profile-dialog').open);
  const unlocked=progress().companions.includes(selectedCompanionId), key=`${selectedCompanionId}:${unlocked}`;
  if(key===companionPreviewKey)return;
  companionPreviewKey=key;
  $('#companion-loading').hidden=false;
  $('#companion-loading').textContent='伙伴正在和你打招呼…';
  companionView.setCompanion(selectedCompanionId,unlocked).then(()=>{
    if(companionPreviewKey===key)$('#companion-loading').hidden=true;
  }).catch(()=>{
    if(companionPreviewKey===key){$('#companion-loading').innerHTML='这位伙伴暂时还没准备好。联网后再试一下吧。<button type="button" class="button" data-action="retry-companion">再看一次</button>';}
  });
}

function chooseCompanion(id) {
  if(!getCompanion(id))return;
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成，再去看伙伴。');return;}
  selectedCompanionId=id;navigate('clues');bringSceneIntoView();
}

function visitCompanion() {
  if(!progress().companions.includes(selectedCompanionId))return;
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}
  navigate('home');world.focusObject(`home.${selectedCompanionId}`);bringSceneIntoView();
}

function storyContext() {
  return {page,phase,demo,listenDone:allDone('listen'),spellDone:allDone('spell'),readDone:readingDone(plan().unitId),dailyFinished:Boolean(progress().days[today()]?.completed),clueCount:clueCount(),freePractice:Boolean(freeWordId||freeUnitId)};
}

function speechScope() { return `${demo}:${today()}:${page}:${phase}:${doneCount('listen')}:${doneCount('spell')}:${readingDone(plan().unitId)}:${clueCount()}`; }

function saveGuide(next) {
  if(demo||!activeProfile)return;
  guide=next;
  try { localStorage.setItem(personalKey('guide'),JSON.stringify(guide)); } catch { /* Story settings must not block learning or modify its save. */ }
}

function leaveIntro() {
  if(guide.status==='active'&&guide.intro<INTRO_COUNT)saveGuide({...guide,intro:INTRO_COUNT});
}

function renderStory() {
  if(speechOverride?.scope!==speechScope())speechOverride=null;
  const automatic=activeProfile?guidePrompt(guide,storyContext()):null;
  const prompt=speechOverride?.prompt||(automatic&&!quietPrompts.has(automatic.id)?{...automatic,guided:true}:null);
  const next=prompt?{actor:'guide',...prompt}:null;
  const bubble=$('#character-speech');
  const changed=JSON.stringify(next)!==JSON.stringify(speech);
  speech=next;
  bubble.hidden=!speech;
  document.querySelectorAll('[data-object]').forEach(button=>button.classList.toggle('guide-target',Boolean(speech?.target&&button.dataset.object===speech.target)));
  if(!speech)return;
  if(changed) {
    if(speech.guided)world.resetCamera();
    const pet=getCompanion(speech.actor), name=speech.actor==='hero'?activeProfile?.name||'小探险家':pet?.name||'芽芽';
    bubble.innerHTML=`<div class="speech-heading"><span class="speech-avatar" aria-hidden="true">${speech.actor==='hero'?'🧒':pet?.emoji||'🦊'}</span><div><strong>${escapeText(name)}</strong><small>${escapeText(speech.chapter||'陪你一起探险')}</small></div><button type="button" class="speech-dismiss" data-story-action="${speech.guided?'skip':'close'}">${speech.guided?'跳过引导':'收起'}</button></div><div class="speech-copy" aria-live="polite" aria-atomic="true"><h2>${escapeText(speech.title)}</h2><p>${escapeText(speech.text)}</p></div><button type="button" class="speech-next" data-story-action="${speech.action}">${escapeText(speech.button)} <span aria-hidden="true">→</span></button>`;
  }
  positionSpeech();
}

function positionSpeech() {
  if(!speech)return;
  const bubble=$('#character-speech');
  if(bubble.hidden)return;
  const anchor=world.getActorScreenPoint?.(speech.actor);
  bubble.style.visibility=anchor?.visible?'visible':'hidden';
  if(!anchor?.visible)return;
  const frame=$('.world-frame'), width=bubble.offsetWidth, height=bubble.offsetHeight;
  const left=Math.max(12,Math.min(frame.clientWidth-width-12,anchor.x-width/2));
  const top=Math.max(12,Math.min(frame.clientHeight-height-57,anchor.y-height-18));
  bubble.style.left=`${Math.round(left)}px`;
  bubble.style.top=`${Math.round(top)}px`;
  bubble.style.setProperty('--speech-tail',`${Math.max(22,Math.min(width-22,anchor.x-left))}px`);
}

function bringSceneIntoView() {
  if(window.innerWidth<=850) $('.world-frame').scrollIntoView({behavior:'instant',block:'center'});
}

function say(prompt) {
  if(!world.getActorScreenPoint(prompt.actor||'guide')?.visible)world.resetCamera();
  speechOverride={scope:speechScope(),prompt};
  renderStory();bringSceneIntoView();
}

function askHero() {
  if(!activeProfile){showProfileChooser();return;}
  const prompt=guidePrompt(guide,storyContext())||adventurePrompt(storyContext());
  say({...prompt,actor:'guide'});
}

function storyAction(action) {
  if(microphoneBusy()&&['camp','home','listen','spell','read','collect'].includes(action)){toast('先结束录音或等待麦克风请求完成，再继续探险。');return;}
  if(action==='skip') { saveGuide(endGuide(guide,'skipped'));speechOverride=null;renderStory();return; }
  if(action==='close'||action==='practice') {
    const target=speech?.target;
    if(speech)quietPrompts.add(speech.id);
    speechOverride=null;renderStory();
    if(action==='practice'){if(target)world.focusObject(target);scrollNotebook();}
    return;
  }
  if(action==='next') { saveGuide(nextIntro(guide));speechOverride=null;renderStory();return; }
  if(action==='finish') { saveGuide(endGuide(guide));speechOverride=null;renderStory();return; }
  speechOverride=null;
  if(action==='camp')navigate('camp');
  else if(action==='home')navigate('home');
  else if(['listen','spell','read'].includes(action))enterTask(action);
  else if(action==='collect')collectReward();
  if(action==='camp'||action==='home')bringSceneIntoView();
}

function replayStory() {
  if(!activeProfile){showProfileChooser();return;}
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成，再听芽芽讲故事。');return;}
  if(demo){toast('回到真实小屋后，就能听芽芽讲故事。');return;}
  quietPrompts.clear();speechOverride=null;saveGuide(readGuide(null));navigate('home');bringSceneIntoView();
}

function playPrompt(key,{slow=false,repeat=false}={}) {
  if(!activeProfile){showProfileChooser();return;}
  if(microphoneBusy()){toast('正在录音时先不播放示范，免得把示范音也录进去。');return;}
  stopAudio();
  const generation=audioGeneration;
  let blob=importedClips.get(key);
  const session={passes:0,fallback:false};speechSession=session;
  const current=()=>generation===audioGeneration&&speechSession===session;
  const play=()=>{
    if(!current())return;
    const sourceBlob=blob,variant=audioVariant(key,{slow,imported:Boolean(sourceBlob)});
    const url=sourceBlob?URL.createObjectURL(sourceBlob):new URL(`../${variant.file}`,import.meta.url).href;
    const audio=new Audio(url);activeAudio=audio;if(sourceBlob)activeAudioUrl=url;
    audio.playbackRate=variant.playbackRate;audio.preservesPitch=variant.preservesPitch;
    if('webkitPreservesPitch' in audio)audio.webkitPreservesPitch=true;
    session.passes+=1;
    const release=()=>{if(sourceBlob)URL.revokeObjectURL(url);if(activeAudioUrl===url)activeAudioUrl=null;};
    let failed=false;
    const fail=error=>{
      release();if(!current()||failed)return;failed=true;clearTimeout(followAlongTimer);followAlongTimer=null;activeAudio=null;
      if(sourceBlob&&!session.fallback){
        session.fallback=true;session.passes-=1;blob=null;importedClips.set(key,null);
        toast('导入的音频暂时无法播放，先听内置示范。可以在家长入口重新导入。');play();return;
      }
      speechSession=null;
      speechStatus('暂时没能播放，准备好后再试一次。');
      if(error?.name!=='AbortError')toast('这段声音暂时无法播放，请再点一次；也可以联网准备资源或重新导入音频。');
    };
    audio.addEventListener('error',fail,{once:true});
    audio.addEventListener('ended',()=>{
      release();if(!current())return;activeAudio=null;
      if(repeat&&session.passes===1){
        const gap=followAlongGapMs(audio.duration,audio.playbackRate);
        speechStatus(`轮到你啦，留 ${Math.round(gap/1000)} 秒跟着读。然后再听一遍。`,true);
        followAlongTimer=setTimeout(()=>{followAlongTimer=null;if(current())play();},gap);
      }else {speechSession=null;speechStatus(repeat?'这一轮听完啦。可以录下自己的声音，再听听。':'');}
    },{once:true});
    // The first play stays inside the tap; local imported blobs are prepared on entry.
    speechStatus(repeat?(session.passes===1?'先听示范，听完就轮到你。':'再听一遍，看看这次能不能跟上。'):'正在听示范…',true);
    audio.play().then(()=>{const source=$('#audio-source');if(current()&&source)source.textContent=variant.label;}).catch(fail);
  };
  play();
}

async function answer(correct, selected = null) {
  if(!ensureToday())return;
  if (!activeWordId || feedback?.correct) return;
  const word = getWord(activeWordId);
  const response={wordId:word.id,skill:phase,correct,usedHint:hintUsed,dateKey:today()},practice=Boolean(freeWordId),expected=JSON.stringify(plan());
  if(!await setProgress(latest=>{
    if(!practice&&JSON.stringify(getDailyPlan(latest,response.dateKey))!==expected)throw new Error('今日计划已在另一个窗口更新，请重新打开任务。');
    return (practice?applyPracticeAnswer:applyAnswer)(latest,response);
  }))return;
  feedback = {correct,selected,text:correct ? `找到了！${word.en} 是${word.zh}。` : phase === 'spell' ? '再试一次。可以听一听声音，也可以看看拼读提示。' : '还差一点点，再听一次，或者看看提示。'};
  if (correct) world.celebrate();
  render();
  if(correct)$('[data-action="next-question"]')?.focus({preventScroll:true});
  else if(phase==='spell')$('#spell-input')?.focus({preventScroll:true});
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
  if(phase==='spell')$('#spell-input')?.focus({preventScroll:true});
}

async function collectReward() {
  if(!ensureToday())return;
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}
  stopAudio();
  if (progress().days[today()]?.completed) { navigate('clues'); return; }
  if (!allDone('listen') || !allDone('spell') || !readingDone(plan().unitId)) {
    toast('先完成木箱的听辨、路牌的拼写，再到邮筒开口读一句。线索宝箱会等着你。', 6500);
    page='camp'; phase='overview'; render(); return;
  }
  const date=today();let before,result;
  if(!await setProgress(latest=>{before=latest.rewardDates.length;result=completeDailyAdventure(latest,date);return result.progress;}))return;
  if (!result.rewarded) { toast('今天的练习已收好，伙伴们在小屋等你。'); render(); return; }
  world.celebrate();
  const clue = getClueForReward(before);
  rewardCompanionId=result.unlockedCompanionId||null;
  if(rewardCompanionId){selectedCompanionId=rewardCompanionId;$('#reward-emoji').innerHTML=`<img src="./${clue.companion.portraitFile}" alt="${clue.companion.name}">`;}
  else $('#reward-emoji').textContent = clue.emoji;
  $('#reward-title').textContent = clue.title;
  $('#reward-description').textContent = clue.description;
  $('#reward-dots').innerHTML = Array.from({length:7},(_,i)=>`<span class="${i<clue.index?'done':''}"></span>`).join('');
  $('#reward-continue').textContent = rewardCompanionId ? `带${clue.companion.name}回家 →` : '把线索带回小屋 →';
  render(); $('#reward-dialog').showModal();
}

function startDemo(ending = false) {
  if(!activeProfile){showProfileChooser();return;}
  if(progressBusy){toast('正在收好这一步，请稍等一下。');return;}
  if (microphoneBusy()) { toast('先结束录音或等待麦克风请求完成，再进入演示。'); return; }
  stopAudio();
  demo = true; demoProgress = createInitialProgress(); demoDate = '2026-01-01'; demoReadDays.clear();
  if (ending) {
    const days=ending==='all'?MAX_REWARD_DAYS:7;
    for (let n=0; n<days; n++) {
      const date=new Date('2026-01-01T12:00:00');date.setDate(date.getDate()+n);demoDate=localDateKey(date);
      for (const item of getDailyPlan(demoProgress,demoDate).required) demoProgress = applyAnswer(demoProgress,{...item,correct:true,usedHint:false,dateKey:demoDate});
      demoReadDays.add(`${demoDate}:${getDailyPlan(demoProgress,demoDate).unitId}`);
      demoProgress = completeDailyAdventure(demoProgress,demoDate).progress;
    }
  }
  $('#parent-dialog').close();
  navigate('home');
  if (ending) { if(ending==='all')world.resetCamera();else world.focusObject('home.bunny'); toast(ending==='all'?'八位伙伴都来做客啦！这是独立演示，退出后回到你的真实小屋。':'这是演示结局：团团入住啦。真实学习记录没有变化。',6500); }
  else toast('进入独立演示存档，可以体验完整的七次冒险。');
}

function exitDemo() { if(progressBusy)return;if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;} demo=false; navigate('home'); toast('已回到真实学习存档。'); }

async function loadRecording() {
  if(!activeProfile)return;
  const owner=activeProfile.id,context=readingContext(), phrase=currentPhrase(), unit=readingUnit();
  const prefix=`recording:${demo?'demo-':''}${today()}`;
  try {
    let blob = await getClip(`${prefix}:${phrase.id}`,owner), legacy=false;
    // Older KB2 recordings used one key per date; keep their playback available.
    if(!blob&&unit.id==='kb2-u6'){blob=await getClip(prefix,owner);legacy=Boolean(blob);}
    if (blob && phase==='read' && readingContext()===context) showRecording(blob,{legacy});
  } catch { /* Recording is optional; playback errors are shown when recording is saved. */ }
}
function showRecording(blob,{legacy=false}={}) {
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(blob);
  const player = $('#recording-playback');
  if (player) { player.src=audioUrl; player.hidden=false; }
  const status=$('#recording-status');
  if(status)status.textContent=legacy?'旧版当日录音，未区分短句，仅供回听。':'已保存的本句录音，可以回听。';
}

async function toggleRecording() {
  if(!activeProfile){showProfileChooser();return;}
  if(progressBusy){toast('正在收好这一步，请稍等一下。');return;}
  if (recording) { recording.recorder.stop(); return; }
  if(recordingRequest)return;
  if(!ensureToday())return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast('这台浏览器暂不支持录音。可以用 Safari 打开，或者先读给家长听。'); return; }
  stopAudio();
  const request={profileId:activeProfile.id,demo,date:today(),phrase:currentPhrase().id,context:readingContext()};recordingRequest=request;
  speechAvailability();
  const button=$('#record-button'); if(button)button.disabled=true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    if(recordingRequest!==request||phase!=='read'||readingContext()!==request.context){stream.getTracks().forEach(track=>track.stop());return;}
    const type = ['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
    const recorder = type ? new MediaRecorder(stream,{mimeType:type}) : new MediaRecorder(stream);
    const chunks=[];
    const ownerRecording={recorder,stream,started:Date.now(),timer:null};
    const clipKey=`recording:${request.demo?'demo-':''}${request.date}:${request.phrase}`;
    recorder.addEventListener('dataavailable',event=>{if(event.data.size)chunks.push(event.data);});
    recorder.addEventListener('stop',async()=>{
      clearInterval(ownerRecording.timer);stream.getTracks().forEach(track=>track.stop());if(recording===ownerRecording)recording=null;
      const blob=new Blob(chunks,{type:recorder.mimeType||'audio/mp4'});
      if(phase==='read'&&readingContext()===request.context)render();
      if(!blob.size){if(readingContext()===request.context)toast('这次没有录到声音，再试一次吧。');return;}
      try {if(!getProfile(request.profileId))return;await putClip(clipKey,blob,request.profileId); if(phase==='read'&&readingContext()===request.context){showRecording(blob);$('#recording-status').textContent='录好了。听听自己的声音吧。';}}
      catch(error){if(phase==='read'&&readingContext()===request.context){showRecording(blob);toast(`${error.message} 这段录音仍可在当前页面回听。`,7000);}}
    },{once:true});
    recorder.addEventListener('error',()=>{toast('录音中断了，可以重新试一次。');if(recorder.state!=='inactive')recorder.stop();},{once:true});
    recorder.start();recordingRequest=null;recording=ownerRecording;render();
    ownerRecording.timer=setInterval(()=>{
      if(recording!==ownerRecording)return;
      const seconds=Math.floor((Date.now()-ownerRecording.started)/1000);
      const status=$('#recording-status');if(status)status.textContent=`正在录音 ${seconds} 秒 · 最长 30 秒`;
      if(seconds>=30&&recorder.state!=='inactive')recorder.stop();
    },500);
  } catch(error) {
    stream?.getTracks().forEach(track=>track.stop());
    if(recordingRequest!==request)return;
    recording=null;
    if(button?.isConnected)button.disabled=false;
    toast(error.name==='NotAllowedError'?'麦克风尚未允许。可以在浏览器设置里打开，今天也可以先读给家长听。':'录音暂时无法开始，请检查麦克风是否被其他程序使用。',6500);
  } finally {if(recordingRequest===request)recordingRequest=null;if(button?.isConnected)button.disabled=false;speechAvailability();}
}

function download(text, filename) {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

function checkImportedAudio(blob) {
  if(!blob.size||blob.size>15*1024*1024)return Promise.reject(new Error('请选择有声音且不超过 15 MiB 的音频。'));
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(blob),audio=new Audio();audio.preload='auto';
    const finish=error=>{
      clearTimeout(timer);audio.onloadeddata=null;audio.onerror=null;
      audio.removeAttribute('src');audio.load();URL.revokeObjectURL(url);
      if(error)reject(error);else resolve();
    };
    const timer=setTimeout(()=>finish(new Error('音频读取超时，请换一个文件再试。')),8000);
    audio.onloadeddata=()=>finish(Number.isFinite(audio.duration)&&audio.duration>0?null:new Error('这段音频无法播放，请检查文件内容。'));
    audio.onerror=()=>finish(new Error('这段音频无法播放，请检查文件内容或格式。'));
    audio.src=url;audio.load();
  });
}

function registerOfflineWorker() {
  if(!('serviceWorker' in navigator))return Promise.reject(new Error('这个浏览器暂不支持离线资源缓存。'));
  offlineRegistrationTask ||= Promise.resolve().then(()=>navigator.serviceWorker.register('./sw.js')).then(registration=>{offlineRegistration=registration;return registration;}).catch(error=>{offlineRegistrationTask=null;throw error;});
  return offlineRegistrationTask;
}

async function prepareOffline() {
  if(offlinePreparing)return;
  offlinePreparing=true;
  const detail=$('#offline-detail'),button=$('#prepare-offline');button.disabled=true;
  detail.textContent='正在准备程序和三维场景…';
  const attempt={active:true};
  let timeout,channel;
  try {
    const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('离线资源准备超时，联网仍可学习；保持联网后可以重试。')),45000);});
    const preparation=(async()=>{
      await registerOfflineWorker();
      const registration=await navigator.serviceWorker.ready;
      if(!attempt.active)throw new Error('本轮离线准备已结束，请重新尝试。');
      channel=new MessageChannel();
      return new Promise(resolve=>{channel.port1.onmessage=event=>resolve(event.data);registration.active.postMessage({type:'CACHE_MODELS'},[channel.port2]);});
    })();
    const result=await Promise.race([preparation,deadline]);
    if(!result.ok)throw new Error('有模型尚未准备好，请保持联网后重新准备。');
    detail.textContent='程序、内置英音、八位伙伴和场景已可离线。自己导入的音频也保存在本机。';
    $('#offline-status').textContent='小岛已准备好离线探索';
    navigator.storage?.persist?.().catch(()=>{});
  } catch(error){detail.textContent=error.message;$('#offline-status').textContent='联网探索 · 可准备离线';if(!offlineRegistration)offlineRegistrationTask=null;}
  finally{attempt.active=false;clearTimeout(timeout);channel?.port1.close();channel?.port2.close();offlinePreparing=false;button.disabled=false;}
}

document.addEventListener('pointerdown',event=>{storyPointerButton=event.target.closest('[data-story-action]');},{capture:true});
document.addEventListener('click',event=>{
  const close=event.target.closest('[data-close]');if(close){document.getElementById(close.dataset.close).close();return;}
  const button=event.target.closest('button');if(!button||button.disabled)return;
  const d=button.dataset;
  if(d.profileSelect){activateProfile(d.profileSelect);return;}
  if(d.profileDelete){askDeleteProfile(d.profileDelete);return;}
  if(button.closest('#profile-dialog,#delete-profile-dialog'))return;
  if(!activeProfile){showProfileChooser();return;}
  if(progressBusy){toast('正在收好这一步，请稍等一下。');return;}
  if(d.storyAction){
    // A scene tap can open a bubble under the finger before its follow-up click.
    // Only accept a pointer click that began on this button; keyboard clicks have detail 0.
    if(event.detail>0&&storyPointerButton!==button)return;
    storyPointerButton=null;storyAction(d.storyAction);return;
  }
  if(d.nav){navigate(d.nav);return;}
  if(d.object){handleWorldInteraction(d.object);return;}
  if(d.companion||d.companionSwitch){chooseCompanion(d.companion||d.companionSwitch);return;}
  if(d.task){enterTask(d.task);return;}
  if(d.freeWord){enterTask('listen',d.freeWord);return;}
  if(d.unit){chooseUnit(d.unit);return;}
  if(d.readingUnit){enterTask('read',null,d.readingUnit);return;}
  if(d.answer){answer(d.answer===activeWordId,d.answer);return;}
  if(d.phrase!==undefined){if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}stopAudio();phraseIndex=Number(d.phrase);render();loadRecording();return;}
  const actions={
    'open-books':openBooks,
    'switch-profile':showProfileChooser,
    'visit-companion':visitCompanion,
    'retry-companion':()=>{companionPreviewKey=null;syncCompanionPreview();},
    'retry-world':retryWorld,
    'start-unit':async()=>{if(await chooseUnit(d.startUnit))navigate('camp');},
    'open-parent':()=>$('#parent-dialog').showModal(),
    'back-task':()=>{if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}if(freeUnitId){openBooks(readingUnit().bookId);return;}stopAudio();phase='overview';freeWordId=null;freeUnitId=null;feedback=null;render();},
    'play-word':()=>playPrompt(`word:${activeWordId}`),
    'play-word-slow':()=>playPrompt(`word:${activeWordId}`,{slow:true}),
    'play-phrase':()=>playPrompt(`phrase:${currentPhrase().id}`),
    'play-phrase-slow':()=>playPrompt(`phrase:${currentPhrase().id}`,{slow:true}),
    'practice-phrase':()=>playPrompt(`phrase:${currentPhrase().id}`,{repeat:true}),
    'stop-speaking':()=>{stopAudio();speechStatus('已暂停，准备好可以再来一轮。');},
    'check-spell':()=>{const input=$('#spell-input');const text=input?.value;if(!text?.trim()){toast('先拼出一点，再检查。');return;}answer(matchesSpelling(getWord(activeWordId),text));},
    hint:()=>{hintUsed=true;feedback={correct:false,text:`提示：${getWord(activeWordId).en} 是${getWord(activeWordId).zh}。记住它，再试一次。`};render();},
    'next-question':nextQuestion,
    collect:collectReward,
    record:toggleRecording,
    'finish-reading':async()=>{if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成。');return;}if(!ensureToday())return;stopAudio();if(!await setReadingDone())return;const free=freeUnitId,bookId=readingUnit().bookId;freeUnitId=null;phase=free?'books':'overview';page=free?'home':'camp';if(free)shelfBookId=bookId;render();toast('愿意开口就很好。今天这个单元已练习过。');},
    'start-demo':()=>startDemo(false),
    'demo-ending':()=>startDemo(true),
    'demo-all':()=>startDemo('all'),
    'exit-demo':exitDemo,
    'demo-next':()=>{const d=new Date(`${demoDate}T12:00:00`);d.setDate(d.getDate()+1);demoDate=localDateKey(d);navigate('camp');},
    reload:()=>location.reload(),
  };
  if(d.action)actions[d.action]?.();
});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.keyCode!==229&&event.target.id==='spell-input'){event.preventDefault();$('[data-action="check-spell"]')?.click();}});
document.addEventListener('play',event=>{if(event.target.id==='recording-playback'&&microphoneBusy())event.target.pause();},{capture:true});
document.addEventListener('change',event=>{if(event.target.id==='book-select'){shelfBookId=event.target.value;render();}});
$('#parent-button').addEventListener('click',()=>{if(!activeProfile){showProfileChooser();return;}try{$('#export-backup').hidden=!localStorage.getItem(personalKey('before-import'));}catch{}$('#parent-dialog').showModal();});
$('#user-button').addEventListener('click',showProfileChooser);
$('#create-profile-form').addEventListener('submit',createNamedProfile);
$('#confirm-delete-profile').addEventListener('click',confirmDeleteProfile);
$('#profile-cancel').addEventListener('click',()=>{if(activeProfile&&!profileBusy){$('#profile-dialog').close();syncCompanionPreview();}});
$('#profile-dialog').addEventListener('cancel',event=>{if(!activeProfile||profileBusy)event.preventDefault();});
$('#profile-dialog').addEventListener('close',()=>syncCompanionPreview());
$('#camera-reset').addEventListener('click',()=>page==='clues'?companionView?.resetCamera():world.resetCamera());
$('#ask-hero').addEventListener('click',askHero);
$('#story-replay').addEventListener('click',replayStory);
$('#demo-toggle').addEventListener('click',()=>demo?exitDemo():startDemo(false));
$('#reward-continue').addEventListener('click',()=>{$('#reward-dialog').close();navigate('home');if(rewardCompanionId)world.focusObject(`home.${rewardCompanionId}`);rewardCompanionId=null;});
$('#export-progress').addEventListener('click',()=>{if(!activeProfile)return;try{download(exportProgress(realProgress),`${activeProfile.name}-word-island-${localDateKey()}.json`);}catch(error){toast(error.message);}});
$('#export-backup').addEventListener('click',()=>{if(!activeProfile)return;try{const text=localStorage.getItem(personalKey('before-import'));if(text)download(text,`${activeProfile.name}-word-island-before-import.json`);}catch(error){toast(error.message);}});
$('#import-progress').addEventListener('change',async event=>{
  const file=event.target.files[0];if(!file)return;
  if(!activeProfile){event.target.value='';return;}
  const owner=activeProfile.id,epoch=profileEpoch;
  try {
    if(file.size>=1024*1024)throw new Error('进度文件需小于 1 MiB。');
    const imported=importProgress(await file.text());if(activeProfile?.id!==owner||profileEpoch!==epoch)return;
    pendingImport=imported;pendingImportOwner=owner;
    $('#import-summary').textContent=`这份备份有 ${Object.keys(pendingImport.days).length} 天练习记录、${pendingImport.rewardDates.length} 条线索、${pendingImport.companions.length} 位伙伴。确认后替换「${activeProfile.name}」的进度，接着学习。`;
    $('#parent-dialog').close();$('#import-dialog').showModal();
  }catch(error){if(activeProfile?.id===owner&&profileEpoch===epoch)toast(error.message);}finally{event.target.value='';}
});
$('#confirm-import').addEventListener('click',async()=>{
  if(microphoneBusy()){toast('先结束录音或等待麦克风请求完成，再导入进度。');return;}
  if(!pendingImport)return;
  if(!activeProfile||pendingImportOwner!==activeProfile.id){pendingImport=null;pendingImportOwner=null;return;}
  try {
    const imported=pendingImport;
    if(!await setProgress(()=>imported,{real:true,beforeImportBackup:true}))return;
    pendingImport=null;pendingImportOwner=null;demo=false;
    $('#import-dialog').close();navigate('home');toast('备份已导入，之前的本机进度也保留了一份备份。');
  }catch(error){toast(error.message);}
});
$('#import-audio').addEventListener('change',async event=>{
  const input=event.target,files=[...input.files];input.disabled=true;
  $('#audio-import-status').textContent='正在检查和保存音频…';
  let saved=0;const errors=[];
  for(const file of files){
    const name=file.name.replace(/\.[^.]+$/,'').toLowerCase();
    const key=getWord(name)?`word:${name}`:name.startsWith('phrase-')&&PHRASES.some(p=>p.id===name.slice(7))?`phrase:${name.slice(7)}`:null;
    if(!key){errors.push(`${file.name} 未找到对应单词或短句`);continue;}
    const mime=file.type.startsWith('audio/')?file.type:/\.m4a$/i.test(file.name)?'audio/mp4':/\.wav$/i.test(file.name)?'audio/wav':/\.mp3$/i.test(file.name)?'audio/mpeg':null;
    if(!mime){errors.push(`${file.name} 音频格式无法识别`);continue;}
    try{const blob=file.type===mime?file:new Blob([file],{type:mime});await checkImportedAudio(blob);await putClip(key,blob);importedClips.set(key,blob);saved++;}catch(error){errors.push(`${file.name}：${error.message}`);}
  }
  $('#audio-import-status').textContent=`已保存 ${saved} 段本地音频。${errors.length?` ${errors.slice(0,3).join('；')}`:'只在这台设备使用。'}`;
  input.value='';input.disabled=false;
});
$('#prepare-offline').addEventListener('click',prepareOffline);
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){stopAudio();recordingRequest=null;if(recording&&recording.recorder.state!=='inactive')recording.recorder.stop();speechAvailability();}
  else {ensureToday();speechAvailability();}
});
window.addEventListener('pagehide',()=>{stopAudio();recording?.stream.getTracks().forEach(track=>track.stop());if(audioUrl)URL.revokeObjectURL(audioUrl);});
window.addEventListener('storage',event=>{
  try {
    if(activeProfile&&!progressBusy&&event.key===personalKey('progress')){
      const fresh=loadProgress(activeProfile.id);if(fresh.error){toast(fresh.error);return;}
      const changedPlan=!demo&&JSON.stringify(plan())!==JSON.stringify(getDailyPlan(fresh.progress,today()));
      realProgress=fresh.progress;loaded=fresh;
      if(changedPlan&&!freeWordId&&!freeUnitId){stopAudio();page='camp';phase='overview';activeWordId=null;feedback=null;toast('另一个窗口更新了今日计划，这里也接着最新进度。');}
      if(!microphoneBusy()){render();if(phase==='read')loadRecording();}
      return;
    }
    if(activeProfile&&!progressBusy&&event.key===personalKey('reading')){
      readDays=parseReadingFlags(event.newValue);
      if(!microphoneBusy()){render();if(phase==='read')loadRecording();}
      return;
    }
    if(event.key!==PROFILE_REGISTRY_KEY)return;
    if(activeProfile&&!getProfile(activeProfile.id)){
      recordingRequest=null;
      const oldRecording=recording;recording=null;
      if(oldRecording){clearInterval(oldRecording.timer);oldRecording.stream.getTracks().forEach(track=>track.stop());if(oldRecording.recorder.state!=='inactive')oldRecording.recorder.stop();}
      resetLearningContext();activeProfile=null;realProgress=createInitialProgress();readDays=new Set();guide=readGuide(null);loaded={progress:realProgress,error:null};render();
      showProfileChooser();$('#profile-error').textContent='这个名字已在另一个窗口删除，请重新选择。';
    }else if($('#profile-dialog').open)renderProfileList();
  }catch(error){toast(error.message);}
});
render();
showProfileChooser();
// Register only after the first room is ready. Full model preparation is an
// explicit parent action, so it cannot compete with the child's next scene.
world.ready.then(()=>registerOfflineWorker().catch(()=>{})).catch(()=>{});
// Read-only inspection surface for browser QA; never uploads or modifies progress.
window.__wordIsland={world,getState:()=>structuredClone({activeProfile,demo,page,phase,dateKey:today(),progress:progress(),realProgress,plan:plan(),readingDone:readingDone(),activeWordId,phraseId:currentPhrase().id,readingUnitId:readingUnit().id,guide,speech,selectedCompanionId}),getCompanionDiagnostics:()=>companionView?.getDiagnostics()||null,getDiagnostics:()=>world.getDiagnostics()};
