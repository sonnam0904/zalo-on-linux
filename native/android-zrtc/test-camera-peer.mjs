// Real camera -> NV21 IPC -> actual Peer-owned VideoCapturer, offline only.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {NativeWorker} from './worker-client.mjs';
const worker=await NativeWorker.start(process.argv[2],{cpuVideo:true});
let capture,exited,timer;
const faults=[];worker.on('nativeFault',value=>faults.push(value));
try {
  assert.equal((await worker.request('configure',{
    userId:123,partnerId:456,callId:789,session:'fixture',settings:'{}',zrtcConfig:'{}',videoCall:true,supportVideoCall:true,
  })).code,0);
  const ready=await worker.request('makeCall',{servers:'[]'});
  assert.equal(ready.code,0);assert.equal(ready.initialized,true);
  capture=spawn('ffmpeg',['-hide_banner','-loglevel','error','-nostdin',
    '-f','v4l2','-input_format','mjpeg','-video_size','640x480','-framerate','30',
    '-i','/dev/video0','-frames:v','30','-pix_fmt','nv21','-f','rawvideo','pipe:1'],
    {stdio:['ignore','pipe','pipe']});
  exited=new Promise((resolve,reject)=>{capture.once('error',reject);capture.once('close',(code,signal)=>resolve({code,signal}));});
  let diagnostic='';capture.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-4096);});
  timer=setTimeout(()=>capture.kill('SIGKILL'),15000);
  let pending=Buffer.alloc(0),frames=0;
  const size=640*480*3/2,origin=process.hrtime.bigint();
  for await(const chunk of capture.stdout) {
    pending=Buffer.concat([pending,chunk]);
    while(pending.length>=size) {
      const pixels=pending.subarray(0,size);pending=pending.subarray(size);
      const result=await worker.request('videoFrame',{
        pixels,width:640,height:480,rotation:0,timestampNs:process.hrtime.bigint()-origin,
      });
      assert.equal(result.code,0);assert.equal(result.videoFramesSubmitted,++frames);
    }
  }
  assert.deepEqual(await exited,{code:0,signal:null},diagnostic);
  assert.equal(frames,30);assert.equal(pending.length,0);assert.deepEqual(faults,[]);
  assert.equal((await worker.request('stop')).code,0);
  console.log('PASS Logitech -> NV21 IPC -> actual Peer capturer: 30 frames; offline, no remote video');
} finally {
  clearTimeout(timer);
  if(capture && capture.exitCode===null && capture.signalCode===null)capture.kill('SIGKILL');
  if(exited)await exited.catch(()=>{});
  assert.deepEqual(await worker.close(),{code:0,signal:null});
}
