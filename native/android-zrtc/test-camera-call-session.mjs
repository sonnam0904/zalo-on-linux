import assert from 'node:assert/strict';
import {withCameraSession} from './camera-call-session.mjs';
let starts=0,stops=0;
const worker={};
const pump=async(actual,{device,signal})=>{
  assert.equal(actual,worker);assert.equal(device,'/dev/video0');starts++;
  if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  // Simulate teardown that must finish before the owner can close the worker.
  await Promise.resolve();stops++;
};
const options={device:'/dev/video0'};
assert.equal(await withCameraSession(worker,options,async()=> 'no-answer',pump),'no-answer');
assert.equal(starts,0);
await withCameraSession(worker,options,async({onMediaStarted})=>{
  assert.equal(starts,0);onMediaStarted();await Promise.resolve();assert.equal(starts,1);
  assert.throws(onMediaStarted,/already started/);return 'remote-ended';
},pump);
assert.equal(stops,1);
await assert.rejects(withCameraSession(worker,options,async({onMediaStarted})=>{onMediaStarted();throw new Error('Remote failure');},pump),/Remote failure/);
assert.equal(stops,2);
const abort=new AbortController();
const result=withCameraSession(worker,{...options,signal:abort.signal},async({signal,onMediaStarted})=>{
  onMediaStarted();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
},pump);
abort.abort();await result;assert.equal(stops,3);
await assert.rejects(withCameraSession(worker,{...options,signal:abort.signal},async()=>{},pump),/canceled/);
await assert.rejects(withCameraSession(worker,options,async({signal,onMediaStarted})=>{
  onMediaStarted();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  throw new Error('Invitation canceled');
},async()=>{throw new Error('Camera unplugged');}),/Camera unplugged/);
await assert.rejects(withCameraSession(worker,options,async({signal,onMediaStarted})=>{
  onMediaStarted();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
},async()=>{}),/Camera ended/);
console.log('PASS camera call lifetime: no pre-answer capture, single start, remote/local/fault cleanup and joined teardown');
