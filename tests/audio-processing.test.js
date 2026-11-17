import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('speech gain keeps peak headroom, limits quiet-word boost and leaves PCM samples intact before padding',()=>{
  const program=`
import importlib.util, math
from array import array
spec=importlib.util.spec_from_file_location('audio_builder','tools/build_audio.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert m.PROFILE['wordsPerMinute']==145
assert m.SLOW_PROFILE['tempo']==.82
assert m.SLOW_PROFILE['pitchScale']==1
assert 'wordsPerMinute' not in m.SLOW_PROFILE
assert m.gain_for_levels(-30,-12)==4
assert m.gain_for_levels(-24,-1)==-1
assert m.gain_for_levels(-18,-5)==-5
assert m.gain_for_levels(-23,-8)==0
assert m.gain_for_levels(-20,1)==-3
assert m.PROCESSING['paddingBeforeMs']==100
assert m.PROCESSING['paddingAfterMs']==200
assert m.PROCESSING['trimSilence'] is False
assert m.PROCESSING['fadeSpeech'] is False
assert m.PROCESSING['dynamicCompression'] is False
samples=array('h',[0,12,-30,100,-200,327,0])
padded=m.prepare_pcm(samples,0)
assert list(padded[2205:2205+len(samples)])==list(samples)
assert list(padded[:2205])==[0]*2205
assert list(padded[-4410:])==[0]*4410
assert len(padded)==len(samples)+2205+4410
try:m.gain_for_levels(float('-inf'),float('-inf'))
except ValueError:pass
else:raise AssertionError('silent synthesis must not become a successful clip')
`;
  const result=spawnSync('python3',['-c',program],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});
