import assert from 'node:assert/strict';
import {NativeWorker} from './worker-client.mjs';
import {CALL_EVENTS, NETWORK_TYPES} from './protocol-enums.mjs';
assert.equal(CALL_EVENTS.START_INCOMING_CALL,16);
assert.equal(CALL_EVENTS.RECEIVED_402,9);
assert.equal(NETWORK_TYPES.UNKNOWN,0);
const worker = await NativeWorker.start(process.argv[2]);
const events = [];
worker.on('callEvent', message => events.push(message));
try {
  assert.equal((await worker.request('makeCall',{servers:'[]'})).code,-22);
  assert.equal((await worker.request('callEvent',{event:'SEND_401'})).code,-107);
  assert.throws(() => worker.request('callEvent',{event:'ACCEPT'}));
  assert.equal((await worker.request('configure',{userId:123,partnerId:456,protocol:1,
    callId:789,session:'synthetic-session',settings:'{}',zrtcConfig:'{}'})).code,0);
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = events.length;
    const reply = await worker.request('makeCall',{servers:'[]'});
    assert.equal(reply.code,0); // engine accepted the attempt, not a connected call
    assert.equal(reply.callReady,false); assert.equal(reply.offline,true);
    assert.equal(reply.initialized,true);
    const current = events.slice(before);
    assert.ok(current.some(e => e.event === 'onMakeCall' && e.args.length === 0));
    assert.ok(current.some(e => e.event === 'onCallLog' && typeof e.args[0] === 'string'));
    assert.ok(current.every(e => e.requestId === reply.id));
    assert.equal((await worker.request('callEvent',{event:'SEND_401'})).code,0);
    assert.equal((await worker.request('callEvent',{event:'SEND_401_SUCCESS'})).code,0);
    assert.equal((await worker.request('makeCall',{servers:'[]'})).code,-16);
    assert.equal((await worker.request('configure',{userId:123})).code,-16);
    assert.equal((await worker.request('stop')).code,0);
  }
} finally { assert.deepEqual(await worker.close(),{code:0,signal:null}); }
console.log('PASS native makeCall -> JNI callbacks -> worker event IPC: 3 offline attempts, correlation, busy guards, stop/retry');
