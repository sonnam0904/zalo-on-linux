// Explicit camera-device test; frames are discarded immediately, not saved,
// rendered, encoded or transmitted. Native worker acknowledgements are mocked.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createManagedCamera} from './managed-camera.mjs';
if(process.argv.length!==3 || !/^\/dev\/video[0-9]+$/.test(process.argv[2]))throw Error('Usage: node test-managed-camera-device.mjs /dev/videoN');
const controller=new AbortController(),camera=createManagedCamera();
let frames=0,lastTimestamp=-1n,runFailure,previews=0,previewClears=0;
const worker={async request(op,frame){
  assert.equal(op,'videoFrame');assert.equal(frame.pixels.length,640*480*3/2);
  assert.ok(frame.timestampNs>lastTimestamp,'Frame timestamps must increase across resume');
  lastTimestamp=frame.timestampNs;frames++;return {code:0};
}};
const timeout=setTimeout(()=>controller.abort(),15000);
const task=camera.run(worker,{device:process.argv[2],signal:controller.signal,preview:{
  async render(frame){assert.equal(frame.width,160);assert.equal(frame.height,120);previews++;},
  async clear(){previewClears++;}
}}).catch(error=>{runFailure=error;});
try {
  while(!frames && !runFailure && !controller.signal.aborted)await delay(10);
  if(runFailure)throw runFailure;
  assert.ok(frames>0,'Camera must provide frames');
  for(let cycle=0;cycle<3;cycle++) {
    await camera.setEnabled(false);const before=frames;
    assert.equal(previewClears,cycle+1,'Preview must clear before off acknowledgement');
    await delay(200);assert.equal(frames,before,'No frame may reach worker after off acknowledgement');
    await camera.setEnabled(true);assert.ok(frames>before,'On acknowledgement requires a new frame');
  }
  assert.ok(previews>0,'Preview must use captured frames');
  console.log('PASS explicit camera device: 3 joined off/on cycles, no frames while off, monotonic timestamps (mock native ACK; no media saved/sent)');
} finally {controller.abort();await task;clearTimeout(timeout);}
