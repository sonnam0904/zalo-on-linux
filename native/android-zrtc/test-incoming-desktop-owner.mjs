import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runIncomingDesktop} from './incoming-desktop.mjs';

// Exercise the real desktop driver AND owner/session together. Only native
// IPC, server replies and GTK/media processes are synthetic. No account/device.
const codec='[{"name":"opus/16000/1","payload":112}]';
const extension=JSON.stringify({callType:1,video:{codec:[{name:'h264',payload:97}]}});
const untilAbort=signal=>new Promise(resolve=>{
  if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});
});
for(const video of [false,true])for(const scenario of ['local-reject','consent-cancel','answer-cancel','media-cancel','local-end','native-fault']) {
  const events=[],dialogs=[],transport=new EventEmitter(),controller=new AbortController();
  const params={id:789,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},rtpIP:'127.0.0.1:9000',
    rtcpIP:'127.0.0.1:9001',video:{enable:video?1:0},extendData:extension};
  const message={type:'control',data:{act_type:'voip',act:'request',data:{uidFrom:'456',uidTo:'123',
    uidN:'9999999999999999999',callId:'789',codec,params:JSON.stringify(params)}}};
  const remoteCancel=()=>transport.emit('control',{act_type:'voip',act:'cancel',data:{uidFrom:'456',callId:'789'}});
  class Worker extends EventEmitter {
    async request(op,args={}) {
      events.push(op);
      if(op==='incomingCall')this.emit('callEvent',{event:'onIncomingCall',requestId:2,args:[]});
      if(op==='callState')this.emit('callEvent',{event:'onCallState',requestId:2,args:[args.state==='CONFIRMED'?5:3]});
      if(op==='videoStats')return {code:0,data:JSON.stringify({codecId:4,videoCall:true,canTransferMedia:true,captureThreadRunning:true})};
      if(op==='callInfo')return {code:0,data:JSON.stringify({rtpAddress:params.rtpIP,rtcpAddress:params.rtcpIP,sessionId:'fixture'})};
      if(op==='audioCodecs')return {code:0,data:codec};
      if(op==='extendData')return {code:0,data:extension};
      return {code:0,id:op==='incomingCall'?2:1};
    }
    async close() {
      for(const event of ['callEvent','nativeFault','workerClosed'])assert.equal(this.listenerCount(event),0);
      events.push('closed');
    }
  }
  const worker=new Worker();
  transport.request=async(command,payload)=>{
    events.push(command);
    if(command===402)queueMicrotask(()=>{
      if(scenario==='answer-cancel')remoteCancel();
      else transport.emit('control',{act_type:'voip',act:'answer_ack',data:{callId:789}});
    });
    if(command===405)
      assert.deepEqual(payload,{toId:message.data.data.uidN,callId:789,callType:video?1:0});
    if(command===409) {
      assert.deepEqual(payload,{toId:message.data.data.uidN,callId:789});
      assert.equal(events.at(-2),'stop','native stopped before end API');
    }
    return {};
  };
  transport.cancel=()=>{};
  const running=runIncomingDesktop(transport,message,{nativeLocalId:123,clientVersion:0,runtime:'/fixture',
    pcm:{source:'mic',sink:'speaker'},videoEnabled:video,device:'/dev/video0',sink:{},signal:controller.signal},{
    startWorker:async()=>worker,
    dialog:async(kind,{signal})=>{
      dialogs.push(kind);
      if(kind==='error'){assert.equal(events.at(-1),'closed');return true;}
      if(kind==='consent') {
        if(scenario==='consent-cancel'){remoteCancel();await untilAbort(signal);throw Error('dialog canceled');}
        if(scenario==='local-reject')return false;
        return true;
      }
      if(scenario==='local-end')return 'end';
      queueMicrotask(()=>scenario==='native-fault'?worker.emit('nativeFault'):remoteCancel());
      await untilAbort(signal);events.push('dialog-joined');throw Error('dialog canceled');
    },
    videoMedia:async(_worker,{signal})=>{await untilAbort(signal);events.push('video-joined');},
  });
  if(['consent-cancel','answer-cancel','native-fault'].includes(scenario))await assert.rejects(running);
  else assert.deepEqual(await running,{accepted:scenario!=='local-reject',callReady:false});
  assert.equal(events.filter(x=>x===405).length,scenario==='local-reject'?1:0);
  assert.equal(events.filter(x=>x===409).length,['local-end','native-fault','local-reject'].includes(scenario)?1:0);
  assert.equal(dialogs.includes('error'),scenario==='native-fault');
  assert.equal(events.filter(x=>x==='closed').length,1);
  if(video && ['media-cancel','local-end','native-fault'].includes(scenario))
    assert.ok(events.indexOf('video-joined')<events.lastIndexOf('stop'));
  assert.equal(transport.listenerCount('control'),0);
}
console.log('PASS real incoming desktop/owner composition: voice/video consent, answer/media cancel, local end, native fault, no remote echo, cleanup before notification');
