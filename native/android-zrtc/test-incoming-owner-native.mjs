import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import dgram from 'node:dgram';
import {NativeWorker} from './worker-client.mjs';
import {runIncomingCall} from './incoming-call-owner.mjs';
import {decodeVideoSnapshot} from './video-snapshot.mjs';
const runtime=process.argv[2];
const tone=process.argv[3]==='--tone';
if(!runtime || process.argv.length>4 || (process.argv[3] && !tone))throw new Error('Usage: test-incoming-owner-native.mjs RUNTIME [--tone]');
const exec=promisify(execFile),sink=`zrtc_owner_${process.pid}`;
const server=dgram.createSocket('udp4');let moduleId,toneModule,worker;
const children=[];
function launch(command,args) {
  const child=spawn(command,args,{stdio:['pipe','pipe','ignore']});
  const closed=new Promise(resolve=>{child.once('error',()=>resolve());child.once('close',()=>resolve());});
  children.push({child,closed});return child;
}
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.bind(0,'127.0.0.1',resolve);});
  server.on('message',(packet,remote)=>{
    if(packet.length===38 && packet[0]===1 && packet.readUInt16LE(18)===12 &&
      packet.readUInt32LE(10)===123 && packet.readUInt32LE(21)===789 &&
      packet.readUInt32LE(25)===456 && packet.readUInt16LE(29)===7 && packet.subarray(31).toString()==='fixture') {
      const reply=Buffer.alloc(35);packet.copy(reply,0,0,21);reply[0]=2;reply.writeUInt32LE(1,29);
      server.send(reply,remote.port,remote.address);
    }
    if(packet.length>=17 && packet[0]===13 && packet[5]>>>6===2 && [97,98].includes(packet[6]&127)) {
      const reply=Buffer.concat([Buffer.from([14]),packet.subarray(5)]);
      reply.writeUInt32BE(456,9);server.send(reply,remote.port,remote.address);
    }
  });
  moduleId=(await exec('pactl',['load-module','module-null-sink',`sink_name=${sink}`,'rate=48000','channels=1'])).stdout.trim();
  assert.match(moduleId,/^\d+$/);
  if(tone) {
    toneModule=(await exec('pactl',['load-module','module-null-sink',`sink_name=${sink}_tone`,'rate=48000','channels=1'])).stdout.trim();
    assert.match(toneModule,/^\d+$/);
    const generator=launch('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-re','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-ac','1','-f','s16le','pipe:1']);
    const player=launch('pacat',['--playback','--raw','--rate=48000','--channels=1','--format=s16le',`--device=${sink}_tone`]);
    player.stdin.on('error',()=>{});generator.stdout.pipe(player.stdin);
  }
  worker=await NativeWorker.start(runtime,{cpuVideo:true,network:true,experimentalVideoNetwork:true,pcm:{source:sink+(tone?'_tone':'')+'.monitor',sink}});
  const faults=[];worker.on('nativeFault',kind=>faults.push(kind));
  assert.equal((await worker.request('configure',{userId:123,partnerId:456,callId:789,session:'fixture',
    settings:'{}',zrtcConfig:'{}',videoCall:true,supportVideoCall:true,protocol:1,enableChangeZrtp:false})).code,0);
  assert.equal((await worker.request('makeCall',{servers:'[]'})).code,0);
  const codec=(await worker.request('audioCodecs')).data,extendData=(await worker.request('extendData')).data;
  assert.equal((await worker.request('stop')).code,0);
  const address=`127.0.0.1:${server.address().port}`;
  const message={type:'control',data:{act_type:'voip',act:'request',data:{uidFrom:'456',uidTo:'123',callId:'789',codec,
    params:JSON.stringify({id:789,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},
      rtpIP:address,rtcpIP:address,video:{enable:1},extendData})}}};
  for(let cycle=0;cycle<3;cycle++) {
    const controller=new AbortController(),transport=new EventEmitter(),sent=[];
    transport.request=async(command,payload)=>{
      assert.ok([407,402,409].includes(command));assert.equal(payload.callId,789);sent.push(command);
      if(command===402)queueMicrotask(()=>transport.emit('control',{act_type:'voip',act:'answer_ack',data:{callId:789}}));
      if(command===409) {
        // Delay the mocked server response. Native capture/playback must
        // already be stopped while the end-call API is still outstanding.
        assert.equal((await worker.request('callInfo')).code,-107);
        assert.equal((await worker.request('videoSnapshot')).code,-61);
        const stopped=(await worker.request('status')).pcmFrames;
        await delay(100);
        assert.deepEqual((await worker.request('status')).pcmFrames,stopped);
      }
      return {};
    };
    transport.cancel=()=>{};
    const result=await runIncomingCall(worker,transport,message,{context:{nativeLocalId:123,video:true},callerId:'456',
      signal:controller.signal,requestConsent:async()=>true,runMedia:async(native,{signal})=>{
        assert.equal((await native.request('microphoneMute',{muted:true})).code,0);
        assert.equal((await native.request('microphoneMute',{muted:false})).code,0);
        if(tone) {
          const waitChange=async(before,field)=>{
            for(let attempt=0;attempt<150;attempt++) {
              const state=(await native.request('status')).captureGate;
              assert.ok(state,'Rebuilt worker with capture diagnostics required');
              if(state[field]>before[field]+10)return state;await delay(20);
            }
            assert.fail('Tone did not reach the native recording gate');
          };
          let gate=(await native.request('status')).captureGate;
          assert.ok(gate,'Rebuilt worker with capture diagnostics required');
          gate=await waitChange(gate,'outputNonzero');
          const muted=await native.request('microphoneMute',{muted:true});
          assert.equal(muted.code,0);assert.equal(muted.captureGate.muted,true);
          const afterMute=await waitChange(muted.captureGate,'inputNonzero');
          assert.ok(afterMute.mutedFrames>muted.captureGate.mutedFrames);
          assert.equal(afterMute.outputNonzero,muted.captureGate.outputNonzero,'No nonzero PCM may enter native recording after mute ACK');
          const unmuted=await native.request('microphoneMute',{muted:false});
          assert.equal(unmuted.code,0);assert.equal(unmuted.captureGate.muted,false);
          await waitChange(unmuted.captureGate,'outputNonzero');
        }
        const before=(await native.request('status')).pcmFrames;
        const baseline=JSON.parse((await native.request('videoStats')).data);
        for(let frame=0;frame<30;frame++) {
          assert.equal(signal.aborted,false);
          assert.equal((await native.request('videoFrame',{pixels:Buffer.alloc(640*480*3/2,128),width:640,height:480,
            rotation:0,timestampNs:BigInt(frame)*33333333n})).code,0);await delay(34);
        }
        let stats;
        for(let attempt=0;attempt<200;attempt++) {
          stats=JSON.parse((await native.request('videoStats')).data);
          if(stats.decodedFrames-baseline.decodedFrames>=20)break;await delay(25);
        }
        assert.ok(stats.encodedFrames-baseline.encodedFrames>=20 && stats.decodedFrames-baseline.decodedFrames>=20);
        const snapshot=decodeVideoSnapshot(await native.request('videoSnapshot'));
        assert.equal(snapshot.width,480);assert.equal(snapshot.height,360);
        assert.ok(snapshot.pixels.equals(Buffer.alloc(480*360*3/2,128)));
        const after=(await native.request('status')).pcmFrames;
        assert.ok(after.recorded>before.recorded && after.played>before.played);
        controller.abort();
      }});
    assert.deepEqual(result,{accepted:true,callReady:false});assert.deepEqual(sent,[407,402,409]);
    assert.equal(transport.listenerCount('control'),0);assert.equal(worker.listenerCount('callEvent'),0);
    assert.equal((await worker.request('callInfo')).code,-107);
    assert.equal((await worker.request('microphoneMute',{muted:true})).code,-107);
    assert.equal((await worker.request('videoSnapshot')).code,-61);
    const stopped=(await worker.request('status')).pcmFrames;
    await delay(100);assert.deepEqual((await worker.request('status')).pcmFrames,stopped);
  }
  assert.deepEqual(faults,[]);
} finally {
  try {if(worker)assert.deepEqual(await worker.close(),{code:0,signal:null});}
  finally {
    server.close();
    await Promise.all(children.map(async({child,closed})=>{
      child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),1000);
      await closed;clearTimeout(timer);
    }));
    if(toneModule && /^\d+$/.test(toneModule))await exec('pactl',['unload-module',toneModule]);
    if(moduleId && /^\d+$/.test(moduleId))await exec('pactl',['unload-module',moduleId]);
  }
}
console.log(tone?'PASS real native mute: 3 tone/mute/unmute cycles at recording gate, synthetic H264, joined cleanup; virtual audio, loopback signaling, no real account':
  'PASS real incoming owner: 3 consent/API/ACK/media/local-end cycles, synthetic H264 pixels and silent PCM; mocked signaling, no real account');
