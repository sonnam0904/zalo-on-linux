import assert from 'node:assert/strict';
import {NativeWorker, encodeCommand} from './worker-client.mjs';
const runtime = process.argv[2];
if (!runtime) throw new Error('Usage: test-worker.mjs RUNTIME_DIR');
assert.throws(() => encodeCommand(1, 'makeCall'));
assert.throws(() => encodeCommand(1, 'configure', {session:'a\0b'}));
assert.throws(() => encodeCommand(1, 'configure', {userId:-1}));
assert.throws(() => encodeCommand(1, 'configure', {video:true}));
assert.throws(() => encodeCommand(1, 'configure', {session:'x'.repeat(1024*1024)}));
const worker = await NativeWorker.start(runtime);
let closedEvents=0;
worker.on('workerClosed',(...args)=>{assert.deepEqual(args,[]);closedEvents++;});
try {
  let reply = await worker.request('status');
  assert.equal(reply.initialized, false); assert.equal(reply.callReady, false); assert.equal(reply.offline, true);
  assert.equal((await worker.request('configure')).code, -22);
  assert.equal((await worker.request('microphoneMute',{muted:true})).code,-107);
  reply = await worker.request('configure', {userId:123, partnerId:456, protocol:1, callId:789,
    clientVersion:1, session:'synthetic-session', settings:'{}', zrtcConfig:'{}'});
  assert.equal(reply.code, 0); assert.equal(reply.configured, true);
  for (let cycle = 0; cycle < 5; cycle++) {
    reply = await worker.request('initialize');
    assert.equal(reply.code, 0); assert.equal(reply.initialized, true);
    assert.equal((await worker.request('initialize')).code, -114);
    assert.equal((await worker.request('configure', {userId:123})).code, -16);
    reply = await worker.request('stop');
    assert.equal(reply.code, 0); assert.equal(reply.initialized, false);
  }
  const replies = await Promise.all(Array.from({length:20}, () => worker.request('status')));
  assert.equal(new Set(replies.map(r => r.id)).size, 20);
  assert.ok(replies.every(r => r.code === 0 && r.offline && !r.callReady));
} finally {
  assert.deepEqual(await worker.close(), {code:0, signal:null});
  assert.equal(closedEvents,1,'publish one payload-free process-close event');
}
console.log('PASS persistent native worker: configuration, 5 init/stop cycles, queued replies, shutdown, validation');
