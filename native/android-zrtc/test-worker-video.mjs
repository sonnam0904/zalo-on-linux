// Assert the real Peer video boundary, including explicit initialization failure.
import assert from 'node:assert/strict';
import {NativeWorker,encodeCommand} from './worker-client.mjs';
assert.throws(()=>encodeCommand(1,'configure',{videoCall:1}),/boolean/);
const worker=await NativeWorker.start(process.argv[2]);
const base={userId:123,partnerId:456,callId:789,session:'fixture',settings:'{}',zrtcConfig:'{}'};
try {
  for(let cycle=0;cycle<3;cycle++) {
    assert.equal((await worker.request('configure',{...base,videoCall:true})).code,0);
    const video=await worker.request('makeCall',{servers:'[]'});
    assert.equal(video.code,-10,'Video must report the original missing-EGL prerequisite');
    assert.equal(video.initialized,false);assert.equal(video.callReady,false);
    assert.equal((await worker.request('stop')).code,0);
    assert.equal((await worker.request('configure',{...base,videoCall:false})).code,0);
    const voice=await worker.request('makeCall',{servers:'[]'});
    assert.equal(voice.code,0);assert.equal(voice.initialized,true);
    assert.equal((await worker.request('stop')).code,0);
  }
} finally {assert.deepEqual(await worker.close(),{code:0,signal:null});}
console.log('PASS Peer video config: original missing-EGL error propagated, 3 voice retries; video not ready');
