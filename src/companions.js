export const CLUES_PER_COMPANION = 7;
export const FIRST_COMPANION_CLUES = Object.freeze([
  {id:'footprints',title:'两排小脚印',description:'小路上出现一串轻巧的脚印，附近似乎住着一位新朋友。',emoji:'🐾',kind:'clue'},
  {id:'white-fluff',title:'一团软软的白毛',description:'树枝上留着一点白色绒毛。新朋友的毛会是什么颜色？',emoji:'☁️',kind:'clue'},
  {id:'carrot-basket',title:'小小的胡萝卜篮',description:'你找到一个小篮子，篮边画着胡萝卜。把它留作冒险纪念吧。',emoji:'🥕',kind:'item'},
  {id:'long-ears',title:'树后的长耳朵',description:'树后探出两只长长的耳朵，又害羞地缩了回去。',emoji:'🌿',kind:'clue'},
  {id:'welcome-ribbon',title:'欢迎小彩带',description:'你找到了欢迎新朋友的小彩带，可以带回小屋。',emoji:'🎀',kind:'item'},
  {id:'bunny-letter',title:'团团的来信',description:'“你好，我是团团！你读懂了我的消息，还找到了我的小篮子。我想来认识你。”',emoji:'✉️',kind:'clue'},
  {id:'bunny-arrives',title:'团团来到小屋',description:'原来是白白的团团！它带着小篮子，成为小屋里的第一位伙伴。',emoji:'🐰',kind:'clue'},
].map((clue,index)=>Object.freeze({...clue,index:index+1})));

const specifications = [
  {id:'bunny',name:'团团',species:'小兔子',emoji:'🐰',personality:'温柔 · 爱分享',description:'喜欢胡萝卜，也喜欢听你留下的声音。',message:'谢谢你找到我！小垫子好软，我们一起慢慢学吧。',home:[2.6,.31,1.3],scale:.8,keepsake:'胡萝卜小篮',sign:'两只长长的耳朵',clues:FIRST_COMPANION_CLUES},
  {id:'squirrel',name:'栗栗',species:'小松鼠',emoji:'🐿️',personality:'好奇 · 爱收集',description:'抱着小松果，总想发现树林里的新秘密。',message:'我把松果带来啦！今天又认识了什么新单词？',home:[-1.95,.08,.9],scale:.65,keepsake:'小小的松果',sign:'一条蓬松的大尾巴'},
  {id:'cat',name:'米米',species:'小猫',emoji:'🐱',personality:'安静 · 爱陪伴',description:'奶油灰的小猫，喜欢在书架旁陪你读一会儿。',message:'这里的书真多。你慢慢读，我就在旁边陪着你。',home:[-2.3,.08,3],scale:.65,keepsake:'奶油色毛线球',sign:'轻轻摇动的小尾巴'},
  {id:'dog',name:'豆豆',species:'小狗',emoji:'🐶',personality:'热情 · 爱鼓励',description:'软软的垂耳朵，一见朋友就开心地摇尾巴。',message:'你来啦！今天学一点点也很棒，我会给你加油。',home:[.7,.08,2.8],scale:.65,keepsake:'一枚小爪印徽章',sign:'一对软软的垂耳朵'},
  {id:'hedgehog',name:'刺刺',species:'小刺猬',emoji:'🦔',personality:'害羞 · 很认真',description:'圆圆的背上长着软钝的小刺，怀里藏着小叶子。',message:'刚才还有一点害羞。谢谢你耐心找我，我们一起再试一次吧。',home:[-.85,.08,2.55],scale:.7,keepsake:'一片卷起来的小叶子',sign:'一团圆圆的小刺球'},
  {id:'turtle',name:'慢慢',species:'小乌龟',emoji:'🐢',personality:'从容 · 有耐心',description:'背着圆圆的小龟壳，相信慢一点也能到达。',message:'不用着急。每天向前一点，我们就能走很远。',home:[3.3,.08,2.6],scale:.75,keepsake:'一块光滑的小石头',sign:'一个圆圆的绿色龟壳'},
  {id:'raccoon',name:'圈圈',species:'小浣熊',emoji:'🦝',personality:'机灵 · 爱整理',description:'眼睛旁有深色面罩，尾巴上有一圈圈花纹。',message:'我把小发现都整理好啦！你记住的词，也都是自己的宝贝。',home:[-3.7,.08,2.9],scale:.65,keepsake:'一条条纹小丝带',sign:'一条一圈圈的条纹尾巴'},
  {id:'fox',name:'橙橙',species:'小狐狸',emoji:'🦊',personality:'勇敢 · 爱探索',description:'奶橙色的小狐狸，戴蓝围巾，和芽芽一起带路。',message:'新朋友都在这里啦！下次也一起出发，看看小岛还有什么故事。',home:[2.3,.08,-.9],scale:.65,keepsake:'一枚蓝色围巾扣',sign:'一条奶白色尾尖'},
];

