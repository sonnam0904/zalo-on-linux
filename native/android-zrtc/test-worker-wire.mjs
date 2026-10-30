// Exercise framing at the native boundary, bypassing JS-side validation.
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import {encodeCommand, NativeWorker} from './worker-client.mjs';
const root = path.resolve(process.argv[2]);
// Verify the same pinned runtime first.
const preflight = await NativeWorker.start(root);
assert.deepEqual(await preflight.close(), {code:0,signal:null});
async function run(input, expectedExit) {
  const env = {...process.env, LD_LIBRARY_PATH:[`${root}/results/platform`,`${root}/apk/lib/x86_64`,`${root}/bionic`].join(':')};
  delete env.LD_PRELOAD; delete env.LD_AUDIT;
  const child = spawn(`${root}/bionic/linker64`, [`${root}/results/zrtc-worker`,`${root}/apk/lib/x86_64/libzrtc.so`],
    {env, stdio:['pipe','ignore','ignore','pipe']});
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  let output = '';
  child.stdio[3].setEncoding('utf8'); child.stdio[3].on('data', chunk => output += chunk);
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve,reject) => {
    child.once('error', reject); child.once('close', (code,signal) => resolve({code,signal}));
  });
  for (const chunk of input) child.stdin.write(chunk);
  child.stdin.end();
  try { assert.deepEqual(await exited, {code:expectedExit,signal:null}); }
  finally { clearTimeout(timer); }
  return output.trim().split('\n').map(line => JSON.parse(line)).filter(m => m.type === 'response');
}
const init = encodeCommand(1,'initialize'), stop = encodeCommand(2,'stop');
let replies = await run([...init].map(byte => Buffer.from([byte])).concat([stop]), 0);
assert.deepEqual(replies.map(r => [r.id,r.code,r.initialized]), [[1,0,true],[2,0,false]]);
await run([Buffer.from([8,0])], 2); // truncated header
await run([Buffer.from([255,255,255,255])], 2); // oversized frame
await run([init.subarray(0,init.length-1)], 2); // truncated body
const unknown = encodeCommand(3,'status'); unknown.writeUInt32LE(999,8);
assert.equal((await run([unknown],0))[0].code, -95);
const snapshot=encodeCommand(16,'videoSnapshot');
assert.equal((await run([snapshot],0))[0].code,-95); // voice-only worker
const extraSnapshot=Buffer.concat([snapshot,Buffer.from([1])]);
extraSnapshot.writeUInt32LE(extraSnapshot.length-4,0);
assert.equal((await run([extraSnapshot],0))[0].code,-22);
const info=encodeCommand(17,'callInfo');
assert.equal((await run([info],0))[0].code,-107);
const extraInfo=Buffer.concat([info,Buffer.from([1])]);extraInfo.writeUInt32LE(extraInfo.length-4,0);
assert.equal((await run([extraInfo],0))[0].code,-22);
const bad = encodeCommand(4,'configure',{userId:123}); bad.writeUInt32LE(99,12);
replies = await run([bad,encodeCommand(5,'status')],0);
assert.equal(replies[0].code,-22); assert.equal(replies[1].configured,false);
const duplicate = encodeCommand(6,'configure',{userId:123,partnerId:456}); duplicate.writeUInt32LE(0,24);
assert.equal((await run([duplicate],0))[0].code,-22);
const socketState = encodeCommand(7,'callState',{state:'RINGING'});
socketState.writeUInt32LE(402,12);
assert.equal((await run([socketState],0))[0].code,-22);
const invalidBool=encodeCommand(8,'configure',{enableChangeZrtp:true});
invalidBool.writeUInt32LE(2,20);
replies=await run([invalidBool,encodeCommand(9,'status')],0);
assert.equal(replies[0].code,-22);assert.equal(replies[1].configured,false);
const configure=encodeCommand(10,'configure',{userId:123,partnerId:456,callId:789,session:'fixture',settings:'{}',zrtcConfig:'{}'});
const make=encodeCommand(11,'makeCall',{servers:'[]'});
const codec={audioCodec:'[]',extendData:'{}'};
const badAnswer=encodeCommand(12,'updateCallerInfo',codec);
badAnswer.writeUInt32LE(0xffffffff,12);
const nulAnswer=encodeCommand(13,'updateCallerInfo',codec);
nulAnswer[16]=0;
const extraAnswer=Buffer.concat([encodeCommand(14,'updateCallerInfo',codec),Buffer.from([1])]);
extraAnswer.writeUInt32LE(extraAnswer.length-4,0);
replies=await run([configure,make,badAnswer,nulAnswer,extraAnswer,encodeCommand(15,'stop')],0);
assert.deepEqual(replies.map(r=>r.code),[0,0,-22,-22,-22,0]);
console.log('PASS native wire: fragmented/coalesced commands, EOF cleanup, truncation, size bounds, unknown opcode/field, duplicate field, invalid caller-info frames');
