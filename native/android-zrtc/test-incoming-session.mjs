import assert from 'node:assert/strict';
import {NativeWorker} from './worker-client.mjs';
import {IncomingSession} from './incoming-session.mjs';
import transport from '../qt-call-cap-linux/desktop-signaling.js';
const {DesktopSignaling}=transport;
const config={fromId:123,toId:456,protocol:1,callId:789,sessId:'fixture',settings:{},zrtc_config:{},
  rtpIP:'127.0.0.1:9000',rtcpIP:'127.0.0.1:9001',audioConfig:JSON.stringify([
    {name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}])};
const worker=await NativeWorker.start(process.argv[2]);
let nativeRequestId=0;
worker.on('callEvent',e=>{nativeRequestId=e.requestId;});
try {
  for(const mode of ['native-timeout','cancel-native','success','error','cancel','timeout','success']) {
    let sent;
    const signaling=new DesktopSignaling(message=>{
      sent=message;
      if(mode==='success') queueMicrotask(()=>signaling.receive({type:'recvSignal',command:407,data:undefined}));
      if(mode==='error') queueMicrotask(()=>signaling.receive({type:'recvSignalError',command:407,data:{callId:789,errorCode:9}}));
    },{timeoutMs:100});
    const session=new IncomingSession(worker,signaling,{readyTimeoutMs:100});
    const phases=[];session.on('phase',phase=>phases.push(phase));
    // No RTP server exists in this fixture. Inject ONLY its readiness event
    // to exercise the coordinator beyond the independently tested gate.
    if(!['native-timeout','cancel-native'].includes(mode)) session.on('phase',phase=>{
      if(phase==='awaiting-native') worker.emit('callEvent',{requestId:nativeRequestId,event:'onIncomingCall',args:[]});
    });
    if(mode==='cancel-native') session.on('phase',phase=>{if(phase==='awaiting-native') queueMicrotask(()=>session.stop());});
    if(mode==='cancel') session.on('phase',phase=>{if(phase==='signaling') queueMicrotask(()=>session.stop());});
    try {
      const pending=session.incoming(config);
      await assert.rejects(session.incoming(config),/busy/);
      if(mode==='success') {
        assert.equal((await pending).phase,'ringing');
        assert.equal(session.phase,'ringing');
      } else {
        await assert.rejects(pending,/failed|canceled|timeout/);
        assert.ok(!phases.includes('ringing'));
      }
      if(['native-timeout','cancel-native'].includes(mode)) assert.equal(sent,undefined);
      else assert.deepEqual(sent,{type:'sendSignal',command:407,data:{callerId:456,callId:789}});
      await session.stop();assert.equal(session.phase,'idle');
      assert.equal((await worker.request('status')).initialized,false);
      if(['cancel','timeout'].includes(mode))
        assert.equal(signaling.receive({type:'recvSignal',command:407,data:undefined}),false);
    } finally {await session.dispose();signaling.close();}
  }
} finally {assert.deepEqual(await worker.close(),{code:0,signal:null});}
console.log('PASS incoming coordinator: offline readiness gate, real native setup/ringing with injected readiness, mock ACK/error/cancel/timeout; no network call');
