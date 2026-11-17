// Bound both the request and its body read: a stalled WebView request must not
// leave the child waiting forever. Assets are self-contained local GLB files.
function abortError(){return new DOMException('三维资源加载已取消。','AbortError');}

export async function fetchModelData(url,{signal,timeoutMs=30000,onProgress}={}) {
  if(signal?.aborted)throw abortError();
  const controller=new AbortController();let reader,finished=false,timer;
  let rejectCancellation;
  const cancelled=new Promise((_,reject)=>{rejectCancellation=reject;});
  const cancel=error=>{
    if(finished)return;
    controller.abort();reader?.cancel().catch(()=>{});rejectCancellation(error);
  };
  const onAbort=()=>cancel(abortError());
  signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>{const error=new Error('三维资源下载超时，请保持联网后再试一次。');error.name='TimeoutError';cancel(error);},timeoutMs);
  const download=(async()=>{
    const response=await fetch(url,{signal:controller.signal});
    if(controller.signal.aborted){response.body?.cancel().catch(()=>{});throw abortError();}
    if(!response.ok)throw new Error(`三维资源暂时无法下载（${response.status}）。`);
    const total=Number(response.headers.get('Content-Length'))||0;
    onProgress?.({loaded:0,total});
    if(!response.body?.getReader){
      const data=await response.arrayBuffer();
      if(controller.signal.aborted)throw abortError();
      onProgress?.({loaded:data.byteLength,total});return data;
    }
    reader=response.body.getReader();const chunks=[];let loaded=0;
    for(;;){
      const {done,value}=await reader.read();
      if(controller.signal.aborted)throw abortError();
      if(done)break;
      chunks.push(value);loaded+=value.byteLength;onProgress?.({loaded,total});
    }
    const data=new Uint8Array(loaded);let offset=0;
    for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
    return data.buffer;
  })();
  try{return await Promise.race([download,cancelled]);}
  finally{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}

export async function loadModel(url,options={}) {
  const bytes=await fetchModelData(url,options);
  const {GLTFLoader}=await import('../vendor/loaders/GLTFLoader.js');
  return new GLTFLoader().parseAsync(bytes,new URL('.',url).href);
}
