import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runIncomingDesktop} from './incoming-desktop.mjs';
const params={id:789,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},rtpIP:'127.0.0.1:9000',
  rtcpIP:'127.0.0.1:9001',video:{enable:0},extendData:'{}'};
const message={type:'control',data:{act_type:'voip',act:'request',data:{uidFrom:'456',uidTo:'123',uidN:'9999999999999999999',
  callId:'789',codec:'[{"name":"opus/16000/1","payload":112}]',params:JSON.stringify(params)}}};
for(const scenario of ['accept','ignore','startup-cancel','startup-answer','start-error','missing-identity']) {
  const transport=new EventEmitter(),controller=new AbortController();let starts=0,closes=0,owners=0;const dialogs=[];
  const options={nativeLocalId:scenario==='missing-identity'?undefined:123,clientVersion:0,runtime:'/fixture',
    pcm:{source:'mic',sink:'speaker'},signal:controller.signal};
  const deps={startWorker:async(_runtime,args)=>{
    starts++;assert.equal(args.network,true);assert.equal(args.cpuVideo,false);
    if(scenario==='start-error')throw Error('fixture start failed');
    if(['startup-cancel','startup-answer'].includes(scenario))transport.emit('control',{act_type:'voip',act:scenario==='startup-answer'?'answer':'cancel',data:{callId:'789',uidFrom:'456',status:'0'}});
    return {close:async()=>{closes++;}};
  },dialog:async(kind)=>{dialogs.push(kind);return kind==='active'?'end':scenario!=='ignore';},owner:async(worker,_transport,_message,o)=>{
    owners++;assert.equal(o.callerId,message.data.data.uidN);assert.equal(o.context.nativeLocalId,123);
    const accepted=await o.requestConsent({video:false,signal:o.signal});
    if(accepted)await o.runMedia(worker,{video:false,signal:o.signal});
    assert.equal(o.signal.aborted,accepted);
    return {accepted};
  }};
  if(scenario==='missing-identity')await assert.rejects(runIncomingDesktop(transport,message,options,deps),/identity/);
  else if(scenario==='start-error')await assert.rejects(runIncomingDesktop(transport,message,options,deps),/fixture start failed/);
  else if(['startup-cancel','startup-answer'].includes(scenario))await assert.rejects(runIncomingDesktop(transport,message,options,deps),/canceled/);
  else assert.deepEqual(await runIncomingDesktop(transport,message,options,deps),{accepted:scenario==='accept'});
  assert.equal(transport.listenerCount('control'),0);
  assert.equal(starts,scenario==='missing-identity'?0:1);
  assert.equal(closes,['missing-identity','start-error'].includes(scenario)?0:1);
  assert.equal(owners,['accept','ignore'].includes(scenario)?1:0);
  if(scenario==='accept')assert.deepEqual(dialogs,['consent','active']);
  if(scenario==='start-error')assert.deepEqual(dialogs,['error']);
  if(scenario==='missing-identity')assert.deepEqual(dialogs,['error']);
  if(['startup-cancel','startup-answer'].includes(scenario))assert.deepEqual(dialogs,[]);
}
const videoMessage={...message,data:{...message.data,data:{...message.data.data,params:JSON.stringify({...params,
  video:{enable:1},extendData:JSON.stringify({callType:1,video:{codec:[{name:'h264',payload:97}]}})})}}};
for(const scenario of ['bad-json','oversized','missing-caller','missing-camera','missing-display','disabled-video','already-canceled']) {
  const transport=new EventEmitter(),controller=new AbortController(),dialogs=[];
  const input=JSON.parse(JSON.stringify(videoMessage));
  const options={nativeLocalId:123,clientVersion:0,runtime:'/fixture',videoEnabled:true,
    device:'/dev/video0',sink:{},signal:controller.signal};
  if(scenario==='bad-json')input.data.data.params='{private';
  if(scenario==='oversized')input.data.data.params='x'.repeat(65537);
  if(scenario==='missing-caller')delete input.data.data.uidN;
  if(scenario==='missing-camera')delete options.device;
  if(scenario==='missing-display')delete options.sink;
  if(scenario==='disabled-video')options.videoEnabled=false;
  if(scenario==='already-canceled')controller.abort();
  await assert.rejects(runIncomingDesktop(transport,input,options,{
    startWorker:()=>assert.fail('Invalid/canceled call must not start worker'),
    owner:()=>assert.fail('Invalid/canceled call must not enter owner'),
    dialog:async(kind,details)=>{
      assert.equal(transport.listenerCount('control'),0,'validation listeners removed before notification');
      assert.deepEqual(Object.keys(details).sort(),['signal','video']);
      assert.equal(details.signal,controller.signal);
      dialogs.push(kind);
      throw new Error('Notification unavailable');
    },
  }),error=>!error.message.includes('private') && !error.message.includes('Notification unavailable'));
  assert.deepEqual(dialogs,scenario==='already-canceled'?[]:['error']);
  assert.equal(transport.listenerCount('control'),0);
}
const defer=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve};};
for(const scenario of ['video-error','dialog-error','local-end','parent-abort']) {
  const transport=new EventEmitter(),controller=new AbortController(),ready=defer(),finish=defer();
  const events=[];let started=0;
  const task=async(kind,signal)=>{
    const aborted=defer();
    const onAbort=()=>aborted.resolve();
    signal.addEventListener('abort',onAbort,{once:true});
    if(signal.aborted)onAbort();
    if(++started===2)ready.resolve();
    try {
      await ready.promise;
      if((scenario==='video-error' && kind==='video') || (scenario==='dialog-error' && kind==='dialog'))
        throw Error(scenario);
      if(scenario==='local-end' && kind==='dialog')return 'end';
      await aborted.promise;
      await finish.promise; // joins remain pending after abort is delivered
    } finally {signal.removeEventListener('abort',onAbort);events.push(kind+'-joined');}
  };
  const running=runIncomingDesktop(transport,videoMessage,{nativeLocalId:123,clientVersion:0,runtime:'/fixture',
    videoEnabled:true,device:'/dev/video0',sink:{},pcm:{source:'mic',sink:'speaker'},signal:controller.signal},{
    startWorker:async(_runtime,args)=>{
      assert.equal(args.cpuVideo,true);assert.equal(args.experimentalVideoNetwork,true);
      return {close:async()=>{events.push('closed');}};
    },
    owner:async(worker,_transport,_message,o)=>{
      assert.equal(await o.requestConsent({video:true,signal:o.signal}),true);
      await o.runMedia(worker,{video:true,signal:o.signal});
    },
    dialog:async(kind,{signal})=>{
      if(kind==='consent')return true;
      if(kind==='error'){
        assert.equal(events.at(-1),'closed','error shown only after worker closed');
        events.push('error-shown');return true;
      }
      return task('dialog',signal);
    },
    videoMedia:async(_worker,{signal})=>task('video',signal),
  });
  const outcome=scenario.endsWith('error')?assert.rejects(running,new RegExp(scenario)):running;
  await ready.promise;
  if(scenario==='parent-abort')controller.abort();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(!events.includes('closed'),'worker must remain alive until media tasks join');
  finish.resolve();await outcome;
  assert.equal(events.at(-1),scenario.endsWith('error')?'error-shown':'closed');
  assert.ok(events.includes('video-joined') && events.includes('dialog-joined'));
  assert.equal(transport.listenerCount('control'),0);
}
console.log('PASS desktop incoming driver: identity, GTK hooks, startup cancellation, video/dialog faults, parent/local stop, joined cleanup');
