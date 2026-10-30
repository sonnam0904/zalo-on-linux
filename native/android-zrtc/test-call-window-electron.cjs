'use strict';
// Isolated visual/control fixture. No Zalo profile, network, camera or mic.
const {app,BrowserWindow,ipcMain}=require('electron');
const path=require('node:path');
app.setPath('userData',path.join(app.getPath('home'),'zalo-native-recovery','call-window-fixture-profile'));
app.whenReady().then(async()=>{
  const {Duplex}=require('node:stream');
  function pair(){let a,b;
    a=new Duplex({read(){},write(chunk,_encoding,done){b.push(Buffer.from(chunk));done();},destroy(error,done){b.push(null);done(error);}});
    b=new Duplex({read(){},write(chunk,_encoding,done){a.push(Buffer.from(chunk));done();},destroy(error,done){a.push(null);done(error);}});
    return [a,b];
  }
  const [controlClient,controlHost]=pair(),[videoClient,videoHost]=pair();
  const [previewClient,previewHost]=pair();
  const host=require('./desktop-call-window.cjs')(controlHost,videoHost,{BrowserWindow,ipcMain},{locked:false},previewHost);
  const preview=require('./video-pipe.cjs').createVideoPipeSink(previewClient);
  let previewSequence=0n;
  const renderPreview=()=>preview.render({format:'I420',width:2,height:2,sequence:++previewSequence,pixels:Buffer.from([200,100,70,160,100,180])});
  const client=require('./call-ui-pipe.cjs').createCallUIClient(controlClient);
  const video=require('./video-pipe.cjs').createVideoPipeSink(videoClient),controller=new AbortController();
  const timeout=setTimeout(()=>{controller.abort();host.dispose();app.exit(1);},180000);
  try {
    if(process.argv.includes('--preparation-only')) {
      const assert=require('node:assert/strict');
      const {OutgoingSetup}=require('../qt-call-cap-linux/outgoing-setup');
      const {DesktopSignaling}=require('../qt-call-cap-linux/desktop-signaling');
      const {outgoingPreparation}=require('./outgoing-preparation.cjs');
      const frames=[];
      const signaling=new DesktopSignaling(frame=>frames.push(frame),{timeoutMs:180000});
      const setup=new OutgoingSetup(signaling,{allowVideo:true,callId:()=>789,
        onPreparing:options=>outgoingPreparation((kind,details)=>client.dialog(kind,details),options),
        onConfig:()=>assert.fail('Canceled preparation must not configure a worker')});
      try {
        await assert.rejects(setup.start({type:3,partner:[{id:'9999999999999999999',name:'Liên hệ kiểm thử 🎥'}]}),/canceled/);
        assert.equal(frames.length,1);assert.equal(frames[0].command,401);
        assert.equal(setup.active,null);
        await client.clear();
        console.log('PASS Electron outgoing preparation: real setup/control pipe, pre-config cancel, no worker/invitation (synthetic signaling)');
      } finally {signaling.close();host.dispose();clearTimeout(timeout);}
      app.quit();return;
    }
    const accepted=await client.dialog('consent',{signal:controller.signal,video:true});
    if(!accepted)throw new Error('Fixture was not answered');
    let muted=false,toggles=0,cameraEnabled=true,cameraToggles=0;
    for(;;) {
      const actionTask=client.dialog('active',{signal:controller.signal,video:true,muteControl:true,muted,cameraControl:true,cameraEnabled});
      if(toggles===0 && cameraToggles===0)await video.render({format:'I420',width:4,height:4,sequence:1n,
        pixels:Buffer.from([50,90,150,210,50,90,150,210,50,90,150,210,50,90,150,210,90,90,180,180,150,150,80,80])});
      if(toggles===0 && cameraToggles===0)await renderPreview();
      const action=await actionTask;
      if(action==='end')break;
      if(action==='camera'){
        cameraEnabled=!cameraEnabled;cameraToggles++;
        if(cameraEnabled)await renderPreview();else await preview.clear();
        continue;
      }
      muted=!muted;toggles++;
    }
    if(toggles<2)throw new Error('Fixture requires mute and unmute');
    if(cameraToggles<2)throw new Error('Fixture requires camera off and on');
    await video.clear();await preview.clear();await client.clear();
    console.log('PASS Electron call window over control/video pipes: consent, synthetic I420, mic/camera toggles, end (no live media)');
    host.dispose();clearTimeout(timeout);app.quit();
  } catch(error){host.dispose();clearTimeout(timeout);console.error(error.message);app.exit(1);}
});
