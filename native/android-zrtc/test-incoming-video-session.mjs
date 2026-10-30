import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {IncomingSession} from './incoming-session.mjs';
class Worker extends EventEmitter {
  calls=[];
  holdInfo=null;
  async request(operation,args={}) {
    this.calls.push({operation,args});
    if(operation==='incomingCall')this.emit('callEvent',{event:'onIncomingCall',requestId:2,args:[]});
    if(operation==='callState')this.emit('callEvent',{event:'onCallState',requestId:2,args:[3]});
    if(operation==='callInfo') {
      if(this.holdInfo)await this.holdInfo;
      return {code:0,data:JSON.stringify({rtpAddress:'127.0.0.1:9000',rtcpAddress:'127.0.0.1:9001',sessionId:'fixture'})};
    }
    if(operation==='audioCodecs')return {code:0,data:config.audioConfig};
    if(operation==='extendData')return {code:0,data:config.extendData};
    return {code:0,id:operation==='incomingCall'?2:1};
  }
}
const config={fromId:123,toId:456,callId:789,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},
  rtpIP:'127.0.0.1:9000',rtcpIP:'127.0.0.1:9001',audioConfig:'[{"name":"opus/16000/1","payload":112}]',
  extendData:'{"callType":1,"video":{"codec":[{"name":"h264","payload":97}]}}'};
const worker=new Worker(),sent=[];
const signaling={request:async(...args)=>sent.push(args),cancel(){}};
const disabled=new IncomingSession(worker,signaling);
await assert.rejects(disabled.incoming(config,{video:true}),/disabled/);
assert.equal(worker.calls.length,0);await disabled.dispose();worker.calls=[];
const session=new IncomingSession(worker,signaling,{allowVideo:true});
try {
  await assert.rejects(session.prepareAnswer({callerId:'456'}),/not ringing/);
  const reply=await session.incoming(config,{video:true});
  assert.equal(reply.phase,'ringing');assert.equal(reply.callReady,false);
  assert.equal(worker.calls[0].args.videoCall,true);assert.equal(worker.calls[0].args.supportVideoCall,true);
  assert.deepEqual(sent,[[407,{callerId:456,callId:789}]]);
  assert.deepEqual(worker.calls.map(c=>c.operation),['configure','incomingCall','callEvent','callEvent','callState']);
  assert.equal(worker.calls.at(-1).args.state,'RINGING');
  assert.ok(!worker.calls.some(c=>c.operation==='videoFrame' || c.args.state==='CONFIRMED'));
  const answer=await session.prepareAnswer({callerId:'9999999999999999999'});
  assert.equal(answer.callerId,'9999999999999999999');assert.equal(answer.callId,789);
  assert.equal(answer.session,'fixture');assert.equal(session.phase,'ringing');
  assert.equal(sent.length,1,'preparation must not send 402');
  let release;
  worker.holdInfo=new Promise(resolve=>{release=resolve;});
  const pending=session.prepareAnswer({callerId:'456'});
  const rejected=assert.rejects(pending,/ownership changed/);
  await session.stop();
  await session.incoming(config,{video:true});
  const beforeRelease=worker.calls.length;
  release();await rejected;
  assert.equal(worker.calls.length,beforeRelease,'stale query must not continue on new call');
  assert.equal(session.phase,'ringing','stale preparation must not stop replacement call');
  worker.holdInfo=null;
  assert.equal((await session.prepareAnswer({callerId:'456'})).callId,789);
} finally {await session.dispose();}
await assert.rejects(session.prepareAnswer({callerId:'456'}),/not ringing/);
assert.equal(worker.listenerCount('callEvent'),0);
console.log('PASS video incoming coordinator: explicit opt-in, readiness -> 407 -> ringing, owned answer preparation, stale-query isolation, no capture/answer send');
