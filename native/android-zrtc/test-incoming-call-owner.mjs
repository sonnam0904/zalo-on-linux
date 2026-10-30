import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runIncomingCall} from './incoming-call-owner.mjs';
const extension=JSON.stringify({callType:1,video:{codec:[{name:'h264',payload:97}]}});
const codec='[{"name":"opus/16000/1","payload":112}]';
const params={id:789,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},rtpIP:'127.0.0.1:9000',
  rtcpIP:'127.0.0.1:9001',video:{enable:1},extendData:extension};
const message={type:'control',data:{act_type:'voip',act:'request',data:{uidFrom:'456',uidTo:'123',
  callId:'789',codec,params:JSON.stringify(params)}}};
const ended={act_type:'voip',act:'endcall',data:{uidFrom:'456',callId:'789'}};
const answeredElsewhere={act_type:'voip',act:'answer',data:{uidFrom:'456',callId:'789',status:'0'}};
const defer=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
function fixture() {
  const events=[],signals=[];
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
  }
  const worker=new Worker(),transport=new EventEmitter();
  transport.request=async(command,payload)=>{
    signals.push({command,payload});
    events.push(command);
    if(command===402)queueMicrotask(()=>transport.emit('control',{act_type:'voip',act:'answer_ack',data:{callId:789}}));
    return {};
  };
  transport.cancel=()=>{};
  const options={context:{nativeLocalId:123,video:true},callerId:'456',requestConsent:async()=>false,
    runMedia:async()=>{throw new Error('must not start media');}};
  return {worker,transport,events,signals,options,run:extra=>runIncomingCall(worker,transport,message,{...options,...extra}),
    clean(){for(const event of ['callEvent','nativeFault','workerClosed'])assert.equal(worker.listenerCount(event),0);
      assert.equal(transport.listenerCount('control'),0);}};
}
{
  const f=fixture();
  assert.deepEqual(await f.run(),{accepted:false,callReady:false});
  assert.ok(!f.events.includes(402));
  assert.deepEqual(f.signals.filter(({command})=>command===405),[
    {command:405,payload:{toId:'456',callId:789,callType:1}}
  ]);f.clean();
  await f.run();f.clean(); // ownership is reusable after remote decline
}
{
  const f=fixture();
  await assert.rejects(f.run({signal:{}}),/abort signal/);f.clean();
  await assert.rejects(f.run({ringTimeoutMs:10,requestConsent:()=>new Promise(()=>{})}),/consent timeout/);
  assert.ok(f.events.includes('stop'));assert.ok(!f.events.includes(402));f.clean();
  await f.run();f.clean();
}
{
  const f=fixture(),entered=defer(),late=defer();
  const running=f.run({requestConsent:()=>{entered.resolve();return late.promise;}});
  const rejected=assert.rejects(running,/canceled/);
  await entered.promise;
  await assert.rejects(f.run(),/already owned/);
  f.transport.emit('control',ended);
  await rejected;late.resolve(true);await Promise.resolve();
  assert.ok(!f.events.includes(402));f.clean();
}
for(const terminal of [answeredElsewhere,ended]) {
  const f=fixture(),entered=defer(),late=defer();
  const running=f.run({requestConsent:()=>{entered.resolve();return late.promise;}});
  const canceled=assert.rejects(running,/canceled/);
  await entered.promise;
  // A stale answer for another call or caller must leave this popup intact.
  f.transport.emit('control',{...terminal,data:{...terminal.data,callId:'790'}});
  f.transport.emit('control',{...terminal,data:{...terminal.data,uidFrom:'457'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.events.filter(x=>x==='stop').length,0);
  f.transport.emit('control',terminal);await canceled;
  late.resolve(true);await Promise.resolve();
  assert.ok(!f.events.includes(402));
  assert.ok(!f.events.includes(405),'do not decline a call answered/canceled remotely');
  assert.ok(!f.events.includes(409),'do not echo a remote terminal action');
  f.clean();
}
{
  const f=fixture(),entered=defer(),join=defer(),aborted=defer();
  const running=f.run({requestConsent:async()=>true,runMedia:async(_worker,{signal})=>{
    signal.addEventListener('abort',()=>aborted.resolve(),{once:true});
    entered.resolve();await join.promise;f.events.push('media-joined');
  }});
  await entered.promise;
  const stops=f.events.filter(x=>x==='stop').length;
  f.transport.emit('control',{...ended,data:{...ended.data,uidFrom:'999'}});
  assert.equal(f.events.filter(x=>x==='stop').length,stops);
  f.transport.emit('control',ended);await aborted.promise;
  assert.equal(f.events.filter(x=>x==='stop').length,stops,'do not stop worker while media owns it');
  await assert.rejects(f.run(),/already owned/);
  join.resolve();assert.deepEqual(await running,{accepted:true,callReady:false});
  assert.ok(f.events.lastIndexOf('stop')>f.events.indexOf('media-joined'));f.clean();
  assert.ok(!f.events.includes(409),'do not echo remote hangup');
}
for(const apiFailure of [false,true]) {
  const f=fixture(),controller=new AbortController(),entered=defer();
  const original=f.transport.request;
  f.transport.request=async(command,payload)=>{
    if(command===409){
      assert.deepEqual(payload,{toId:'456',callId:789});
      assert.equal(f.events.at(-1),'stop');
      assert.ok(f.events.lastIndexOf('stop')>f.events.indexOf('media-joined'));
      if(apiFailure){f.events.push(409);throw new Error('end API unavailable');}
    }
    return original(command,payload);
  };
  const running=f.run({signal:controller.signal,requestConsent:async()=>true,runMedia:async(_worker,{signal})=>{
    const stopped=defer();signal.addEventListener('abort',()=>stopped.resolve(),{once:true});
    entered.resolve();await stopped.promise;f.events.push('media-joined');
  }});
  const result=apiFailure?assert.rejects(running,/end API unavailable/):running;
  await entered.promise;controller.abort();await result;
  assert.equal(f.events.filter(x=>x===409).length,1);
  assert.ok(f.events.lastIndexOf('stop')<f.events.indexOf(409));f.clean();
  await f.run();f.clean();
}
{
  const f=fixture();
  await assert.rejects(f.run({onPhase:()=>{throw new Error('UI unavailable');}}),/UI unavailable|canceled/);
  f.clean();await f.run();f.clean();
}
for(const event of ['nativeFault','workerClosed'])for(const during of ['consent','media']) {
  const f=fixture(),entered=defer();
  const options=during==='consent'?{requestConsent:()=>{entered.resolve();return new Promise(()=>{});}}:
    {requestConsent:async()=>true,runMedia:async(_worker,{signal})=>{
      const stopped=defer();signal.addEventListener('abort',()=>stopped.resolve(),{once:true});
      entered.resolve();await stopped.promise;f.events.push('media-joined');
    }};
  const outcome=assert.rejects(f.run(options),error=>error.message==='Incoming native media failed');
  await entered.promise;f.worker.emit(event,'private diagnostics must not escape');await outcome;
  assert.equal(f.events.filter(x=>x===409).length,during==='media'?1:0);
  if(during==='media')assert.ok(f.events.lastIndexOf('stop')>f.events.indexOf('media-joined'));
  f.clean();await f.run();f.clean();
}
{
  const f=fixture(),controller=new AbortController(),entered=defer(),apiPending=defer(),apiReply=defer();
  const original=f.transport.request;
  f.transport.request=async(command,payload)=>{
    if(command===409){f.events.push(command);apiPending.resolve();return apiReply.promise;}
    return original(command,payload);
  };
  let settled=false;
  const running=f.run({signal:controller.signal,requestConsent:async()=>true,runMedia:async(_worker,{signal})=>{
    const aborted=defer();signal.addEventListener('abort',()=>aborted.resolve(),{once:true});
    entered.resolve();await aborted.promise;f.events.push('media-joined');
  }}).finally(()=>{settled=true;});
  await entered.promise;controller.abort();await apiPending.promise;
  assert.equal(settled,false,'server response still pending');
  assert.ok(f.events.lastIndexOf('stop')>f.events.indexOf('media-joined'));
  assert.ok(f.events.lastIndexOf('stop')<f.events.indexOf(409),'PCM stops before slow HTTPS');
  assert.equal(f.worker.listenerCount('callEvent'),0,'native session disposed before server reply');
  await assert.rejects(f.run(),/already owned/);
  apiReply.resolve({});await running;f.clean();await f.run();f.clean();
}
for(const during of ['consent','media']) {
  const f=fixture(),entered=defer();
  const original=f.worker.request.bind(f.worker);
  let broken=false;
  f.worker.request=async(op,args)=>{
    if(broken && op==='stop')throw new Error('worker disconnected during stop');
    return original(op,args);
  };
  const options=during==='consent'?{requestConsent:()=>{entered.resolve();return new Promise(()=>{});}}:
    {requestConsent:async()=>true,runMedia:async(_worker,{signal})=>{
      const stopped=defer();signal.addEventListener('abort',()=>stopped.resolve(),{once:true});
      entered.resolve();await stopped.promise;f.events.push('media-joined');
    }};
  const outcome=assert.rejects(f.run(options),/worker disconnected during stop/);
  await entered.promise;broken=true;f.worker.emit('workerClosed');await outcome;
  f.clean();
  assert.equal(f.events.filter(x=>x===409).length,during==='media'?1:0);
  broken=false;await f.run();f.clean(); // no stale listener or ownership retained
}
console.log('PASS incoming owner: bounded consent, exclusive ownership, remote/local hangup, native fault/exit including failed stop, joined media and listener cleanup');
