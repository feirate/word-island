export function audioVariant(key,{slow=false,imported=false}={}) {
  return {
    file:imported?null:`assets/audio/${key.replace(':','-')}${slow?'-slow':''}.m4a`,
    playbackRate:imported&&slow?.82:1,
    preservesPitch:true,
    label:`${imported?'已导入的本地音频':'内置英音示范 · 合成音，非教材原音'} · ${slow?'清晰慢读':'常速'}`,
  };
}

export function followAlongGapMs(duration,playbackRate=1) {
  const rate=Number.isFinite(playbackRate)&&playbackRate>0?playbackRate:1;
  const seconds=Number.isFinite(duration)&&duration>0?duration/rate:2;
  return Math.round(Math.max(3000,Math.min(8000,seconds*1350+800)));
}
