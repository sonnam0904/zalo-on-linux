import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import transport from '../qt-call-cap-linux/desktop-signaling.js';
import {inviteOutgoing} from './outgoing-invitation.mjs';
import {withCameraSession} from './camera-call-session.mjs';
const {DesktopSignaling}=transport;
const mapped={configuration:{callId:789,partnerId:456,session:'fixture'}};
const ready={requestId:123,rtpAddress:'127.0.0.1:9000',rtcpAddress:'127.0.0.1:9001'};
for(const mode of ['answer','remote-end','timeout','error','abort','wrong-peer','cleanup-error']) {
  const worker=new EventEmitter(),commands=[],frames=[],phases=[],abort=new AbortController();
  worker.request=async(operation,args)=>{
    commands.push([operation,args]);
    return {code:0,data:operation==='audioCodecs'?'[{"name":"opus/16000/1","payload":112}]':'{}'};
  };
  const signaling=new DesktopSignaling(message=>{
    frames.push(message);
    queueMicrotask(()=>{
      if((mode==='error' && message.command===416) || (mode==='cleanup-error' && message.command===409))
        return signaling.receive({type:'recvSignalError',command:message.command,data:{callId:789,errorCode:7}});
      signaling.receive({type:'recvSignal',command:message.command,data:undefined});
      if(message.command!==416) return;
      const control=act=>signaling.receive({type:'control',data:{act_type:'voip',act,data:{callId:'789',uidFrom:mode==='wrong-peer'?'457':'456'}}});
      if(mode==='abort') return abort.abort();
      if(mode==='timeout') return;
      control('ringring');control('ringring');
      control(mode==='remote-end'?'endcall':'answer');
    });
  },{timeoutMs:50});
  try {
    const pending=inviteOutgoing(worker,signaling,mapped,ready,{calleeId:'9999999999999999999',signal:abort.signal,
      timeoutMs:40,onPhase:phase=>phases.push(phase)});
    if(['answer','remote-end','cleanup-error'].includes(mode)) {
      const result=await pending;assert.equal(result.callReady,false);
      assert.equal(result.reason,mode==='remote-end'?'remote-declined':'answer-observed');
      assert.equal(phases.filter(p=>p==='peer-ringing').length,mode==='remote-end'?0:1);
    } else await assert.rejects(pending,/timeout|failed|canceled/);
    assert.equal(frames[0].command,416);
    assert.equal(frames[0].data.session,'fixture');
    const connected=['answer','cleanup-error'].includes(mode);
    assert.equal(frames.filter(f=>f.command===409).length,connected?1:0);
    assert.equal(frames.filter(f=>f.command===405).length,!connected && mode!=='remote-end'?1:0);
    if(!connected && mode!=='remote-end')assert.deepEqual(frames.find(f=>f.command===405).data,
      {toId:'9999999999999999999',callId:789,callType:0});
    if(mode==='timeout' || mode==='wrong-peer') assert.ok(!phases.includes('peer-ringing'));
    if(mode==='cleanup-error') assert.ok(phases.includes('remote-cleanup-failed'));
    assert.equal(worker.listenerCount('callEvent'),0);assert.equal(signaling.listenerCount('control'),0);
  } finally {signaling.close();}
}
// Desktop builds may identify the peer with either the native partner ID or
// the noised callee ID, and may spell a pre-answer refusal as reject/busy.
for(const act of ['reject','decline','busy','peer_busy']) {
  const worker=new EventEmitter(),abort=new AbortController();
  worker.request=async op=>({code:0,data:op==='audioCodecs'?'[{"name":"opus/16000/1","payload":112}]':'{}'});
  const signaling=new DesktopSignaling(message=>queueMicrotask(()=>{
    signaling.receive({type:'recvSignal',command:message.command,data:undefined});
    if(message.command===416)signaling.receive({type:'control',data:{act_type:'voip',act,
      data:{callId:'789',uidFrom:'9999999999999999999'}}});
  }));
  assert.equal((await inviteOutgoing(worker,signaling,mapped,ready,
    {calleeId:'9999999999999999999',signal:abort.signal})).reason,'remote-declined');
  signaling.close();
}
{
  const worker=new EventEmitter();
  worker.request=async op=>({code:0,data:op==='audioCodecs'?'[{"name":"opus/16000/1","payload":112}]':'{}'});
  const signaling=new DesktopSignaling(message=>queueMicrotask(()=>{
    signaling.receive({type:'recvSignal',command:message.command,data:undefined});
    if(message.command===416)worker.emit('callEvent',{requestId:ready.requestId,event:'onCallAutoHangup'});
  }));
  assert.equal((await inviteOutgoing(worker,signaling,mapped,ready,
    {calleeId:'9999999999999999999'})).reason,'remote-declined');
  signaling.close();
}
// Canceling an unanswered video invitation must stop peer ringing with the
// video callType. It must never use the connected-call endpoint.
{
  const worker=new EventEmitter(),frames=[],abort=new AbortController();
  worker.request=async op=>({code:0,data:op==='audioCodecs'?'[{"name":"opus/16000/1","payload":112}]':'{}'});
  const signaling=new DesktopSignaling(message=>{
    frames.push(message);
    queueMicrotask(()=>{
      signaling.receive({type:'recvSignal',command:message.command,data:undefined});
      if(message.command===416)abort.abort();
    });
  });
  await assert.rejects(inviteOutgoing(worker,signaling,mapped,ready,
    {calleeId:'9999999999999999999',signal:abort.signal,video:true}),/canceled/);
  assert.deepEqual(frames.filter(frame=>frame.command===405).map(frame=>frame.data),
    [{toId:'9999999999999999999',callId:789,callType:1}]);
  assert.equal(frames.some(frame=>frame.command===409),false);
  signaling.close();
}
// An integrated answer must retain the worker/transport until remote hangup.
{
  const worker=new EventEmitter(),frames=[];
  worker.request=async op=>({code:0,data:op==='audioCodecs'?'[{"name":"opus/16000/1","payload":112}]':'{}'});
  const signaling=new DesktopSignaling(message=>{
    frames.push(message);
    queueMicrotask(()=>signaling.receive({type:'recvSignal',command:message.command,data:undefined}));
  });
  let accepted,release;
  const answerReached=new Promise(resolve=>accepted=resolve);
  const answerGate=new Promise(resolve=>release=resolve);
  let answers=0,ended=false;
  const pending=inviteOutgoing(worker,signaling,mapped,ready,{calleeId:'9999999999999999999',
    onAnswer:async()=>{answers++;accepted();await answerGate;}});
  const control=act=>signaling.receive({type:'control',data:{act_type:'voip',act,data:{callId:'789',uidFrom:'456'}}});
  await new Promise(resolve=>setImmediate(resolve));
  control('answer');control('answer');await answerReached;release();
  pending.then(()=>{ended=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(answers,1);assert.equal(ended,false);assert.equal(frames.some(f=>f.command===409),false);
  control('endcall');assert.equal((await pending).reason,'remote-ended');
  assert.equal(worker.listenerCount('callEvent'),0);signaling.close();
}
for(const mode of ['remote-during-ack','remote-before-answer-task','runtime-fault','worker-exit']) {
  const worker=new EventEmitter(),frames=[];
  let exitWorker;worker.exited=new Promise(resolve=>exitWorker=resolve);
  worker.request=async op=>({code:0,data:op==='audioCodecs'?'[{"name":"opus/16000/1","payload":112}]':'{}'});
  let ackStarted;const ackReached=new Promise(resolve=>ackStarted=resolve);
  const signaling=new DesktopSignaling(message=>{
    frames.push(message);
    if(message.command===408) {ackStarted();return;}
    queueMicrotask(()=>signaling.receive({type:'recvSignal',command:message.command,data:undefined}));
  },{timeoutMs:5000});
  let mediaStarted=false;
  const pending=inviteOutgoing(worker,signaling,mapped,ready,{calleeId:'9999999999999999999',
    onAnswer:async(control,{current})=>{
      await signaling.request(408,{calleeId:'9999999999999999999',callId:789});
      current();mediaStarted=true;
    }});
  const control=act=>signaling.receive({type:'control',data:{act_type:'voip',act,data:{callId:'789',uidFrom:'456'}}});
  await new Promise(resolve=>setImmediate(resolve));control('answer');
  if(mode==='remote-before-answer-task') control('endcall');
  else {
    await ackReached;
    if(mode==='remote-during-ack') control('endcall');
    if(mode==='runtime-fault') worker.emit('nativeFault','fixture');
    if(mode==='worker-exit') exitWorker({code:1});
  }
  if(mode.startsWith('remote')) assert.equal((await pending).reason,
    mode==='remote-before-answer-task'?'remote-declined':'remote-ended');
  else await assert.rejects(pending,/runtime failed/);
  assert.equal(mediaStarted,false);
  assert.equal(signaling.pending.size,0);
  assert.equal(worker.listenerCount('nativeFault'),0);
  assert.equal(frames.filter(f=>f.command===409).length,mode.startsWith('remote')?0:1);
  signaling.close();exitWorker({code:0});
}
console.log('PASS invitation lifecycle: retained answer, pending voice/video cancel 405, connected end 409, runtime/exit cleanup; no claimed media');
for(const mode of ['remote-end','local-end','camera-failure']) {
  const worker=new EventEmitter(),frames=[],abort=new AbortController();
  worker.request=async op=>({code:0,data:op==='audioCodecs'?'[{"name":"opus/16000/1","payload":112}]':'{}'});
  const signaling=new DesktopSignaling(message=>{
    frames.push(message);
    queueMicrotask(()=>signaling.receive({type:'recvSignal',command:message.command,data:undefined}));
  });
  let started,failCamera,stopped=false;
  const captureStarted=new Promise(resolve=>started=resolve);
  const pump=async(_worker,{signal})=>{
    started();
    try {
      await new Promise((resolve,reject)=>{failCamera=()=>reject(new Error('Camera failure'));
        signal.addEventListener('abort',resolve,{once:true});});
    } finally {stopped=true;}
  };
  const pending=withCameraSession(worker,{device:'/dev/video0',signal:abort.signal},({signal,onMediaStarted})=>
    inviteOutgoing(worker,signaling,mapped,ready,{calleeId:'9999999999999999999',signal,onAnswer:async()=>onMediaStarted()}),pump);
  const settled=pending.then(value=>({value}),error=>({error}));
  const control=act=>signaling.receive({type:'control',data:{act_type:'voip',act,data:{callId:'789',uidFrom:'456'}}});
  await new Promise(resolve=>setImmediate(resolve));control('answer');await captureStarted;
  if(mode==='remote-end')control('endcall');
  else if(mode==='local-end')abort.abort();
  else failCamera();
  const result=await settled;
  if(mode==='remote-end')assert.equal(result.value.reason,'remote-ended');
  else assert.match(result.error.message,mode==='camera-failure'?/Camera failure/:/canceled/);
  assert.equal(stopped,true);
  assert.equal(frames.filter(f=>f.command===409).length,mode==='remote-end'?0:1);
  assert.equal(signaling.listenerCount('control'),0);assert.equal(worker.listenerCount('nativeFault'),0);
  signaling.close();
}
console.log('PASS camera + invitation integration: remote/local end and camera failure join capture and clean signaling');
