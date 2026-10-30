const assert=require('node:assert/strict');
const {DesktopSignaling}=require('./desktop-signaling');
const {OutgoingSetup}=require('./outgoing-setup');
const data={partner:[{id:'9999999999999999999'}],type:1};
(async()=>{
  for(const mode of ['success','error','cancel','timeout','consumer-error']) {
    const frames=[];let consumed=0;
    const signaling=new DesktopSignaling(msg=>{
      frames.push(msg);
      if(['success','consumer-error'].includes(mode)) queueMicrotask(()=>signaling.receive({type:'recvSignal',command:401,data:{id:789,fromId:123}}));
      if(mode==='error') queueMicrotask(()=>signaling.receive({type:'recvSignalError',command:401,data:{callId:789,errorCode:7}}));
    },{timeoutMs:30});
    const setup=new OutgoingSetup(signaling,{callId:()=>789,onConfig:async(config,ctx)=>{
      consumed++;assert.deepEqual(config,{id:789,fromId:123});assert.equal(ctx.callId,789);
      if(mode==='consumer-error') throw new Error('Invalid native config');
      return {callReady:false};
    }});
    await assert.rejects(setup.start({...data,type:3}),/voice/);
    const active=setup.start(data);
    const result=mode==='success'?active:assert.rejects(active,/failed|canceled|timeout|Invalid/);
    await assert.rejects(setup.start(data),/busy/);
    if(mode==='cancel') await setup.stop();
    await result;
    assert.equal(consumed,['success','consumer-error'].includes(mode)?1:0);
    assert.deepEqual(frames,[{type:'sendSignal',command:401,data:{calleeId:data.partner[0].id,callId:789,codec:'[]',type:1}}]);
    assert.equal(setup.active,null);
    await setup.stop();signaling.close();
  }
  const requests=[];
  const videoSetup=new OutgoingSetup({request:async(cmd,body)=>{requests.push({cmd,body});return {};},cancel(){}},
    {allowVideo:true,callId:()=>789,onConfig:async(_config,ctx)=>{assert.equal(ctx.video,true);assert.equal(ctx.calleeId,data.partner[0].id);return {callReady:false};}});
  await assert.rejects(videoSetup.start({...data,type:2}),/voice/);
  await assert.rejects(videoSetup.start({...data,type:6}),/voice/);
  const mutable={type:3,partner:[{id:data.partner[0].id}]};
  const pending=videoSetup.start(mutable);mutable.type=1;mutable.partner[0].id='111';
  await pending;
  assert.deepEqual(requests,[{cmd:401,body:{calleeId:data.partner[0].id,callId:789,codec:'[]',type:3}}]);
  assert.throws(()=>new OutgoingSetup({}, {onConfig(){},allowVideo:1}),/boolean/);
  for(const mode of ['config-error','native-error','cancel','cancel-during-cleanup','ui-cancel','notification-error']) {
    const failure=new Error('private signaling error'),events=[];let release;
    const signaling={request:async()=>{if(mode==='config-error')throw failure;return {};},cancel(){}};
    const setup=new OutgoingSetup(signaling,{callId:()=>790,
      onPreparing:({signal})=>async()=>{
        events.push('preparation-joined');
        if(mode==='cancel-during-cleanup' && !signal.aborted)setup.abort.abort();
      },
      onConfig:async(_config,{signal})=>{
        if(mode==='ui-cancel') {const error=new Error('Outgoing setup canceled');error.name='AbortError';throw error;}
        if(mode==='cancel') {
          release=()=>{};
          await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
        }
        events.push('worker-joined');throw failure;
      },
      onFailure:async options=>{
        assert.deepEqual(Object.keys(options).sort(),['peerAvatar','peerName','signal','video']);
        assert.equal(options.signal.aborted,false);
        assert.equal(events.at(-1),'preparation-joined');events.push('notified');
        if(mode==='notification-error')throw new Error('UI failed');
      }});
    const pending=assert.rejects(setup.start(data),error=>
      mode.startsWith('cancel') || mode==='ui-cancel' ? error.name==='AbortError' : error===failure);
    if(mode==='cancel') {
      while(!release)await new Promise(resolve=>setImmediate(resolve));
      await setup.stop();
    }
    await pending;
    assert.equal(events.filter(e=>e==='notified').length,mode.startsWith('cancel') || mode==='ui-cancel'?0:1);
    assert.equal(setup.active,null);
  }
  assert.throws(()=>new OutgoingSetup({}, {onConfig(){},onFailure:true}),/failure/);
  console.log('PASS outgoing setup: default voice gate, explicit video type 3, immutable intent, 401 transport, busy/cancel/error/timeout; no false ringing');
})().catch(e=>{console.error(e);process.exitCode=1;});
