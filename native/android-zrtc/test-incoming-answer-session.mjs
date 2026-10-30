import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {IncomingSession} from './incoming-session.mjs';
const config={fromId:123,toId:456,callId:789,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},
  rtpIP:'127.0.0.1:9000',rtcpIP:'127.0.0.1:9001',audioConfig:'[{"name":"opus/16000/1","payload":112}]',
  extendData:'{"callType":1,"video":{"codec":[{"name":"h264","payload":97}]}}'};
function fixture() {
  const events=[];let resolve,reject,entered;
  const sent=new Promise(r=>{entered=r;});
  class Worker extends EventEmitter {
    failEvent=false;
    failConfirm=false;omitConfirmed=false;badStats=false;holdConfirm=null;
    async request(op,args={}) {
      events.push([op,args.event??args.state]);
      if(op==='incomingCall')this.emit('callEvent',{event:'onIncomingCall',requestId:2,args:[]});
      if(op==='callState') {
        if(args.state==='CONFIRMED') {
          if(this.holdConfirm)await this.holdConfirm;
          if(this.failConfirm)return {code:-95};
          if(!this.omitConfirmed)this.emit('callEvent',{event:'onCallState',requestId:2,args:[5]});
        } else this.emit('callEvent',{event:'onCallState',requestId:2,args:[3]});
      }
      if(op==='videoStats')return {code:0,data:JSON.stringify({codecId:4,videoCall:true,canTransferMedia:!this.badStats,captureThreadRunning:true})};
      if(op==='callInfo')return {code:0,data:JSON.stringify({rtpAddress:config.rtpIP,rtcpAddress:config.rtcpIP,sessionId:'fixture'})};
      if(op==='audioCodecs')return {code:0,data:config.audioConfig};
      if(op==='extendData')return {code:0,data:config.extendData};
      if(this.failEvent && args.event==='SEND_402')return {code:-1};
      return {code:0,id:op==='incomingCall'?2:1};
    }
  }
  const worker=new Worker();
  const signaling={request(command,payload){
    events.push(['signal',command]);
    if(command!==402)return Promise.resolve({});
    const pending=new Promise((a,b)=>{resolve=a;reject=b;});entered(payload);return pending;
  },cancel(command){events.push(['cancel',command]);reject?.(new Error('canceled'));}};
  return {worker,events,sent,session:new IncomingSession(worker,signaling,{allowVideo:true}),
    succeed(){resolve({});},fail(){reject(undefined);}};
}
const ack=callId=>({type:'control',data:{act_type:'voip',act:'answer_ack',data:{callId}}});
for(const scenario of ['success','early-ack','cancel','api-error','native-error']) {
  const f=fixture(),s=f.session;
  try {
    await s.incoming(config,{video:true});
    await assert.rejects(s.startMedia(),/remote ACK/);
    assert.equal((await s.control(ack(789))).handled,false,'ringing is too early to accept ACK');
    const before=f.events.length;
    await assert.rejects(s.answer({callerId:'456'}),/acceptance/);
    assert.equal(f.events.length,before);
    f.worker.failEvent=scenario==='native-error';
    const answering=s.answer({callerId:'9999999999999999999',userAccepted:true});
    const outcome=answering.then(value=>({value}),error=>({error}));
    await assert.rejects(s.answer({callerId:'456',userAccepted:true}),/not available/);
    const payload=await f.sent;
    assert.equal(payload.callerId,'9999999999999999999');assert.equal(payload.callId,789);
    assert.equal(payload.status,0);assert.equal(payload.session,'fixture');
    assert.equal((await s.control(ack(790))).handled,false);
    if(scenario==='early-ack') {
      assert.equal((await s.control(ack('789'))).handled,true);
      assert.equal(s.phase,'sending-answer','remote ACK cannot bypass pending API result');
    }
    if(scenario==='success' || scenario==='early-ack')f.succeed();
    if(scenario==='cancel')await s.stop();
    if(scenario==='api-error')f.fail();
    const result=await outcome;
    if(scenario==='success' || scenario==='early-ack') {
      const expected=scenario==='success'?'awaiting-answer-ack':'answer-acknowledged';
      assert.equal(result.value.phase,expected);assert.equal(result.value.callReady,false);
      assert.equal(s.phase,expected);
      assert.deepEqual(f.events.slice(before).filter(e=>['signal','callEvent'].includes(e[0])),
        [['signal',402],['callEvent','SEND_402'],['callEvent','SEND_402_SUCCESS']]);
      assert.equal((await s.control(ack(789))).duplicate,scenario==='early-ack');
      assert.equal(s.phase,'answer-acknowledged');
      assert.equal((await s.control(ack(789))).duplicate,true);
    } else {
      assert.ok(result.error);assert.equal(s.phase,'idle');
      assert.ok(!f.events.some(e=>e[1]==='SEND_402_SUCCESS'));
      assert.ok(f.events.some(e=>e[0]==='stop'));
    }
    assert.ok(!f.events.some(e=>e[0]==='videoFrame' || e[1]==='CONFIRMED'));
  } finally {await s.dispose();}
  assert.equal(f.worker.listenerCount('callEvent'),0);
}
{
  const f=fixture();let stopping;
  try {
    await f.session.incoming(config,{video:true});
    f.session.on('phase',phase=>{if(phase==='preparing-answer')stopping=f.session.stop();});
    await assert.rejects(f.session.answer({callerId:'456',userAccepted:true}),/canceled/);
    await stopping;
    assert.equal(f.session.phase,'idle');
    assert.ok(!f.events.some(e=>e[0]==='signal' && e[1]===402));
  } finally {await f.session.dispose();}
}
for(const scenario of ['success','native-failure','missing-callback','bad-stats','cancel-start']) {
  const f=fixture(),s=f.session;let release;
  try {
    await s.incoming(config,{video:true});
    const answer=s.answer({callerId:'456',userAccepted:true});
    await f.sent;f.succeed();await answer;
    await assert.rejects(s.startMedia(),/remote ACK/);
    await s.control(ack(789));
    f.worker.failConfirm=scenario==='native-failure';
    f.worker.omitConfirmed=scenario==='missing-callback';
    f.worker.badStats=scenario==='bad-stats';
    if(scenario==='cancel-start')f.worker.holdConfirm=new Promise(r=>{release=r;});
    const startup=s.startMedia(),outcome=startup.then(value=>({value}),error=>({error}));
    await assert.rejects(s.startMedia(),/remote ACK/);
    if(scenario==='cancel-start') {
      const stopping=s.stop();release();await stopping;
    }
    const result=await outcome;
    if(scenario==='success') {
      assert.equal(result.value.phase,'media-started');assert.equal(result.value.callReady,false);
      assert.equal(s.phase,'media-started');
      assert.equal(f.events.filter(e=>e[1]==='CONFIRMED').length,1);
    } else {assert.ok(result.error);assert.equal(s.phase,'idle');}
    assert.ok(!f.events.some(e=>e[0]==='videoFrame'),'session must not choose or open a camera');
  } finally {await s.dispose();}
}
for(const scenario of ['ack','early-ack','timeout','abort','stop-replace']) {
  const f=fixture(),s=f.session,controller=new AbortController();
  try {
    await s.incoming(config,{video:true});
    const answer=s.answer({callerId:'456',userAccepted:true});
    await f.sent;f.succeed();await answer;
    await assert.rejects(s.waitForAnswerAck({timeoutMs:0}),/timeout/);
    await assert.rejects(s.waitForAnswerAck({signal:{}}),/signal/);
    if(scenario==='early-ack')await s.control(ack(789));
    const wait=s.waitForAnswerAck({timeoutMs:30,signal:controller.signal});
    const outcome=wait.then(value=>({value}),error=>({error}));
    if(scenario!=='early-ack')await assert.rejects(s.waitForAnswerAck(),/cannot wait/);
    if(scenario==='ack')await s.control(ack(789));
    if(scenario==='abort')controller.abort();
    if(scenario==='stop-replace') {
      await s.stop();await s.incoming({...config,callId:790},{video:true});
    }
    const result=await outcome;
    if(['ack','early-ack'].includes(scenario)) {
      assert.equal(result.value.phase,'answer-acknowledged');assert.equal(result.value.callReady,false);
      controller.abort();assert.equal(s.phase,'answer-acknowledged','successful wait removes abort listener');
    } else {
      assert.ok(result.error);
      if(scenario==='timeout')assert.equal(result.error.code,'ANSWER_ACK_TIMEOUT');
      assert.equal(s.phase,scenario==='stop-replace'?'ringing':'idle');
    }
    assert.ok(!f.events.some(e=>e[1]==='CONFIRMED'));
  } finally {await s.dispose();}
}
console.log('PASS incoming answer/media coordinator: consent/API/ACK gates, bounded ACK wait, abort/timeout cleanup and replacement isolation, confirmed callback and video readiness, no automatic camera');
