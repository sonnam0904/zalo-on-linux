'use strict';
const {contextBridge,ipcRenderer}=require('electron');
let subscribed=false,frames=false;
contextBridge.exposeInMainWorld('linuxCall',{
  subscribe(onState,onBusy) {
    if(subscribed || typeof onState!=='function' || typeof onBusy!=='function')throw new Error('Invalid call subscription');
    subscribed=true;
    ipcRenderer.on('linux-call-state',(_event,id,state)=>onState(id,state));
    ipcRenderer.on('linux-call-busy',(_event,id)=>onBusy(id));
  },
  act(id,action) {
    if(Number.isSafeInteger(id) && ['answer','end','toggle','camera'].includes(action))
      ipcRenderer.send('linux-call-action',id,action);
  },
  onFrame(render,clear) {
    if(frames || typeof render!=='function' || typeof clear!=='function')throw new Error('Invalid frame subscription');
    frames=true;
    ipcRenderer.on('linux-call-frame',(_event,id,frame)=>{
      Promise.resolve().then(()=>render(frame)).then(
        ()=>ipcRenderer.send('linux-call-painted',id,true),
        ()=>ipcRenderer.send('linux-call-painted',id,false));
    });
    ipcRenderer.on('linux-call-video-clear',(_event,source)=>clear(source));
  }
});
