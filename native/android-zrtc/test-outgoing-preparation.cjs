const assert=require('node:assert/strict');
const {outgoingPreparation}=require('./outgoing-preparation.cjs');
const {OutgoingSetup}=require('../qt-call-cap-linux/outgoing-setup');
const {DesktopSignaling}=require('../qt-call-cap-linux/desktop-signaling');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const intent={type:1,partner:[{id:'9999999999999999999',name:'Tên thử'}]};
const watchdog=setTimeout(()=>{console.error('FAIL outgoing preparation stalled');process.exit(1);},10000);
(async()=>{
  for(const video of [false,true])for(const mode of ['handoff','cancel-config','cancel-native','config-error','native-error','ui-error','parent-abort']) {
    const events=[],frames=[];let act,joined=false,entered=false;
    const signaling=new DesktopSignaling(frame=>frames.push(frame),{timeoutMs:1000});
    const dialog=(kind,{signal,video:isVideo,peerName})=>{
      assert.equal(kind,'preparing');assert.equal(isVideo,video);assert.equal(peerName,'Tên thử');events.push('preparing');
      if(mode==='ui-error')return Promise.reject(new Error('UI failed'));
      return new Promise((resolve,reject)=>{
        const abort=()=>{signal.removeEventListener('abort',abort);setImmediate(()=>{joined=true;reject(new Error('stage canceled'));});};
        signal.addEventListener('abort',abort,{once:true});
        act=()=>{signal.removeEventListener('abort',abort);joined=true;resolve(true);};
      });
    };
    const setup=new OutgoingSetup(signaling,{callId:()=>789,allowVideo:true,
      onPreparing:options=>outgoingPreparation(dialog,options),
      onConfig:async(_config,{signal,current,finishPreparing})=>{
        entered=true;events.push('native');
        if(mode==='native-error')throw new Error('Native failed');
        if(mode==='cancel-native') {
          act();await tick();assert.equal(signal.aborted,true);current();
        }
        await finishPreparing();assert.equal(joined,true,'Join UI before dialing');
        current();events.push('dialing');return true;
      }});
    const running=setup.start({...intent,type:video?3:1});
    const outcome=mode==='handoff'?running:assert.rejects(running,/failed|canceled/i);
    await tick();assert.equal(events[0],'preparing');
    assert.equal(frames.length,1,'Only config request while preparation visible');
    if(mode==='cancel-config')act();
    else if(mode==='parent-abort')await setup.stop();
    else if(mode==='config-error')signaling.receive({type:'recvSignalError',command:401,data:{callId:789,errorCode:7}});
    else if(mode!=='ui-error')signaling.receive({type:'recvSignal',command:401,data:{id:789}});
    await outcome;
    assert.equal(entered,['handoff','cancel-native','native-error'].includes(mode));
    assert.equal(events.includes('dialing'),mode==='handoff');
    assert.equal(setup.active,null);
    assert.ok(frames.every(frame=>frame.command===401));signaling.close();
  }
  const controller=new AbortController();controller.abort();
  const finish=outgoingPreparation(()=>assert.fail('Already aborted'),{
    signal:controller.signal,cancel:()=>assert.fail('No extra cancellation')});
  await finish();await finish();
  console.log('PASS outgoing preparation: immediate pre-config UI, cancellation during config/native startup, joined handoff, config/native/UI failures, parent abort');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>clearTimeout(watchdog));
