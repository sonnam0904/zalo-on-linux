'use strict';
const path=require('node:path');
const {peerName:normalizePeerName,peerAvatar:normalizePeerAvatar}=require('./call-presentation.cjs');
// One window per call. The owner closes it only after media shutdown; changing
// dialog stages or waiting for a mute ACK must not destroy the window.
module.exports=function createCallWindow({BrowserWindow,ipcMain,Notification}) {
  let window,loading,pending,disposed=false,revision=0,startedAt=null,endQueued=false,answerQueued=false,lastKind=null;
  let notification=null;
  const clearAttention=()=>{
    try {notification?.close();}catch {} notification=null;
    try {window?.flashFrame?.(false);}catch {}
    try {window?.setAlwaysOnTop?.(false);}catch {}
  };
  const requestAttention=({video,peerName})=>{
    clearAttention();
    try {window?.setAlwaysOnTop?.(true,'floating');}catch {}
    try {window?.show();window?.focus?.();window?.moveTop?.();window?.flashFrame?.(true);}catch {}
    try {
      if(Notification?.isSupported?.()) {
        const title=video?'Zalo — Cuộc gọi video đến':'Zalo — Cuộc gọi thoại đến';
        notification=new Notification({title,body:peerName?`Từ ${peerName}`:'Có người đang gọi cho bạn',silent:false,timeoutType:'never'});
        notification.on?.('click',()=>{try {window?.show();window?.focus?.();window?.moveTop?.();}catch {}});
        notification.show();
      }
    } catch {notification=null;}
  };
  const framePending=new Map();let frameSerial=0;
  const painted=(event,id,ok)=>{
    if(!window || event.sender!==window.webContents || !framePending.has(id))return;
    const task=framePending.get(id);framePending.delete(id);clearTimeout(task.timer);
    if(ok===true)task.resolve();else task.reject(new Error('Call video rendering failed'));
  };
  ipcMain.on('linux-call-painted',painted);
  const settle=(error,value)=>{
    const current=pending;if(!current)return;
    if(current.kind==='consent')clearAttention();
    pending=null;current.signal.removeEventListener('abort',current.abort);
    if(error)current.reject(error);else current.resolve(value);
  };
  // When the remote party hangs up while no dialog is waiting, the popup has
  // nobody to resolve to: the "end" click used to only set endQueued, which
  // left the window on screen and the app unresponsive until it was killed.
  // Arm a short idle close instead; a new incoming call cancels it.
  let idleClose=null;
  const cancelIdleClose=()=>{if(idleClose!==null){clearTimeout(idleClose);idleClose=null;}};
  const armIdleClose=()=>{
    endQueued=true;
    if(lastKind==='error'){dispose();return;}
    cancelIdleClose();
    idleClose=setTimeout(()=>{idleClose=null;dispose();},1000);
    try {idleClose.unref?.();}catch {}
  };
  const dispose=()=>{
    if(disposed)return;disposed=true;lastKind=null;endQueued=false;answerQueued=false;cancelIdleClose();clearAttention();settle(new Error('Call window closed'));
    ipcMain.removeListener('linux-call-action',action);
    ipcMain.removeListener('linux-call-painted',painted);
    for(const task of framePending.values()){clearTimeout(task.timer);task.reject(new Error('Call window closed'));}framePending.clear();
    if(window && !window.isDestroyed())window.destroy();window=null;
  };
  const traceAction=(note)=>{
    if(process.env.ZALO_ZCALL_LOG==='0')return;
    try {require('fs').appendFileSync(require('path').join(require('os').homedir(),'.config','ZaloData','zcall-agent.log'),
      `${new Date().toISOString()} [call-window] ${note}\n`);} catch {}
  };
  const action=(event,id,value)=>{
    traceAction(`click ${String(value).slice(0,12)} id=${id} revision=${revision} kind=${pending?pending.kind:'none'} ${(!window || event.sender!==window.webContents || id!==revision)?'IGNORED':'accepted'}`);
    if(!window || event.sender!==window.webContents || id!==revision)return;
    if(!pending) {
      if(value==='end') {
        window.webContents.send('linux-call-busy',revision);
        armIdleClose();
      } else if(value==='answer') {
        answerQueued=true;
        window.webContents.send('linux-call-busy',revision);
      }
      return;
    }
    const kind=pending.kind;
    const allowed=kind==='consent'?['answer','end']:kind==='active'?['toggle','end']:['end'];
    if(kind==='active' && pending.cameraControl)allowed.push('camera');
    if(!allowed.includes(value))return;
    // Lock controls until the owner has acknowledged the next state.
    window.webContents.send('linux-call-busy',revision);
    settle(null,kind==='consent'?value==='answer':kind==='active'?value:true);
    if(kind==='error' && value==='end') dispose();
  };
  ipcMain.on('linux-call-action',action);
  const ensure=()=>{
    if(loading)return loading;
    const created=new BrowserWindow({width:500,height:640,minWidth:360,minHeight:420,
      title:'Zalo — Cuộc gọi',show:false,autoHideMenuBar:true,backgroundColor:'#172023',
      webPreferences:{preload:path.join(__dirname,'call-window-preload.cjs'),
        nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,partition:'zalo-linux-call'}});
    window=created;
    created.webContents.session.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));
    created.webContents.session.setPermissionCheckHandler(()=>false);
    created.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    created.webContents.on('will-navigate',event=>event.preventDefault());
    created.webContents.on('render-process-gone',()=>settle(new Error('Call window unavailable')));
    created.on('close',event=>{
      if(disposed)return;
      event.preventDefault();
      if(pending)action({sender:created.webContents},revision,'end');
      else armIdleClose();
    });
    loading=created.loadFile(path.join(__dirname,'call-window.html'));
    return loading;
  };
  return {
    async render(frame,source='remote') {
      if(!['remote','local'].includes(source))throw new Error('Invalid video source');
      if(disposed || !loading)throw new Error('Call display unavailable');
      await loading;
      if(disposed || !window || [...framePending.values()].some(task=>task.source===source))throw new Error('Call display unavailable');
      return new Promise((resolve,reject)=>{
        const id=++frameSerial;
        const task={source,resolve,reject,timer:setTimeout(()=>{
          framePending.delete(id);reject(new Error('Call video renderer timeout'));
        },4000)};framePending.set(id,task);
        try {window.webContents.send('linux-call-frame',id,{...frame,source,sequence:frame.sequence.toString()});}
        catch {clearTimeout(task.timer);framePending.delete(id);reject(new Error('Call video unavailable'));}
      });
    },
    clearVideo(source='remote'){if(window && !disposed)window.webContents.send('linux-call-video-clear',source);},
    async notifyIncoming({video=false,peerName='',peerAvatar=''}={}) {
      if(disposed)throw new Error('Call window unavailable');
      // A queued end click must not close the window of the call that arrives
      // next, and must not answer the new consent dialog either: clear both.
      cancelIdleClose();
      endQueued=false;
      answerQueued=false;
      await ensure();
      if(disposed || pending)throw new Error('Call window unavailable');
      const safeName=normalizePeerName(peerName),safeAvatar=normalizePeerAvatar(peerAvatar);
      lastKind='consent';
      window.webContents.send('linux-call-state',++revision,{kind:'consent',ready:false,video:video===true,
        muted:false,muteControl:false,cameraControl:false,cameraEnabled:true,
        peerName:safeName,peerAvatar:safeAvatar,startedAt:null});
      requestAttention({video:video===true,peerName:safeName});
      return true;
    },
    async dialog(kind,{signal,video=false,muted=false,muteControl=false,cameraControl=false,cameraEnabled=true,peerName='',peerAvatar=''}={}) {
      if(disposed || pending || !['consent','preparing','dialing','active','error'].includes(kind) || !signal || signal.aborted)
        throw new Error('Call window unavailable');
      cancelIdleClose();
      await ensure();
      if(disposed || signal.aborted)throw new Error('Call window canceled');
      // A second request can have been awaiting the same page load.
      if(pending)throw new Error('Call window already waiting');
      if(endQueued) {
        endQueued=false;
        return kind==='consent'?false:kind==='active'?'end':true;
      }
      if(answerQueued && kind==='consent') {
        answerQueued=false;
        return true;
      }
      if(kind==='active' && startedAt===null)startedAt=Date.now();
      return new Promise((resolve,reject)=>{
        const abort=()=>settle(new Error('Call window canceled'));
        pending={kind,signal,abort,resolve,reject,cameraControl:video && cameraControl};signal.addEventListener('abort',abort,{once:true});
        try {
          const safeName=normalizePeerName(peerName),safeAvatar=normalizePeerAvatar(peerAvatar);
          lastKind=kind;
          window.webContents.send('linux-call-state',++revision,{kind,ready:true,video:video===true,
            muted:muted===true,muteControl:muteControl===true,cameraControl:video && cameraControl===true,
            cameraEnabled:cameraEnabled===true,peerName:safeName,peerAvatar:safeAvatar,startedAt});
          if(kind==='consent')requestAttention({video:video===true,peerName:safeName});
          else {clearAttention();window.show();}
        } catch {settle(new Error('Call window unavailable'));}
      });
    },
    dispose(){dispose();}
  };
};