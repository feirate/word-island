import { getCompanionJourney } from './companions.js';

export const GUIDE_KEY = 'word-island:guide:v1';
const INTRO = [
  { id:'welcome', title:'我们的探险基地', text:'嗨，我是芽芽！欢迎来到词遇岛。这间小屋，就是我们一起探险、带朋友回来的地方。', button:'你好，芽芽！' },
  { id:'island', title:'读懂消息，认识朋友', text:'岛上住着一些害羞的小动物。它们会用英语留下消息。和我一起读懂它们，去找新朋友吧！', button:'我们怎么找？' },
  { id:'route', title:'营地的三个小任务', text:'先在木箱听听单词，再到路牌拼一拼，最后给邮筒留一句话。想不起来，可以看提示，再试一次。', button:'我想试试看' },
  { id:'clues', title:'每天，靠近一点点', text:'完成一天的小任务，就找到一条伙伴线索。攒够 7 条，新朋友会来小屋！不用连续七天，漏一天，线索也会留下。', button:'准备好啦！' },
];
export const INTRO_COUNT = INTRO.length;
const PRACTICE_HELP = {
  listen:{id:'listen-help',title:'先让耳朵找一找',text:'点三角按钮听单词，再选它的意思。可以多听几遍，拿不准也能看提示。我会等你。',button:'开始听一听',action:'practice',target:'camp.crate'},
  spell:{id:'spell-help',title:'把听到的声音拼出来',text:'听听单词，在输入框里拼一拼，再检查。忘了几个字母也没关系，提示会帮你找到它。',button:'开始拼一拼',action:'practice',target:'camp.sign'},
  read:{id:'read-help',title:'给新朋友留一句话',text:'先听一句，再跟着读。可以录下自己的声音回听，也可以读给家长听。开口以后，点“我已经开口读过了”。',button:'我来读一句',action:'practice',target:'camp.mailbox'},
};

export function readGuide(raw) {
  try {
    const value=JSON.parse(raw);
    if(value?.version===1&&['active','skipped','finished'].includes(value.status)&&Number.isInteger(value.intro)&&value.intro>=0&&value.intro<=INTRO_COUNT)
      return {version:1,status:value.status,intro:value.intro};
  } catch { /* Guide preferences never prevent the island from opening. */ }
  return {version:1,status:'active',intro:0};
}

export function nextIntro(guide) { return {...guide,intro:Math.min(INTRO_COUNT,guide.intro+1)}; }
export function endGuide(guide,status='finished') { return {...guide,status:status==='skipped'?'skipped':'finished'}; }

export function guidePrompt(guide,context) {
  if(guide.status!=='active'||context.demo||context.phase==='books'||!['home','camp'].includes(context.page)||context.freePractice)return null;
  if(guide.intro<INTRO_COUNT)return {...INTRO[guide.intro],action:'next',chapter:`初到词遇岛 · ${guide.intro+1} / ${INTRO_COUNT}`};
  return adventurePrompt(context);
}

export function adventurePrompt(context) {
  const {page,phase,listenDone,spellDone,readDone,dailyFinished,clueCount}=context;
  if(dailyFinished) {
    if(page==='camp')return {id:'return',title:'带着发现回家',text:'今天的小任务完成啦！把找到的发现带回小屋，看看我们离新朋友又近了多少。',button:'一起回小屋',action:'home'};
    const route=getCompanionJourney({rewardDates:Array(clueCount)});
    const welcomed=route.completed>0&&route.roundCount===0;
    const text=!route.current?'八位伙伴都住进小屋啦！今天辛苦了，以后也能和大家一起慢慢学。':welcomed?`${route.lastUnlocked.name}已经住进小屋啦！下次我们再去找${route.current.name}。今天辛苦了，想继续练习或休息都可以。`:`我们已经找到 ${route.roundCount} 条${route.current.name}的线索了！今天先休息也可以，下次再来找新发现。想问路，随时点我。`;
    return {id:'rest',title:!route.current?'朋友们都到家啦':welcomed?`小屋迎来了${route.lastUnlocked.name}`:'今天的发现，收好啦',text,button:'收好今天的冒险',action:'finish'};
  }
  if(page!=='camp')return {id:'depart',title:'第一站，林间营地',text:'今天从几个小小的单词开始。轻点小屋的绿色门，或者按下面的按钮，我们一起出发！',button:'推门，出发！',action:'camp',target:'home.door'};
  const done={listen:listenDone,spell:spellDone,read:readDone};
  if(PRACTICE_HELP[phase]&&!done[phase])return {...PRACTICE_HELP[phase]};
  if(!listenDone)return {id:'listen',title:'木箱里有什么声音？',text:'第一步，听听木箱里的英语词，找到它的意思。点木箱，或者跟我一起开始吧。',button:'去木箱听一听',action:'listen',target:'camp.crate'};
  if(!spellDone)return {id:'spell',title:'声音找到了，试试拼写',text:'耳朵已经认出今天的词啦！第二步，到路牌拼一拼，把它们记得更牢。',button:'去路牌拼一拼',action:'spell',target:'camp.sign'};
  if(!readDone)return {id:'read',title:'最后，给朋友留句话',text:'听懂了，也拼出来了！第三步，到邮筒听一句，再试着跟读，给岛上的朋友留个声音。',button:'去邮筒说一句',action:'read',target:'camp.mailbox'};
  return {id:'collect',title:'线索宝箱准备好啦',text:'三个小任务都完成了！点营地里的宝箱，看看今天找到了什么。',button:'打开线索宝箱',action:'collect',target:'camp.chest'};
}