function cluesFor(pet) {
  return [
    {title:'林间的新脚印',description:`小路上又出现了新的脚印。也许${pet.name}就在附近。`,emoji:'🐾'},
    {title:pet.keepsake,description:`树边留着${pet.keepsake}。它会不会属于这位新朋友？`,emoji:'🍃'},
    {title:'读懂一张小纸条',description:`你和芽芽读懂了一张英语小纸条：“I am here.”，新的消息又近了一点。`,emoji:'📜'},
    {title:pet.sign,description:`树后露出${pet.sign}。你已经快找到它啦。`,emoji:pet.emoji},
    {title:'给新朋友的欢迎礼',description:`带一条小彩带回小屋，给${pet.name}准备一个暖暖的位置。`,emoji:'🎀'},
    {title:`${pet.name}的回信`,description:`“你好，我是${pet.name}！谢谢你读懂我的消息，明天见面吧。”`,emoji:'✉️'},
    {title:`${pet.name}来到小屋`,description:`你找到${pet.name}啦！这位${pet.personality.split(' · ')[0]}的${pet.species}，会一直留在小屋陪伴你。`,emoji:pet.emoji},
  ].map((clue,index)=>Object.freeze({...clue,id:`${pet.id}-${index+1}`,index:index+1,kind:index===1||index===4?'item':'clue'}));
}

export const COMPANIONS=Object.freeze(specifications.map((pet,index)=>Object.freeze({
  ...pet,index,home:Object.freeze(pet.home),
  modelFile:pet.id==='bunny'?'assets/models/bunny.glb':`assets/models/companions/${pet.id}.glb`,
  portraitFile:`assets/models/companions/${pet.id}-portrait.png`,
  clues:pet.clues||Object.freeze(cluesFor(pet)),
})));
export const MAX_REWARD_DAYS=COMPANIONS.length*CLUES_PER_COMPANION;
export const getCompanion=id=>COMPANIONS.find(pet=>pet.id===id);

export function companionIdsForRewardCount(count) {
  if(!Number.isInteger(count)||count<0||count>MAX_REWARD_DAYS)throw new Error('伙伴线索数量无效。');
  return COMPANIONS.slice(0,Math.floor(count/CLUES_PER_COMPANION)).map(pet=>pet.id);
}

export function getCompanionJourney(progress) {
  const count=progress.rewardDates.length;
  const index=Math.min(COMPANIONS.length,Math.floor(count/CLUES_PER_COMPANION));
  return {current:COMPANIONS[index]||null,roundCount:index===COMPANIONS.length?7:count%CLUES_PER_COMPANION,totalCount:count,completed:index,lastUnlocked:COMPANIONS[index-1]||null};
}

export function getCompanionState(progress,id) {
  const pet=getCompanion(id);
  if(!pet)throw new Error('没有找到这位伙伴。');
  const journey=getCompanionJourney(progress);
  const status=progress.companions.includes(id)?'unlocked':journey.current?.id===id?'current':'locked';
  return {pet,status,clueCount:status==='unlocked'?7:status==='current'?journey.roundCount:0};
}

export function getClueForReward(index) {
  if(!Number.isInteger(index)||index<0||index>=MAX_REWARD_DAYS)throw new Error('没有这条伙伴线索。');
  const companion=COMPANIONS[Math.floor(index/CLUES_PER_COMPANION)];
  return {...companion.clues[index%CLUES_PER_COMPANION],companion};
}
