const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const create=require('./call-window.cjs');
const ipcMain=new EventEmitter(),windows=[],notifications=[];
class Notification extends EventEmitter {
  static isSupported(){return true;}
  constructor(options){super();this.options=options;notifications.push(this);}
  show(){this.shown=true;} close(){this.closed=true;}
}
class Window extends EventEmitter {
  constructor(options){super();this.options=options;windows.push(this);this.messages=[];
    this.webContents=new EventEmitter();
    this.webContents.session={setPermissionRequestHandler:fn=>this.permission=fn,setPermissionCheckHandler:fn=>this.check=fn};
    this.webContents.setWindowOpenHandler=fn=>this.open=fn;
    this.webContents.send=(...args)=>this.messages.push(args);
  }
  async loadFile(file){assert.ok(file.endsWith('call-window.html'));}
  show(){this.shown=true;} focus(){this.focused=true;} moveTop(){this.movedTop=true;}
  flashFrame(value){this.flashing=value;} setAlwaysOnTop(value){this.alwaysOnTop=value;}
  destroy(){this.destroyed=true;}
  isDestroyed(){return !!this.destroyed;}
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  const host=create({BrowserWindow:Window,ipcMain,Notification});
  const preparingStage=new AbortController();
  const preparing=host.dialog('preparing',{signal:preparingStage.signal});
  const preparationCanceled=assert.rejects(preparing,/canceled/);await turn();
  assert.equal(windows[0].messages.at(-1)[2].kind,'preparing');
  assert.equal(windows[0].messages.at(-1)[2].startedAt,null);
  preparingStage.abort();await preparationCanceled;
  const stage=new AbortController();
  const dialing=host.dialog('dialing',{signal:stage.signal,video:true});
  const canceled=assert.rejects(dialing,/canceled/);await turn();
  const window=windows[0];assert.ok(window.shown);
  assert.equal(window.options.webPreferences.sandbox,true);assert.equal(window.check(),false);
  assert.deepEqual(window.open(),{action:'deny'});
  stage.abort();await canceled;assert.ok(!window.destroyed);
  const signal=new AbortController().signal;
  let active=host.dialog('active',{signal,video:true,muteControl:true,muted:false});await turn();
  const state=window.messages.at(-1);assert.equal(state[0],'linux-call-state');assert.equal(state[2].muted,false);
  const frame={format:'I420',width:2,height:2,sequence:1n,pixels:Buffer.alloc(6)};
  const remote=host.render(frame,'remote'),local=host.render(frame,'local');await turn();
  await assert.rejects(host.render(frame,'remote'),/unavailable/);
  const frames=window.messages.filter(m=>m[0]==='linux-call-frame');assert.equal(frames.length,2);
  for(const message of frames)ipcMain.emit('linux-call-painted',{sender:window.webContents},message[1],true);
  await Promise.all([remote,local]);
  window.messages.splice(window.messages.indexOf(state)+1);
  ipcMain.emit('linux-call-action',{sender:{}},state[1],'toggle');
  ipcMain.emit('linux-call-action',{sender:window.webContents},state[1]-1,'end');
  ipcMain.emit('linux-call-action',{sender:window.webContents},state[1],'answer');
  assert.equal(window.messages.at(-1),state,'Foreign/stale/inapplicable actions ignored');
  ipcMain.emit('linux-call-action',{sender:window.webContents},state[1],'toggle');assert.equal(await active,'toggle');
  assert.equal(window.messages.at(-1)[0],'linux-call-busy');
  active=host.dialog('active',{signal,video:true,muteControl:true,muted:true});await turn();
  assert.equal(windows.length,1,'Mute acknowledgement reuses the call window');
  assert.equal(window.messages.at(-1)[2].startedAt,state[2].startedAt);
  assert.equal(window.messages.at(-1)[2].muted,true);
  window.emit('close',{preventDefault(){}});assert.equal(await active,'end');
  host.dispose();assert.ok(window.destroyed);assert.equal(ipcMain.listenerCount('linux-call-action'),0);
  await assert.rejects(host.dialog('dialing',{signal}),/unavailable/);
  const incoming=create({BrowserWindow:Window,ipcMain,Notification});
  await incoming.notifyIncoming({video:true});
  assert.equal(windows[1].messages.at(-1)[2].ready,false);
  assert.equal(notifications.length,1);assert.ok(notifications[0].shown);
  const consent=incoming.dialog('consent',{signal,video:true,peerName:'Người gọi thử',peerAvatar:'https://s120.avatar.talk.zdn.vn/a.jpg'});await turn();
  const second=windows[1],id=second.messages.at(-1)[1];
  assert.equal(second.messages.at(-1)[2].peerAvatar,'https://s120.avatar.talk.zdn.vn/a.jpg');
  assert.ok(second.focused && second.movedTop && second.flashing && second.alwaysOnTop);
  assert.equal(notifications.length,2);assert.ok(notifications[0].closed);assert.ok(notifications[1].shown);
  assert.deepEqual(notifications[1].options,{title:'Zalo — Cuộc gọi video đến',body:'Từ Người gọi thử',silent:false,timeoutType:'never'});
  ipcMain.emit('linux-call-action',{sender:second.webContents},id,'answer');assert.equal(await consent,true);
  assert.ok(notifications[1].closed);assert.equal(second.flashing,false);assert.equal(second.alwaysOnTop,false);
  second.emit('close',{preventDefault(){}});
  assert.equal(await incoming.dialog('active',{signal,muteControl:true}),'end','Close during command/stage gap must not be lost');
  incoming.dispose();
  // Error dialog: clicking 'end' (Đóng) must dispose/destroy the window
  const errHost=create({BrowserWindow:Window,ipcMain,Notification});
  const errDialog=errHost.dialog('error',{signal});await turn();
  const errWin=windows.at(-1),errId=errWin.messages.at(-1)[1];
  assert.equal(errWin.messages.at(-1)[2].kind,'error');
  ipcMain.emit('linux-call-action',{sender:errWin.webContents},errId,'end');
  assert.equal(await errDialog,true);
  assert.ok(errWin.destroyed,'Error dialog click must dispose window');
  assert.equal(ipcMain.listenerCount('linux-call-action'),0);
  // Notify incoming: clicking 'end' (Từ chối) during preparation must resolve consent to false
  const declHost=create({BrowserWindow:Window,ipcMain,Notification});
  await declHost.notifyIncoming({video:false});
  const declWin=windows.at(-1),declId=declWin.messages.at(-1)[1];
  ipcMain.emit('linux-call-action',{sender:declWin.webContents},declId,'end');
  const declConsent=declHost.dialog('consent',{signal});
  assert.equal(await declConsent,false,'Decline during preparation must resolve consent to false');
  declHost.dispose();
  // Error dialog: window manager close (X) must dispose window
  const errCloseHost=create({BrowserWindow:Window,ipcMain,Notification});
  errCloseHost.dialog('error',{signal});await turn();
  const errCloseWin=windows.at(-1);
  errCloseWin.emit('close',{preventDefault(){}});
  assert.ok(errCloseWin.destroyed,'Close button on error dialog must dispose window');
  console.log('PASS persistent call window: stage transitions, ACK state, scoped actions, duration, close, consent, cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
