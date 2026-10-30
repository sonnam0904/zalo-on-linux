import assert from 'node:assert/strict';
import {withOutgoingVoiceUI} from './outgoing-voice-ui.mjs';
const wait=signal=>new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
for(const mode of ['local-end','remote-end','mute','dialog-failure']) {
  const events=[],controller=new AbortController();let toggled=false;
  const worker={request:async(op,args)=>{events.push(op);return {code:0};}};
  const run=withOutgoingVoiceUI(worker,{signal:controller.signal},async({signal,onAnswered,beforeCleanup})=>{
    await Promise.resolve();await onAnswered();
    if(mode==='remote-end')controller.abort();
    await wait(signal);await beforeCleanup();events.push('end-api');return 'finished';
  },async(kind,{signal})=>{
    events.push(kind);
    if(kind==='dialing'){await wait(signal);events.push('dialing-joined');return true;}
    if(mode==='dialog-failure')throw Error('fixture UI error');
    if(mode==='remote-end'){await wait(signal);return 'end';}
    if(mode==='mute' && !toggled){toggled=true;return 'toggle';}
    return 'end';
  });
  if(mode==='dialog-failure')await assert.rejects(run,/fixture UI error/);
  else assert.equal(await run,'finished');
  assert.ok(events.indexOf('dialing-joined')<events.indexOf('stop'));
  assert.ok(events.indexOf('stop')<events.indexOf('end-api'));
  assert.equal(events.filter(x=>x==='stop').length,1);
  assert.equal(events.includes('microphoneMute'),mode==='mute');
}
console.log('PASS outgoing voice UI: dialing transition, acknowledged mute, local/remote end, UI failure, stop before server cleanup');
for(const mode of ['local-end','remote-end','camera-failure']) {
  const events=[],controller=new AbortController();let answer,mediaReady,join;
  const answerGate=new Promise(resolve=>{answer=resolve;});
  const mediaGate=new Promise(resolve=>{mediaReady=resolve;});
  const joinGate=new Promise(resolve=>{join=resolve;});
  const worker={request:async op=>{events.push(op);return {code:0};}};
  const running=withOutgoingVoiceUI(worker,{signal:controller.signal,video:true,runMedia:async(_worker,{signal})=>{
    events.push('camera-start');mediaReady();
    if(mode==='camera-failure')throw Error('fixture camera failure');
    await wait(signal);await joinGate;events.push('camera-joined');
  }},async({signal,onAnswered,beforeCleanup})=>{
    await answerGate;await onAnswered();await wait(signal);await beforeCleanup();events.push('server-end');
  },async(kind,{signal,video})=>{
    assert.equal(video,true);events.push(kind);
    if(kind==='dialing'){await wait(signal);return true;}
    if(mode==='local-end'){await mediaGate;return 'end';}
    await wait(signal);return 'end';
  });
  const outcome=mode==='camera-failure'?assert.rejects(running,/fixture camera failure/):running;
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events,['dialing'],'no camera before answer');
  answer();await mediaGate;
  if(mode==='remote-end')controller.abort();
  if(mode!=='camera-failure') {
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(!events.includes('stop'),'join camera before native stop');join();
  }
  await outcome;
  assert.ok(events.indexOf('stop')<events.indexOf('server-end'));
  if(mode!=='camera-failure')assert.ok(events.indexOf('camera-joined')<events.indexOf('stop'));
}
console.log('PASS outgoing video UI: dialing without capture, active controls, joined camera on local/remote end, camera failure');
