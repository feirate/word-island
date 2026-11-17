import test from 'node:test';
import assert from 'node:assert/strict';

const moduleURL=new URL('../src/deferred-world.js',import.meta.url);
function fakeView(log,{ready=Promise.resolve()}={}) {
  return class {
    constructor(container,options){log.push(['construct',container]);this.ready=ready;this.options=options;this.renderer={};}
    setScene(value){log.push(['scene',value]);}
    setCompanionsUnlocked(value){log.push(['companions',value]);}
    setPlayerName(value){log.push(['name',value]);}
    setActive(value){log.push(['active',value]);}
    focusObject(value){log.push(['focus',value]);return true;}
    getDiagnostics(){return {ready:true,sceneReady:true,scene:'camp'};}
    dispose(){log.push(['dispose']);}
  };
}

test('the learning shell imports no 3D code until the chosen profile activates the world',async()=>{
  const {DeferredWorld}=await import(moduleURL);const log=[];let imports=0;
  const world=new DeferredWorld('canvas',{},async()=>{imports++;return {WorldView:fakeView(log)};});
  world.setActive(false);world.setScene('home');world.setScene('camp');world.setPlayerName('Lucy');world.setCompanionsUnlocked(['bunny']);
  await Promise.resolve();assert.equal(imports,0);assert.equal(world.getDiagnostics().ready,false);
  world.setActive(true);world.setActive(true);await world.ready;
  assert.equal(imports,1);assert.equal(log.filter(x=>x[0]==='construct').length,1);
  assert.deepEqual(log.find(x=>x[0]==='scene'),['scene','camp']);
  assert.deepEqual(log.find(x=>x[0]==='name'),['name','Lucy']);
  assert.deepEqual(log.find(x=>x[0]==='companions'),['companions',['bunny']]);
  assert.equal(world.getDiagnostics().sceneReady,true);
});

test('actions remain safe during loading and a late profile change wins',async()=>{
  const {DeferredWorld}=await import(moduleURL);const log=[];let release;
  const module=new Promise(resolve=>{release=resolve;});const world=new DeferredWorld(null,{},()=>module);
  assert.equal(world.getActorScreenPoint('guide'),null);assert.equal(world.getObjectScreenPoint('camp.crate'),null);
  world.setActive(true);world.setPlayerName('甲');world.setPlayerName('乙');world.focusObject('camp.crate');
  release({WorldView:fakeView(log)});await world.ready;
  assert.deepEqual(log.find(x=>x[0]==='name'),['name','乙']);assert.equal(log.some(x=>x[0]==='focus'),true);
});

test('a failed 3D import reports an error without disabling shell actions and can be retried',async()=>{
  const {DeferredWorld}=await import(moduleURL);const log=[],errors=[];let attempt=0;
  const world=new DeferredWorld(null,{onError:error=>errors.push(error.message)},async()=>{
    if(++attempt===1)throw new Error('3D offline');return {WorldView:fakeView(log)};
  });
  world.setActive(true);await assert.rejects(world.ready,/3D offline/);
  assert.equal(world.getDiagnostics().ready,false);assert.equal(errors.length,1);
  await world.retryLoads();assert.equal(attempt,2);assert.equal(world.getDiagnostics().ready,true);
});

test('disposing during a delayed import prevents a renderer from being created',async()=>{
  const {DeferredWorld}=await import(moduleURL);const log=[];let release;
  const world=new DeferredWorld(null,{},()=>new Promise(resolve=>{release=resolve;}));world.ready.catch(()=>{});
  world.setActive(true);await Promise.resolve();world.dispose();release({WorldView:fakeView(log)});
  await assert.rejects(world.ready,/关闭/);assert.equal(log.length,0);
});

test('leaving during a delayed import waits for activation before allocating the world',async()=>{
  const {DeferredWorld}=await import(moduleURL);const log=[];let release,imports=0;
  const world=new DeferredWorld(null,{},()=>{imports++;return new Promise(resolve=>{release=resolve;});});
  world.setActive(true);world.setActive(false);release({WorldView:fakeView(log)});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(log.length,0);
  world.setActive(true);await world.ready;assert.equal(imports,1);assert.equal(log.filter(x=>x[0]==='construct').length,1);
});
