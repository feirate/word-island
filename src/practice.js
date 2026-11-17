function normalise(value) {
  return String(value).trim().toLowerCase().replace(/[’‘]/g,"'").replace(/[‐‑–]/g,'-').replace(/\s+/g,' ');
}

export function matchesSpelling(word, input) {
  return [word.en,...(word.accepted||[])].some(answer=>normalise(answer)===normalise(input));
}

export function answerChoices(target, primary, fallback=[], seed='') {
  let hash=0;
  for(const character of `${seed}:${target.id}`)hash=(Math.imul(hash,31)+character.charCodeAt(0))>>>0;
  const selected=[target];
  const seen=new Set([target.zh]);
  const candidates=[...primary,...fallback];
  if(candidates.length){
    const offset=hash%candidates.length;
    for(let i=0;i<candidates.length&&selected.length<3;i++){
      const word=candidates[(i+offset)%candidates.length];
      if(word&&word.id!==target.id&&!seen.has(word.zh)){selected.push(word);seen.add(word.zh);}
    }
  }
  const rotation=hash%selected.length;
  return selected.slice(rotation).concat(selected.slice(0,rotation));
}
