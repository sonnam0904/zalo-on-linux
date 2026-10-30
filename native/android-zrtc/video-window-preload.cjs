'use strict';
const {contextBridge,ipcRenderer}=require('electron');
let listener;
contextBridge.exposeInMainWorld('linuxVideo',{
  onFrame(callback){
    if(listener || typeof callback!=='function')throw new Error('Video listener already installed');
    listener=(_event,id,frame)=>{
      Promise.resolve().then(()=>callback(frame)).then(
        ()=>ipcRenderer.send('linux-video-painted',id,true),
        ()=>ipcRenderer.send('linux-video-painted',id,false));
    };
    ipcRenderer.on('linux-video-frame',listener);
  }
});
