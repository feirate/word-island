import test from 'node:test';
import assert from 'node:assert/strict';
import { audioVariant,followAlongGapMs } from '../src/speech-audio.js';

test('built-in slow speech uses a separate local file without changing its playback pitch or rate',()=>{
  const normal=audioVariant('word:playground');
  const slow=audioVariant('word:playground',{slow:true});
  assert.equal(normal.file,'assets/audio/word-playground.m4a');
  assert.equal(slow.file,'assets/audio/word-playground-slow.m4a');
  assert.equal(slow.playbackRate,1);
  assert.match(slow.label,/慢读/);assert.match(slow.label,/非教材原音/);
});

test('an imported clip stays the source for both speeds instead of falling back to built-in speech',()=>{
  for(const slow of [false,true]){
    const variant=audioVariant('phrase:kb3-hello-1',{slow,imported:true});
    assert.equal(variant.file,null);
    assert.equal(variant.playbackRate,slow?.82:1);
    assert.equal(variant.preservesPitch,true);
    assert.match(variant.label,/导入/);
  }
});

test('the child gets a finite pause based on actual playback duration, including invalid media metadata',()=>{
  for(const duration of [0,1,3,20,NaN,Infinity,-1])for(const rate of [1,.82,0,NaN]){
    const gap=followAlongGapMs(duration,rate);
    assert(Number.isFinite(gap)&&gap>=3000&&gap<=8000);
  }
  assert(followAlongGapMs(4,.82)>followAlongGapMs(4,1));
});
