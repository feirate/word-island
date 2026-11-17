function abortError(){return new DOMException('三维资源加载已取消。','AbortError');}

// Idle time, rather than all transfer time, consumes the short timeout budget.
export async function fetchModelData(url,{signal,timeoutMs=30000,maxDurationMs=180000,onProgress}={}) {
  if(signal?.aborted)throw abortError();
  const started=Date.now(),controller=new AbortController();
  const state={phase:'requesting',loaded:0,total:0,elapsedMs:0};
  let finished=false,completed=false,idleTimer,overallTimer,reader;
  let stopTransport=()=>{controller.abort();reader?.cancel().catch(()=>{});};
  let cleanTransport=()=>{},rejectCancellation;
  const cancelled=new Promise((_,reject)=>{rejectCancellation=reject;});
  const details=(reason,extra={})=>({...state,elapsedMs:Date.now()-started,reason,...extra});
  const fail=(reason,message,name='Error',extra={})=>{
    const error=new Error(message);error.name=name;error.details=details(reason,extra);return error;
  };
  const cancel=error=>{if(finished)return;rejectCancellation(error);stopTransport();};
  const armIdle=()=>{
    clearTimeout(idleTimer);
    idleTimer=setTimeout(()=>cancel(fail('idle-timeout',`模型下载超时：连续 ${Math.round(timeoutMs/1000)} 秒没有新数据，已收到 ${Math.round(state.loaded/1024)} KB，请保持联网后再试。`,'TimeoutError')),timeoutMs);
  };
  const progress=(phase,loaded=state.loaded,total=state.total)=>{
    if(finished||controller.signal.aborted)return;
    if(loaded>state.loaded||(phase==='headers'&&state.phase==='requesting'))armIdle();
    Object.assign(state,{phase,loaded,total,elapsedMs:Date.now()-started});onProgress?.({...state});
  };
  const onAbort=()=>{const error=abortError();error.details=details('abort');cancel(error);};
  signal?.addEventListener('abort',onAbort,{once:true});armIdle();
  overallTimer=setTimeout(()=>cancel(fail('overall-timeout',`模型下载用时较长，已收到 ${Math.round(state.loaded/1024)} KB，请稍后重试。`,'TimeoutError')),maxDurationMs);
  const download=typeof XMLHttpRequest==='function'?new Promise((resolve,reject)=>{
    // Use the native complete-buffer path instead of a network ReadableStream.
    const xhr=new XMLHttpRequest();
    stopTransport=()=>{controller.abort();xhr.abort();};
    cleanTransport=()=>{xhr.onreadystatechange=null;xhr.onprogress=null;xhr.onload=null;xhr.onerror=null;xhr.onabort=null;};
    xhr.open('GET',String(url),true);xhr.responseType='arraybuffer';
    xhr.onreadystatechange=()=>{if(xhr.readyState===2)progress('headers',0,Number(xhr.getResponseHeader('Content-Length'))||0);};
    xhr.onprogress=event=>progress('receiving',event.loaded,event.lengthComputable?event.total:state.total);
    xhr.onload=()=>{
      if(xhr.status<200||xhr.status>=300){reject(fail('http',`三维资源暂时无法下载（${xhr.status}）。`,'Error',{status:xhr.status}));return;}
      if(!(xhr.response instanceof ArrayBuffer)||!xhr.response.byteLength){reject(fail('network','模型文件没有完整下载，请重试。'));return;}
      resolve(xhr.response);
    };
    xhr.onerror=()=>reject(fail('network','模型下载连接中断，请保持联网后再试一次。'));
    xhr.onabort=()=>reject(abortError());xhr.send();
  }):(async()=>{
    // The same policy works when XHR is unavailable, including the Node tests.
    const response=await fetch(url,{signal:controller.signal});
    if(controller.signal.aborted){response.body?.cancel().catch(()=>{});throw abortError();}
    if(!response.ok)throw fail('http',`三维资源暂时无法下载（${response.status}）。`,'Error',{status:response.status});
    const total=Number(response.headers.get('Content-Length'))||0;progress('headers',0,total);
    if(!response.body?.getReader){const data=await response.arrayBuffer();if(controller.signal.aborted)throw abortError();return data;}
    reader=response.body.getReader();const chunks=[];let loaded=0;
    for(;;){
      const {done,value}=await reader.read();if(controller.signal.aborted)throw abortError();if(done)break;
      chunks.push(value);loaded+=value.byteLength;progress('receiving',loaded,total);
    }
    const data=new Uint8Array(loaded);let offset=0;
    for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
    return data.buffer;
  })();
  try {
    const data=await Promise.race([download,cancelled]);progress('complete',data.byteLength);completed=true;return data;
  }catch(error){if(!error.details)error.details=details(error.name==='AbortError'?'abort':'network');throw error;}
  finally{
    finished=true;clearTimeout(idleTimer);clearTimeout(overallTimer);signal?.removeEventListener('abort',onAbort);
    cleanTransport();if(!completed)stopTransport();
  }
}

export async function loadModel(url,options={}) {
  const started=Date.now(),bytes=await fetchModelData(url,options);
  try {
    const {GLTFLoader}=await import('../vendor/loaders/GLTFLoader.js');
    return await new GLTFLoader().parseAsync(bytes,new URL('.',url).href);
  }catch(error){error.details ||= {phase:'parsing',loaded:bytes.byteLength,total:bytes.byteLength,elapsedMs:Date.now()-started,reason:'parse'};throw error;}
}
