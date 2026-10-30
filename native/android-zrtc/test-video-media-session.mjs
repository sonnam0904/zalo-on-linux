import assert from 'node:assert/strict';
import {runVideoMedia} from './video-media-session.mjs';
const waitAbort=signal=>new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
for(const kind of ['local-stop','camera-failure','display-close','display-cancel']) {
  const controller=new AbortController();let ended=0,onClose,onCancel,unsubscribed=false,cancelUnsubscribed=false;
  const sink={render(){},clear(){},onClose(callback){onClose=callback;return ()=>{unsubscribed=true;};},
    onCancel(callback){onCancel=callback;return ()=>{cancelUnsubscribed=true;};}};
  const run=runVideoMedia({}, {device:'/dev/video0',signal:controller.signal,sink},async(_w,{signal})=>{
    if(kind==='camera-failure')throw new Error('camera failed');
    if(kind==='local-stop')controller.abort();
    if(kind==='display-close')onClose();
    if(kind==='display-cancel')onCancel();
    await waitAbort(signal);ended++;
  },async(_w,{signal})=>{await waitAbort(signal);ended++;});
  if(kind==='local-stop'){await run;assert.equal(ended,2);}
  else await assert.rejects(run,kind==='camera-failure'?/camera failed/:kind==='display-cancel'?/canceled from display/:/display closed/);
  assert.ok(unsubscribed);assert.ok(cancelUnsubscribed);assert.ok(ended>=1);
}
console.log('PASS video media lifecycle: camera/display joined, local abort, camera fault, idle display close');
