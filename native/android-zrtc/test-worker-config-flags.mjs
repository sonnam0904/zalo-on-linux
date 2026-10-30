import assert from 'node:assert/strict';
import {NativeWorker,encodeCommand} from './worker-client.mjs';
import {callerResponse} from './caller-response.mjs';
for(const value of [0,1,2,'true',null])
  assert.throws(()=>encodeCommand(1,'configure',{enableChangeZrtp:value}),/boolean/);
const response={id:789,fromId:123,toId:456,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},
  servers:[],changeZRTP:{enable:1},video:{enable:1}};
assert.throws(()=>callerResponse(response,{callId:789,video:false}),e=>e.code==='CONFIG_DYNAMIC_ZRTP');
const mapped=callerResponse(response,{callId:789,video:false,offlineConfiguration:true});
assert.equal(mapped.configuration.enableChangeZrtp,true);
const worker=await NativeWorker.start(process.argv[2]);
try {
  for(const enabled of [true,false,true,false]) {
    const config={...mapped.configuration,enableChangeZrtp:enabled};
    let result=await worker.request('configure',config);
    assert.equal(result.code,0);assert.equal(result.enableChangeZrtp,enabled);
    result=await worker.request('initialize');
    assert.equal(result.code,0);assert.equal(result.enableChangeZrtp,enabled);
    assert.equal(result.offline,true);assert.equal(result.callReady,false);
    assert.equal((await worker.request('stop')).code,0);
  }
  const reset=await worker.request('configure',{userId:123});
  assert.equal(reset.enableChangeZrtp,false);
} finally {assert.deepEqual(await worker.close(),{code:0,signal:null});}
console.log('PASS native ZRTP config flag: original JNI setter/readback, 4 init/stop cycles, default reset, online adapter remains gated');
