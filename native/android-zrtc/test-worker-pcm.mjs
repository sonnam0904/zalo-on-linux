// Native call-state progression using a private Pulse null sink, never a mic.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeWorker} from './worker-client.mjs';
import {readFile} from 'node:fs/promises';
const exec = promisify(execFile);
const sink = `zrtc_worker_test_${process.pid}`;
let moduleId, worker;
try {
  moduleId = (await exec('pactl',['load-module','module-null-sink',`sink_name=${sink}`,'rate=48000','channels=1'])).stdout.trim();
  assert.match(moduleId,/^\d+$/);
  worker = await NativeWorker.start(process.argv[2],{pcm:{source:sink+'.monitor',sink}});
  worker.on('nativeFault',kind=>console.error('Native fault:',kind));

  await worker.request('configure',{userId:123,partnerId:456,session:'fixture',settings:'{}',zrtcConfig:'{}'});
  for (let cycle=0;cycle<3;cycle++) {
    const before = (await worker.request('status')).pcmFrames;
    assert.equal((await worker.request('incomingCall',{
      rtpAddress:'127.0.0.1:9000',rtcpAddress:'127.0.0.1:9001',relayServer:'',
      audioCodec:JSON.stringify([{name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}]),extendData:'',
    })).code,0);
    for (const state of ['RINGING','EARLY','CONFIRMED'])
      assert.equal((await worker.request('callState',{state})).code,0);
    await delay(1000);
    const after = await worker.request('status');
    console.log('PCM cycle',cycle,after.pcmFrames);
    assert.equal(after.offline,true); assert.equal(after.callReady,false);
    assert.ok(after.pcmFrames.recorded-before.recorded>=10);
    assert.ok(after.pcmFrames.played-before.played>=10);
    assert.equal((await worker.request('stop')).code,0);
    const stopped = (await worker.request('status')).pcmFrames;
    await delay(150);
    assert.deepEqual((await worker.request('status')).pcmFrames,stopped);
    assert.equal((await readFile(`/proc/${worker.processId}/task/${worker.processId}/children`,'utf8')).trim(),'');
  }

  assert.deepEqual(await worker.close(),{code:0,signal:null}); worker=null;
  console.log('PASS worker native call-state PCM: 3 start/stop cycles; no network call');
} finally {
  try { if(worker) await worker.close(); }
  finally { if(moduleId && /^\d+$/.test(moduleId)) await exec('pactl',['unload-module',moduleId]); }
}
