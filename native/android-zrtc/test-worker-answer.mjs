import assert from 'node:assert/strict';
import {NativeWorker,encodeCommand} from './worker-client.mjs';
const answer={audioCodec:JSON.stringify([{name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}]),extendData:'{}'};
assert.throws(()=>encodeCommand(1,'updateCallerInfo',{audioCodec:'[]'}));
assert.throws(()=>encodeCommand(1,'updateCallerInfo',{...answer,extendData:'\0'}));
assert.throws(()=>encodeCommand(1,'updateCallerInfo',{...answer,unknown:true}));
const worker=await NativeWorker.start(process.argv[2]);
try {
  assert.equal((await worker.request('updateCallerInfo',answer)).code,-107);
  assert.equal((await worker.request('configure',{userId:123,partnerId:456,protocol:1,
    callId:789,session:'synthetic-session',settings:'{}',zrtcConfig:'{}'})).code,0);
  for(let cycle=0;cycle<3;cycle++) {
    assert.equal((await worker.request('makeCall',{servers:'[]'})).code,0);
    const result=await worker.request('updateCallerInfo',answer);
    assert.equal(result.code,0);
    assert.equal(result.callReady,false);
    assert.equal(result.offline,true);
    assert.equal((await worker.request('stop')).code,0);
    assert.equal((await worker.request('updateCallerInfo',answer)).code,-107);
  }
} finally {assert.deepEqual(await worker.close(),{code:0,signal:null});}
console.log('PASS original JNI updateCallerInfo: 3 offline answer-codec updates; no media connection claimed');
