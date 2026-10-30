const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Duplex}=require('node:stream');
const attach=require('./video-window.cjs');
const {createVideoPipeSink}=require('./video-pipe.cjs');
const ipcMain=new EventEmitter(),windows=[];let hold=false,entered,loading,loadEntered;
class Window extends EventEmitter {
  constructor(options){super();this.options=options;this.destroyed=false;windows.push(this);
    this.webContents=new EventEmitter();
    this.webContents.session={setPermissionRequestHandler:fn=>this.permission=fn,setPermissionCheckHandler:fn=>this.checkPermission=fn};
    this.webContents.setWindowOpenHandler=fn=>this.open=fn;
    this.webContents.send=(channel,id,frame)=>{
      assert.equal(channel,'linux-video-frame');assert.equal(frame.width,2);
      if(hold){entered();return;}
      ipcMain.emit('linux-video-painted',{sender:{}},id,true); // wrong sender must not consume pending ACK
      ipcMain.emit('linux-video-painted',{sender:this.webContents},id,true);
    };
  }
  async loadFile(file){assert.ok(file.endsWith('video-window.html'));if(loading){loadEntered();await loading;}}
  show(){this.shown=true;}
  isDestroyed(){return this.destroyed;}
  destroy(){this.destroyed=true;this.emit('closed');}
}
let a,b;
a=new Duplex({read(){},write(chunk,_encoding,done){b.push(Buffer.from(chunk));done();}});
b=new Duplex({read(){},write(chunk,_encoding,done){a.push(Buffer.from(chunk));done();}});
(async()=>{
  const host=attach(b,{BrowserWindow:Window,ipcMain}),sink=createVideoPipeSink(a);
  const frame={format:'I420',width:2,height:2,sequence:1n,pixels:Buffer.alloc(6,128)};
  await sink.render(frame);assert.equal(windows.length,1);assert.ok(windows[0].shown);
  const preferences=windows[0].options.webPreferences;
  assert.equal(preferences.nodeIntegration,false);assert.equal(preferences.sandbox,true);assert.equal(preferences.contextIsolation,true);
  assert.equal(windows[0].checkPermission(),false);assert.deepEqual(windows[0].open(),{action:'deny'});
  let permission;windows[0].permission(null,'camera',value=>permission=value);assert.equal(permission,false);
  await sink.clear();assert.ok(windows[0].destroyed);assert.equal(ipcMain.listenerCount('linux-video-painted'),1);
  await sink.render({...frame,sequence:2n});assert.equal(windows.length,2);
  let cancellations=0;const unsubscribe=sink.onCancel(()=>{cancellations++;});
  windows[1].destroy();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancellations,1);await assert.rejects(sink.render(frame),/canceled/);
  await sink.clear();await sink.render({...frame,sequence:3n});assert.equal(windows.length,3);
  hold=true;const waiting=new Promise(resolve=>entered=resolve);
  const rendering=sink.render({...frame,sequence:4n});await waiting;
  windows[2].destroy();await rendering;assert.equal(cancellations,2);
  await sink.clear();hold=false;await sink.render({...frame,sequence:5n});assert.equal(windows.length,4);
  host.setLocked(true);await new Promise(resolve=>setImmediate(resolve));assert.ok(windows[3].destroyed);
  await sink.clear();await sink.render({...frame,sequence:6n});assert.equal(windows.length,4,'Locked host must never create a video window');
  host.setLocked(false);await sink.clear();await sink.render({...frame,sequence:7n});assert.equal(windows.length,5);
  await sink.clear();const beforeIdle=cancellations;
  host.setLocked(true);host.setLocked(true);host.setLocked(false);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(cancellations,beforeIdle,'Idle lock must not cancel a future call');
  await sink.render({...frame,sequence:8n});assert.equal(windows.length,6);
  await sink.clear();
  let releaseLoad;loading=new Promise(resolve=>releaseLoad=resolve);
  const loadStarted=new Promise(resolve=>loadEntered=resolve);
  const delayed=sink.render({...frame,sequence:9n});await loadStarted;
  host.setLocked(true);host.setLocked(true);host.setLocked(false);releaseLoad();await delayed;
  assert.ok(windows[6].destroyed);assert.ok(!windows[6].shown,'A window locked during load must never show after unlock');
  assert.equal(cancellations,beforeIdle+1,'Repeated lock must emit only one cancellation');
  loading=null;await sink.clear();await sink.render({...frame,sequence:10n});assert.equal(windows.length,8);
  assert.throws(()=>host.setLocked('false'),/boolean/);
  unsubscribe();host.dispose();assert.ok(windows[7].destroyed);assert.equal(ipcMain.listenerCount('linux-video-painted'),0);
  sink.close();host.dispose();
  console.log('PASS display host: scoped IPC, restrictions, idle/in-flight user cancel, clear/reopen on same pipe, dispose (mock Electron)');
})().catch(error=>{console.error(error);process.exitCode=1;});
