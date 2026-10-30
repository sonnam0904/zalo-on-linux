// Standalone account-free acceptance fixture. stdin: frame | clear | quit.
const {app,BrowserWindow,ipcMain}=require('electron');
const {spawn}=require('node:child_process');
const {mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const attach=require('./video-window.cjs');
app.setPath('userData',mkdtempSync(path.join(tmpdir(),'zalo-video-ui-test-')));
app.on('window-all-closed',()=>{}); // clear/recreate is part of this fixture
let child,host;
const timer=setTimeout(()=>app.quit(),180000);
app.on('before-quit',()=>{clearTimeout(timer);host?.dispose();child?.kill('SIGTERM');});
app.whenReady().then(()=>{
  const nativeIndex=process.argv.indexOf('--native-loopback');
  const args=nativeIndex<0?[path.join(__dirname,'test-video-electron-sender.cjs')]:[
    path.join(__dirname,'test-outgoing-answer-pcm.mjs'),process.argv[nativeIndex+1],'--video-receive-loopback','--display-pipe'];
  if(nativeIndex>=0 && (!args[1] || !path.isAbsolute(args[1])))throw new Error('Absolute native fixture runtime required');
  child=spawn(process.execPath,args,
    {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe','pipe']});
  host=attach(child.stdio[3],{BrowserWindow,ipcMain});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  child.on('close',code=>{clearTimeout(timer);host.dispose();app.exit(code?1:0);});
  process.stdin.pipe(child.stdin);
}).catch(()=>{process.exitCode=1;app.quit();});
