import assert from 'node:assert/strict';
import {NativeWorker,encodeCommand} from './worker-client.mjs';
const runtime=process.argv[2];
await assert.rejects(NativeWorker.start(runtime,{cpuVideo:true,network:true}),/offline-only/);
await assert.rejects(NativeWorker.start(runtime,{experimentalVideoNetwork:true}),/requires CPU video and network/);
await assert.rejects(NativeWorker.start(runtime,{cpuVideo:true,experimentalVideoNetwork:'true'}),/boolean/);
const worker=await NativeWorker.start(runtime,{cpuVideo:true});
const faults=[];worker.on('nativeFault',kind=>faults.push(kind));
const frame={pixels:Buffer.alloc(640*480*3/2,128),width:640,height:480,rotation:0,timestampNs:0n};
assert.throws(()=>encodeCommand(1,'videoFrame',{...frame,width:639}),/NV21/);
assert.throws(()=>encodeCommand(1,'videoFrame',{...frame,timestampNs:-1n}),/NV21/);
assert.throws(()=>encodeCommand(1,'configure',{supportVideoCall:1}),/boolean/);
try {
  assert.equal((await worker.request('videoFrame',frame)).code,-107);
  for(let cycle=0;cycle<3;cycle++) {
    assert.equal((await worker.request('configure',{
      userId:123,partnerId:456,callId:789,session:'fixture',settings:'{}',zrtcConfig:'{}',videoCall:true,supportVideoCall:true,
    })).code,0);
    const result=await worker.request('makeCall',{servers:'[]'});
    assert.equal(result.code,0,JSON.stringify(result));
    assert.equal(result.initialized,true);assert.equal(result.callReady,false);
    for(let i=0;i<30;i++) {
      const sent=await worker.request('videoFrame',{...frame,timestampNs:BigInt(i)*33333333n});
      assert.equal(sent.code,0);assert.equal(sent.videoFramesSubmitted,i+1);
      await new Promise(resolve=>setTimeout(resolve,34));
    }
    assert.equal((await worker.request('stop')).code,0);
    assert.equal((await worker.request('videoFrame',frame)).code,-107);
  }
  assert.deepEqual(faults,[]);
} finally {assert.deepEqual(await worker.close(),{code:0,signal:null});}
console.log('PASS original Peer CPU video initialization and teardown: 3 offline cycles; live video not enabled');
