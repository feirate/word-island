import {getUnit} from './content.js';
import {audioVariant} from './speech-audio.js';

export function lessonAudioFiles({unitIds=[],wordIds=[]}={}) {
  const words=new Set(wordIds),phrases=new Set();
  for(const id of unitIds){const unit=getUnit(id);if(!unit)continue;unit.wordIds.forEach(id=>words.add(id));unit.phraseIds.forEach(id=>phrases.add(id));}
  return [...words].flatMap(id=>[false,true].map(slow=>audioVariant(`word:${id}`,{slow}).file))
    .concat([...phrases].flatMap(id=>[false,true].map(slow=>audioVariant(`phrase:${id}`,{slow}).file))).sort();
}

export function createLessonPreparer({prepare,version,onReady=()=>{},onPending=()=>{},onFailure=()=>{},now=Date.now,retryMs=30000}) {
  let key=null,generation=0,failedKey=null,retryAfter=0;
  return {
    reset(){generation++;key=null;failedKey=null;retryAfter=0;},
    async prepare(paths){
      const next=paths.join('|');
      if(key===next||(failedKey===next&&now()<retryAfter))return false;
      const attempt=++generation;key=next;onPending();
      try{
        const result=await prepare(paths);
        if(attempt!==generation)return false;
        if(result.ok&&result.version===version){onReady(paths);return true;}
      }catch{if(attempt!==generation)return false;}
      key=null;failedKey=next;retryAfter=now()+retryMs;onFailure();return false;
    },
  };
}

export function requestPreparation(worker,{type,paths,onProgress=()=>{},idleMs=30000,totalMs=300000,createChannel=()=>new MessageChannel()}={}) {
  return new Promise((resolve,reject)=>{
    const channel=createChannel();let done=false,idle,total,lastCompleted=-1;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(idle);clearTimeout(total);channel.port1.close();channel.port2.close();error?reject(error):resolve(value);};
    const armIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>finish(new Error('离线准备暂时没有新进度；已经准备好的文件会保留，可以稍后继续。')),idleMs);};
    channel.port1.onmessage=event=>{
      const data=event.data;
      if(data?.type==='CACHE_PROGRESS'){
        if(data.completed>lastCompleted){lastCompleted=data.completed;armIdle();}
        onProgress(data);return;
      }
      if(data?.type===(type==='CACHE_LESSON'?'LESSON_CACHED':'MODELS_CACHED'))finish(null,data);
    };
    armIdle();total=setTimeout(()=>finish(new Error('离线准备用时较长；已经完成的文件会保留，保持联网后可以继续。')),totalMs);
    Promise.resolve(worker).then(active=>{if(!done)active.postMessage({type,...(paths?{paths}: {})},[channel.port2]);}).catch(error=>finish(error));
  });
}
