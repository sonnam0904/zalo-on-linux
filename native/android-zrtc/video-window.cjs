'use strict';
const path=require('node:path');
const {attachVideoPipeReceiver}=require('./video-pipe.cjs');
// Dedicated local display. No signaling logger, account profile, remote URL,
// Node access in page, or unrestricted renderer -> main IPC.
module.exports=function attachVideoWindow(stream,{BrowserWindow,ipcMain},{locked=false}={}) {
  if(typeof locked!=='boolean')throw new TypeError('Video lock state must be boolean');
  let window,pending,serial=0,closed=false,canceled=false;
  const cancelCall=()=>{
    if(canceled || closed)return;
    canceled=true;stream.write(Buffer.alloc(4));
  };
  const clear=()=>{
    canceled=false;
    if(pending){clearTimeout(pending.timer);pending.reject(new Error('Video window closed'));pending=null;}
    const previous=window;window=null;
    if(previous && !previous.isDestroyed())previous.destroy();
  };
  const dispose=()=>{if(closed)return;closed=true;clear();ipcMain.removeListener('linux-video-painted',painted);receiver.close();};
  const painted=(event,id,ok)=>{
    if(!window || event.sender!==window.webContents || !pending || id!==pending.id)return;
    const done=pending;pending=null;clearTimeout(done.timer);
    if(ok===true)done.resolve();else done.reject(new Error('Video rendering failed'));
  };
  ipcMain.on('linux-video-painted',painted);
  async function render(frame) {
    if(closed)throw new Error('Video window unavailable');
    if(locked){cancelCall();return;}
    if(canceled)return; // Drop any in-flight old-call frame until clear ACK.
    if(!window) {
      const created=new BrowserWindow({width:800,height:640,minWidth:360,minHeight:280,
        title:'Zalo — Cuộc gọi video',backgroundColor:'#24272b',show:false,autoHideMenuBar:true,
        webPreferences:{preload:path.join(__dirname,'video-window-preload.cjs'),nodeIntegration:false,
          contextIsolation:true,sandbox:true,partition:'zalo-linux-video',webSecurity:true}});
      window=created;
      created.webContents.session.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));
      created.webContents.session.setPermissionCheckHandler(()=>false);
      created.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      created.webContents.on('will-navigate',event=>event.preventDefault());
      created.webContents.on('render-process-gone',dispose);
      created.on('closed',()=>{
        if(window!==created)return;
        window=null;cancelCall(); // cancel this call, retain helper pipe
        if(pending){const done=pending;pending=null;clearTimeout(done.timer);done.resolve();}
      });
      try {await created.loadFile(path.join(__dirname,'video-window.html'));}
      catch(error){if(canceled)return;throw error;}
      if(canceled || locked)return;
      if(closed || window!==created || created.isDestroyed())throw new Error('Video window closed during loading');
      created.show();
    }
    if(pending)throw new Error('Video window backpressure violation');
    await new Promise((resolve,reject)=>{
      const id=++serial;
      pending={id,resolve,reject,timer:setTimeout(()=>{
        pending=null;reject(new Error('Video renderer timeout'));dispose();
      },4000)};
      try {window.webContents.send('linux-video-frame',id,{...frame,sequence:frame.sequence.toString()});}
      catch(error){clearTimeout(pending.timer);pending=null;reject(error);}
    });
  }
  const receiver=attachVideoPipeReceiver(stream,{render,clear});
  stream.once('close',dispose);stream.once('end',dispose);
  return {dispose,setLocked(value){
    if(typeof value!=='boolean')throw new TypeError('Video lock state must be boolean');
    locked=value;
    if(value && !closed) {
      // An idle helper has no call to cancel. Do not poison its next call
      // with an unconsumed cancel event while the account is simply locked.
      if(window || pending)cancelCall();
      if(pending){const done=pending;pending=null;clearTimeout(done.timer);done.resolve();}
      const previous=window;window=null;
      if(previous && !previous.isDestroyed())previous.destroy();
    }
  }};
};
