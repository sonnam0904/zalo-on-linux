// Validate absent/removed devices before opening any physical stream.
import assert from 'node:assert/strict';
import {NativeWorker} from './worker-client.mjs';
import {startDesktopVoice} from './desktop-config.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
const exec=promisify(execFile);
await exec('pactl',['info']);
await assert.rejects(NativeWorker.start(process.argv[2],{pcm:{source:'zrtc_missing_source_fixture',sink:'zrtc_missing_sink_fixture'}}),/unavailable/);
const sink=`zrtc_removed_fixture_${process.pid}`;
let moduleId,worker;
try {
  moduleId=(await exec('pactl',['load-module','module-null-sink',`sink_name=${sink}`])).stdout.trim();
  assert.match(moduleId,/^\d+$/);
  worker=await NativeWorker.start(process.argv[2],{pcm:{source:sink+'.monitor',sink}});
  await exec('pactl',['unload-module',moduleId]);moduleId=null;
  for (let cycle=0;cycle<3;cycle++) {
  await startDesktopVoice(worker,{fromId:123,toId:456,protocol:1,callId:789,sessId:'fixture',settings:{},zrtc_config:{},
    rtpIP:'127.0.0.1:9000',rtcpIP:'127.0.0.1:9001',audioConfig:JSON.stringify([
      {name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}])},{role:'callee',video:false});
  await worker.request('callState',{state:'RINGING'});
  const early=await worker.request('callState',{state:'EARLY'});
  assert.equal(early.code,-19);
  assert.equal(early.initialized,false);
  assert.equal(early.callReady,false);
  assert.deepEqual(early.pcmFrames,{recorded:0,played:0});
  assert.equal((await worker.request('stop')).code,0);
  assert.equal((await readFile(`/proc/${worker.processId}/task/${worker.processId}/children`,'utf8')).trim(),'');
  }
} finally {
  try {if(worker) assert.deepEqual(await worker.close(),{code:0,signal:null});}
  finally {if(moduleId) await exec('pactl',['unload-module',moduleId]);}
}
console.log('PASS device validation: absent device rejected, removed null sink rejects 3 starts, no PCM frames/helpers, clean exit');
