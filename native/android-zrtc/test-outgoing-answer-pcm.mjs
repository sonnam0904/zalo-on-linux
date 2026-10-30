// Real outgoing native codec/media path; isolated silent devices, mocked ACK.
// No remote call and no physical-microphone claim.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import {NativeWorker} from './worker-client.mjs';
import {acceptOutgoingAnswer} from './outgoing-answer.mjs';
import dgram from 'node:dgram';
import {h264RtpToAnnexB} from './h264-rtp-diagnostic.mjs';
import {createHash} from 'node:crypto';
import {runCamera} from './camera-pump.mjs';
import {decodeVideoSnapshot} from './video-snapshot.mjs';
import {runRemoteVideo} from './remote-video-pump.mjs';
import {Socket} from 'node:net';
import videoPipe from './video-pipe.cjs';
const exec=promisify(execFile),sink=`zrtc_answer_test_${process.pid}`;
const motion=process.argv[3]==='--video-motion-loopback';
const camera=process.argv[3]==='--video-camera-loopback';
const receive=process.argv[3]==='--video-receive-loopback';
const loopback=process.argv[3]==='--video-loopback' || motion || camera || receive;
const cpuVideo=process.argv[3]==='--cpu-video' || loopback;
if(process.argv[3] && !cpuVideo)throw new Error('Unknown test option');
if(process.argv[4] && (process.argv[4]!=='--display-pipe' || !receive))throw new Error('Display fixture requires native receive loopback');
const display=process.argv[4]?videoPipe.createVideoPipeSink(new Socket({fd:3,readable:true,writable:true})):null;
let displayController,displayTask,displayError,painted=0;
let moduleId,worker,server;
let datagrams=0,datagramBytes=0;
let videoPackets=0,videoBytes=0;
let cyclePackets=[];
let snapshotSequence=0n,snapshotsDuringCapture=0;
function verifyNativeSnapshot(snapshot) {
  if(!snapshot)return;
  assert.equal(snapshot.width,480);assert.equal(snapshot.height,360);
  assert.ok(snapshot.sequence>=snapshotSequence,'Snapshot sequence must not regress');
  snapshotSequence=snapshot.sequence;
  assert.ok(snapshot.pixels.equals(Buffer.alloc(480*360*3/2,128)),'Native decoder pixels must match the flat fixture');
}
async function decodeReceived(packets) {

  const annexB=h264RtpToAnnexB(packets,{packetization:'zrtc-annexb'});
  const output=await new Promise((resolve,reject)=>{
    const decoder=execFile('ffmpeg',['-hide_banner','-loglevel','error','-f','h264','-i','pipe:0',
      '-fps_mode','passthrough','-f','framemd5','pipe:1'],{timeout:10000,maxBuffer:2*1024*1024},
      (error,stdout,stderr)=>error || stderr.trim()?reject(new Error(`Independent decoder failed: ${stderr.slice(-1500)}`)):resolve(stdout));
    decoder.stdin.on('error',()=>{}); // decoder exit is reported by execFile
    decoder.stdin.end(annexB);
  });
  const frames=output.split('\n').filter(line=>/^0,/.test(line));
  // The native default encoder downscales the 640x480 input to 480x360.
  // This expectation comes from the independently decoded SPS/output, not
  // the capture dimensions. Verify pixels as well as frame counts.
  assert.match(output,/#dimensions 0: 480x360/);
  assert.ok(frames.length>=20,`Only ${frames.length} received video frames decoded`);
  const expected=createHash('md5').update(Buffer.alloc(480*360*3/2,128)).digest('hex');
  const hashes=new Set();
  for(const frame of frames) {
    const fields=frame.split(',').map(field=>field.trim());
    assert.equal(Number(fields[4]),480*360*3/2);
    hashes.add(fields[5]);
    if(!motion && !camera) assert.equal(fields[5],expected,'Received frame must reproduce the neutral synthetic NV21 fixture');
  }
  if(motion) assert.ok(hashes.size>=10,'Motion must produce distinct decoded frames');
  console.log(`Independent FFmpeg decoded ${frames.length} received frames at 480x360; ${motion||camera?hashes.size+' distinct images':'pixels verified'}`);
}
try {
  if(loopback) {
    server=dgram.createSocket('udp4');
    await new Promise((resolve,reject)=>{server.once('error',reject);server.bind(0,'127.0.0.1',resolve);});
    server.on('message',(packet,remote)=>{
      datagrams++;datagramBytes+=packet.length;

      // Original initZRTPPacketVideo: outbound type 13; relay connection ID
      // precedes RTP. Observed H.264 Annex-B uses PT 97 delta / PT 98 keyframe.
      if(packet.length>=17 && packet[0]===13 && packet[5]>>>6===2 && [97,98].includes(packet[6]&127)) {
        videoPackets++;videoBytes+=packet.length-5;
        cyclePackets.push(Buffer.from(packet.subarray(5)));
        if(receive) {
          // Inbound relay type 14 has no connection ID. Use only the local
          // synthetic partner SSRC; never forward this fixture externally.
          const incoming=Buffer.concat([Buffer.from([14]),packet.subarray(5)]);
          incoming.writeUInt32BE(456,9);
          server.send(incoming,remote.port,remote.address);
        }
      }
      // Synthetic relay response: copied request identity, success status,
      // nonzero relay connection ID. Only answer this exact local fixture.
      if(packet.length===38 && packet[0]===1 && packet.readUInt16LE(18)===11 &&
         packet.readUInt32LE(10)===123 && packet.readUInt32LE(21)===789 &&
         packet.readUInt32LE(25)===456 && packet.readUInt16LE(29)===7 &&
         packet.subarray(31).toString()==='fixture') {
        const reply=Buffer.alloc(35);packet.copy(reply,0,0,21);reply[0]=2;
        reply.writeUInt32LE(1,29);
        server.send(reply,remote.port,remote.address);
      }
    });
  }
  moduleId=(await exec('pactl',['load-module','module-null-sink',`sink_name=${sink}`,'rate=48000','channels=1'])).stdout.trim();
  assert.match(moduleId,/^\d+$/);
  worker=await NativeWorker.start(process.argv[2],{pcm:{source:sink+'.monitor',sink},cpuVideo,
    network:loopback,experimentalVideoNetwork:loopback});
  const faults=[];worker.on('nativeFault',kind=>faults.push(kind));
  const config={userId:123,partnerId:456,callId:789,session:'fixture',settings:'{}',zrtcConfig:'{}',videoCall:cpuVideo,supportVideoCall:cpuVideo};
  if(loopback) {config.protocol=1;config.enableChangeZrtp=true;}
  assert.equal((await worker.request('configure',config)).code,0);
  for(let cycle=0;cycle<3;cycle++) {
    cyclePackets=[];
    if(receive)assert.equal(decodeVideoSnapshot(await worker.request('videoSnapshot')),null);

    const before=(await worker.request('status')).pcmFrames;
    const address=loopback?`127.0.0.1:${server.address().port}`:null;
    const servers=loopback?JSON.stringify([{rtpaddr:address,rtcpaddr:address}]):'[]';
    const readiness=[];
    const onReady=event=>{if(event.event==='onInitZrtpWithServer')readiness.push(event);};
    if(loopback)worker.on('callEvent',onReady);
    assert.equal((await worker.request('makeCall',{servers})).code,0);
    if(loopback) {
      try {
        for(let i=0;i<100 && !readiness.length;i++)await delay(25);
        assert.ok(readiness.length,'Synthetic relay did not establish native server readiness');
      } finally {worker.off('callEvent',onReady);}
    }
    const codec=(await worker.request('audioCodecs')).data,phases=[];
    const extendData=cpuVideo?(await worker.request('extendData')).data:'{}';
    const beforeVideo=cpuVideo?JSON.parse((await worker.request('videoStats')).data):null;
    if(cpuVideo) {
      const offer=JSON.parse(extendData);
      assert.equal(offer.callType,1);
      assert.ok(offer.video.codec.some(c=>c.name==='h264' && c.payload===97));
    }
    const control={act_type:'voip',act:'answer',data:{uidFrom:'456',callId:'789',status:'0',
      params:JSON.stringify({codec,extendData})}};
    let acknowledgements=0;
    const signaling={request:async(cmd,data)=>{
      assert.equal(cmd,408);assert.deepEqual(data,{calleeId:'9999999999999999999',callId:789});
      acknowledgements++;
    }};
    const result=await acceptOutgoingAnswer(worker,signaling,control,config,
      {calleeId:'9999999999999999999',onPhase:p=>phases.push(p)});
    assert.equal(result.callReady,false);assert.equal(acknowledgements,1);
    assert.deepEqual(phases,['peer-codec-applied','answer-acknowledged','media-started']);
    if(display) {
      displayController=new AbortController();
      displayTask=runRemoteVideo(worker,{signal:displayController.signal,clear:display.clear,render:async frame=>{
        verifyNativeSnapshot(frame);await display.render(frame);painted++;
      }}).catch(error=>{displayError=error;});
    }
    if(cpuVideo) {
      if(camera) {
        const captured=await runCamera(worker,{device:'/dev/video0',frameLimit:30});
        assert.equal(captured.frames,30);
      } else {
      const pixels=Buffer.alloc(640*480*3/2,128);
      for(let i=0;i<30;i++) {
        if(motion) for(let y=0;y<480;y++)for(let x=0;x<640;x++)
          pixels[y*640+x]=32+(((x+i*9)>>3)^((y+i*5)>>3))%2*180;
        const reply=await worker.request('videoFrame',{
          pixels,width:640,height:480,rotation:0,timestampNs:BigInt(i)*33333333n,
        });
        assert.equal(reply.code,0);assert.equal(reply.videoFramesSubmitted,i+1);
        await delay(34);
        if(receive && i%3===0) {
          const snapshot=decodeVideoSnapshot(await worker.request('videoSnapshot'));
          if(snapshot){verifyNativeSnapshot(snapshot);snapshotsDuringCapture++;}
        }
      }
      }
      const stats=await worker.request('videoStats');assert.equal(stats.code,0);
      const parsed=JSON.parse(stats.data);assert.equal(parsed.codecId,4);
      assert.equal(parsed.videoCall,true,'Answer must not silently downgrade to voice');
      assert.equal(parsed.canTransferMedia,true);assert.equal(parsed.captureThreadRunning,true);
      assert.ok(parsed.encodeInputSamples>=20);
      assert.ok(parsed.encodedFrames-beforeVideo.encodedFrames>=20,'Original Peer must produce encoded output');
      assert.ok(parsed.encodedBytes>beforeVideo.encodedBytes);
      console.log('CPU Peer encode statistics (not remote-delivery proof):',parsed);
      if(receive) {
        let received=parsed;
        for(let attempt=0;attempt<200 && received.decodedFrames-beforeVideo.decodedFrames<20;attempt++) {
          await delay(25);
          received=JSON.parse((await worker.request('videoStats')).data);
        }
        console.log('Native inbound decoder statistics:',received);
        assert.ok(received.decodedFrames-beforeVideo.decodedFrames>=20,'Original native decoder must emit frames');
        assert.equal(received.decodedWidth,480);
        assert.equal(received.decodedHeight,360);
        const snapshot=decodeVideoSnapshot(await worker.request('videoSnapshot'));
        assert.ok(snapshot);verifyNativeSnapshot(snapshot);
        console.log('Native decoded I420 snapshot: 480x360, every pixel verified');
      }
      if(motion || camera) {
        const encoded=parsed.encodedFrames-beforeVideo.encodedFrames;
        const started=performance.now();
        for(let attempt=0;attempt<200 && cyclePackets.filter(p=>p[1]&128).length<encoded;attempt++)await delay(25);
        const completed=cyclePackets.filter(p=>p[1]&128).length;
        assert.equal(completed,encoded,'Drain must deliver all encoded access units before stopping the fixture');
        if(motion)assert.ok(cyclePackets.length>encoded,'Motion fixture must exercise fragmented access units');
        console.log(`${camera?'Camera':'Motion'} transport drain:`,{encoded,completed,packets:cyclePackets.length,drainMs:Math.round(performance.now()-started)});
      }
    } else await delay(1000);
    const state=await worker.request('status');assert.equal(state.offline,!loopback);
    assert.ok(state.pcmFrames.recorded-before.recorded>=10);
    assert.ok(state.pcmFrames.played-before.played>=10);
    if(display) {
      if(cycle===2){console.log('Native-decoded canvas ready for inspection (15 seconds)');await delay(15000);}
      displayController.abort();await displayTask;displayTask=null;
      if(displayError)throw displayError;
    }
    assert.equal((await worker.request('stop')).code,0);
    if(receive)assert.equal(decodeVideoSnapshot(await worker.request('videoSnapshot')),null,'Stop must erase the previous image');
    const stopped=(await worker.request('status')).pcmFrames;
    await delay(150);assert.deepEqual((await worker.request('status')).pcmFrames,stopped);
    if(loopback) await decodeReceived(cyclePackets);
    assert.equal((await readFile(`/proc/${worker.processId}/task/${worker.processId}/children`,'utf8')).trim(),'');
  }
  assert.deepEqual(faults,[]);
  if(receive)assert.ok(snapshotsDuringCapture>=15,'Snapshots must be consumed while decoding is active');
  if(display){assert.ok(painted>=15);console.log(`PASS native encode -> localhost -> native decode -> snapshot pump -> inherited pipe -> Electron painted ACK: ${painted} frames`);}
  if(loopback) {
    assert.ok(datagrams>0);
    assert.ok(videoPackets>=60,'Native relay produced no sufficient H.264 RTP output');
    console.log(`Loopback received ${videoPackets} H.264 RTP packets / ${videoBytes} RTP bytes (${datagrams} total datagrams)`);
  }
  assert.deepEqual(await worker.close(),{code:0,signal:null});worker=null;
  console.log(`PASS outgoing ${cpuVideo?'CPU video + ':''}answer: real JNI codec + PCM in 3 clean cycles; mocked 408, no remote media`);
} finally {
  displayController?.abort();if(displayTask)await displayTask;display?.close();
  try {if(worker) await worker.close();}
    finally {
      if(server)server.close();
      if(moduleId && /^\d+$/.test(moduleId)) await exec('pactl',['unload-module',moduleId]);
    }
}
