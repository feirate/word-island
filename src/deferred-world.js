// The learning UI must not wait for Three.js or a model download.
export class DeferredWorld {
  constructor(container,options={},importer=()=>import('./world.js')) {
    this.container=container;this.options=options;this._importer=importer;
    this._view=null;this._task=null;this._disposed=false;this._error=null;
    this._state={scene:'home',companions:[],name:'小探险家',active:false};
    this._focus=null;this._newReady();
  }
  _newReady(){this.ready=new Promise((resolve,reject)=>{this._resolveReady=resolve;this._rejectReady=reject;});this.ready.catch(()=>{});}
  start() {
    if(this._task)return this._task;
    this._error=null;
    this._task=(async()=>{
      const WorldView=this._WorldView||(this._WorldView=(await this._importer()).WorldView);
      if(this._disposed)throw new Error('三维视图已关闭。');
      if(!this._state.active){this._task=null;return this;}
      this._view=new WorldView(this.container,this.options);
      const state=this._state;
      this._view.setScene(state.scene);this._view.setPlayerName(state.name);
      this._view.setCompanionsUnlocked(state.companions);this._view.setActive(state.active);
      await this._view.ready;
      if(this._disposed)throw new Error('三维视图已关闭。');
      if(this._focus)this._view.focusObject(this._focus);
      this._resolveReady(this);return this;
    })().catch(error=>{
      this._error=error.message;this._rejectReady(error);
      // WorldView already reports its own errors; only import failures are ours.
      if(!this._view&&!this._disposed)this.options.onError?.(error);
      throw error;
    });
    this._task.catch(()=>{});return this._task;
  }
  setScene(value){this._state.scene=value;return this._view?.setScene(value);}
  setPlayerName(value){this._state.name=value;return this._view?.setPlayerName(value);}
  setCompanionsUnlocked(value){this._state.companions=[...value];return this._view?.setCompanionsUnlocked(value);}
  setActive(value){this._state.active=value;this._view?.setActive(value);if(value&&!this._view&&!this._error)this.start();}
  focusObject(id){this._focus=id;return this._view?.focusObject(id)||false;}
  resetCamera(){this._focus=null;return this._view?.resetCamera();}
  celebrate(){return this._view?.celebrate();}
  getActorScreenPoint(id){return this._view?.getActorScreenPoint?.(id)||null;}
  getObjectScreenPoint(id){return this._view?.getObjectScreenPoint?.(id)||null;}
  getDiagnostics(){return this._view?.getDiagnostics()||{ready:false,sceneReady:false,scene:this._state.scene,models:[],loadingModels:[],assetErrors:{},error:this._error};}
  get renderer(){return this._view?.renderer;}
  get canvas(){return this._view?.canvas;}
  get camera(){return this._view?.camera;}
  get controls(){return this._view?.controls;}
  async retryLoads(){
    if(this._view)return this._view.retryLoads();
    if(this._task&&!this._error)return this._task;
    this._task=null;this._newReady();return this.start();
  }
  dispose(){this._disposed=true;this._view?.dispose();if(!this._task)this._rejectReady(new Error('三维视图已关闭。'));}
}
