import assert from 'node:assert/strict';
import {createManagedCamera} from './managed-camera.mjs';
import {activeCallControls} from './native-call-ui.mjs';
import {runVideoMedia} from './video-media-session.mjs';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const abort=signal=>new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
const watchdog=setTimeout(()=>{console.error('FAIL managed camera stalled');process.exit(1);},10000);
try {
  const controller=new AbortController(),camera=createManagedCamera(),runs=[];
  const task=camera.run({}, {device:'/dev/video0',signal:controller.signal},async(_worker,options)=>{
    const run={...options,join:defer(),done:false};runs.push(run);
    await abort(options.signal);await run.join.promise;run.done=true;
  });
  await turn();assert.equal(runs.length,1);
  // Can turn off before the first frame, without killing the whole media run.
  let offAcknowledged=false;
  const off=camera.setEnabled(false).then(()=>offAcknowledged=true);await turn();
  assert.ok(runs[0].signal.aborted);assert.equal(offAcknowledged,false);
  runs[0].join.resolve();await off;assert.ok(runs[0].done);
  let onAcknowledged=false;
  const on=camera.setEnabled(true).then(()=>onAcknowledged=true);await turn();
  assert.equal(runs.length,2);assert.equal(onAcknowledged,false);
  assert.equal(runs[0].timestampOriginNs,runs[1].timestampOriginNs,'Resume cannot reset native video timestamps');
  runs[1].onReady();await on;assert.ok(onAcknowledged);
  controller.abort();runs[1].join.resolve();await task;assert.ok(runs[1].done);
  await assert.rejects(camera.setEnabled(true),/canceled/);
  await assert.rejects(camera.setEnabled(1),/boolean/);
  const failed=createManagedCamera();
  await assert.rejects(failed.run({}, {device:'/dev/video0',signal:new AbortController().signal},async()=>{throw Error('device failed');}),/device failed/);
  const uiAbort=new AbortController(),ack=defer();let requests=0,dialogs=0;
  const ui=activeCallControls({request(){requests++;}}, {video:true,signal:uiAbort.signal,
    cameraControl:{async setEnabled(enabled){assert.equal(enabled,false);await ack.promise;}}},async(_kind,options)=>{
    dialogs++;assert.equal(options.cameraControl,true);
    if(dialogs===1){assert.equal(options.cameraEnabled,true);return 'camera';}
    assert.equal(options.cameraEnabled,false);return 'end';
  });
  await turn();assert.equal(dialogs,1);ack.resolve();await ui;
  assert.equal(dialogs,2);assert.equal(requests,0,'Camera toggle must not stop or mute audio');
  const mediaAbort=new AbortController(),mediaCamera=createManagedCamera();let remoteEnded=false,captures=0;
  const media=runVideoMedia({}, {device:'/dev/video0',signal:mediaAbort.signal,cameraControl:mediaCamera,
    sink:{render(){},clear(){}}},async(_worker,{signal,onReady})=>{captures++;onReady();await abort(signal);},
    async(_worker,{signal})=>{await abort(signal);remoteEnded=true;});
  await turn();await mediaCamera.setEnabled(false);assert.equal(remoteEnded,false);
  await mediaCamera.setEnabled(true);assert.equal(captures,2);assert.equal(remoteEnded,false);
  mediaAbort.abort();await media;assert.equal(remoteEnded,true);
  // A canceled camera can still fail while clearing its preview. Do not turn
  // that cleanup error into a successful "camera off" acknowledgement.
  const cleanupCamera=createManagedCamera(),cleanupAbort=new AbortController();
  const cleanupRun=cleanupCamera.run({}, {device:'/dev/video0',signal:cleanupAbort.signal},
    async(_worker,{signal,onReady})=>{onReady();await abort(signal);throw Error('preview cleanup failed');});
  const failedRun=assert.rejects(cleanupRun,/preview cleanup failed/);
  await turn();await assert.rejects(cleanupCamera.setEnabled(false),/canceled/);
  await failedRun;
  console.log('PASS camera controls: joined off, off before first frame, resume readiness, stable timestamps, faults, acknowledged UI, no audio command');
} finally {clearTimeout(watchdog);}
