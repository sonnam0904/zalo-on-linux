import assert from 'node:assert/strict';
import {NativeWorker} from './worker-client.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {readFile} from 'node:fs/promises';
import dgram from 'node:dgram';
import {decodeVideoSnapshot} from './video-snapshot.mjs';
import {prepareIncomingAnswer} from './incoming-answer.mjs';
import {IncomingSession} from './incoming-session.mjs';
const coordinated=process.argv[3]==='--session-loopback';
const loopback=process.argv[3]==='--loopback' || coordinated;
const pcm=process.argv[3]==='--pcm' || loopback;
if(process.argv[3] && !pcm)throw new Error('Unknown incoming video fixture option');
const exec=promisify(execFile),sink=`zrtc_incoming_video_${process.pid}`;
let moduleId,worker,server,session,packets=0;const faults=[],packetTypes=new Map(),readyIds=new Set();
try {
  if(loopback) {
    server=dgram.createSocket('udp4');
    await new Promise((resolve,reject)=>{server.once('error',reject);server.bind(0,'127.0.0.1',resolve);});
    server.on('message',(packet,remote)=>{
      packetTypes.set(packet[0],(packetTypes.get(packet[0]) || 0)+1);


      if(packet.length>=17 && packet[0]===13 && packet[5]>>>6===2 && [97,98].includes(packet[6]&127)) {
        packets++;const incoming=Buffer.concat([Buffer.from([14]),packet.subarray(5)]);
        incoming.writeUInt32BE(456,9);server.send(incoming,remote.port,remote.address);
      }
      // Callee relay initialization uses command 12; caller uses 11.
      if(packet.length===38 && packet[0]===1 && packet.readUInt16LE(18)===12 &&
        packet.readUInt32LE(10)===123 && packet.readUInt32LE(21)===789 &&
        packet.readUInt32LE(25)===456 && packet.readUInt16LE(29)===7 && packet.subarray(31).toString()==='fixture') {
        const reply=Buffer.alloc(35);packet.copy(reply,0,0,21);reply[0]=2;reply.writeUInt32LE(1,29);
        server.send(reply,remote.port,remote.address);
      }
    });
  }
  if(pcm){moduleId=(await exec('pactl',['load-module','module-null-sink',`sink_name=${sink}`,'rate=48000','channels=1'])).stdout.trim();assert.match(moduleId,/^\d+$/);}
  worker=await NativeWorker.start(process.argv[2],{cpuVideo:true,network:loopback,experimentalVideoNetwork:loopback,pcm:pcm?{source:sink+'.monitor',sink}:undefined});
  worker.on('nativeFault',fault=>faults.push(fault));
  worker.on('callEvent',event=>{if(event.event==='onIncomingCall')readyIds.add(event.requestId);});
  assert.equal((await worker.request('configure',{userId:123,partnerId:456,callId:789,session:'fixture',
    settings:'{}',zrtcConfig:'{}',videoCall:true,supportVideoCall:true,...(loopback?{protocol:1,enableChangeZrtp:!coordinated}:{})})).code,0);
  assert.equal((await worker.request('makeCall',{servers:'[]'})).code,0);
  const audio=(await worker.request('audioCodecs')).data;
  const extra=(await worker.request('extendData')).data;
  assert.equal(JSON.parse(extra).callType,1);
  assert.equal((await worker.request('stop')).code,0);
  const sent=[];
  if(coordinated)session=new IncomingSession(worker,{request:async(command,payload)=>{
    assert.ok([407,402].includes(command));assert.equal(payload.callId,789);
    if(command===402){assert.equal(payload.status,0);assert.equal(payload.session,'fixture');}
    sent.push(command);return {};
  },cancel(){}},{allowVideo:true});
  for(let cycle=0;cycle<3;cycle++) {
    const address=loopback?`127.0.0.1:${server.address().port}`:null;
    let reply;
    if(coordinated) {
      const result=await session.incoming({fromId:123,toId:456,callId:789,protocol:1,sessId:'fixture',
        settings:{},zrtc_config:{},rtpIP:address,rtcpIP:address,audioConfig:audio,extendData:extra},{video:true});
      assert.equal(result.phase,'ringing');reply={id:result.requestId,callReady:result.callReady};
    } else {
      reply=await worker.request('incomingCall',{rtpAddress:address || '127.0.0.1:9000',rtcpAddress:address || '127.0.0.1:9001',
        relayServer:'',audioCodec:audio,extendData:extra});
      assert.equal(reply.code,0);assert.equal(reply.initialized,true);assert.equal(reply.offline,!loopback);
    }
    assert.equal(reply.callReady,false);
    if(loopback) {
      for(let i=0;i<200 && !readyIds.has(reply.id);i++)await delay(25);
      assert.ok(readyIds.has(reply.id),'Native incoming relay readiness must precede ringing/answer');
      const info=await worker.request('callInfo');assert.equal(info.code,0);
      const call=JSON.parse(info.data);
      assert.equal(call.rtpAddress,address);assert.equal(call.rtcpAddress,address);
      assert.equal(typeof call.sessionId,'string');
      console.log('Native call-info: selected fixture relay addresses verified; session value not logged');
    }
    const stats=await worker.request('videoStats');assert.equal(stats.code,0);
    const media=JSON.parse(stats.data);assert.equal(media.videoCall,true);assert.equal(media.codecId,4);
    if(!coordinated)assert.equal((await worker.request('callState',{state:'RINGING'})).code,0);
    if(loopback) {
      const answer=await prepareIncomingAnswer(worker,{callerId:'9999999999999999999',callId:789,video:true,current(){}});
      assert.equal(answer.rtpAddress,address);assert.equal(answer.rtcpAddress,address);
      assert.equal(answer.callerId,'9999999999999999999');assert.equal(answer.status,0);
      console.log('Incoming answer prepared from real native data (not sent)');
    }
    const before=(await worker.request('status')).pcmFrames;
    if(coordinated) {
      assert.equal((await session.answer({callerId:'456',userAccepted:true})).phase,'awaiting-answer-ack');
      const acknowledged=session.waitForAnswerAck({timeoutMs:1000});
      await session.control({type:'control',data:{act_type:'voip',act:'answer_ack',data:{callId:789}}});
      assert.equal((await acknowledged).phase,'answer-acknowledged');
      assert.equal((await session.startMedia()).phase,'media-started');
      assert.deepEqual(sent.splice(0),[407,402]);
    } else assert.equal((await worker.request('callState',{state:'CONFIRMED'})).code,pcm?0:-95);
    if(pcm) {
      const pixels=Buffer.alloc(640*480*3/2,128);
      for(let i=0;i<30;i++) {
        assert.equal((await worker.request('videoFrame',{pixels,width:640,height:480,rotation:0,timestampNs:BigInt(i)*33333333n})).code,0);
        await delay(34);
      }
      const running=JSON.parse((await worker.request('videoStats')).data);
      assert.equal(running.canTransferMedia,true);assert.equal(running.captureThreadRunning,true);
      assert.ok(running.encodedFrames-media.encodedFrames>=20);
      const after=(await worker.request('status')).pcmFrames;
      assert.ok(after.recorded-before.recorded>=10);assert.ok(after.played-before.played>=10);
      console.log('Incoming answered CPU video:',{encodedFrames:running.encodedFrames-media.encodedFrames,encodedBytes:running.encodedBytes-media.encodedBytes});
      if(loopback) {
        let decoded=running;
        for(let i=0;i<200 && decoded.decodedFrames-media.decodedFrames<20;i++) {
          await delay(25);decoded=JSON.parse((await worker.request('videoStats')).data);
        }
        assert.ok(decoded.decodedFrames-media.decodedFrames>=20,`Only ${decoded.decodedFrames-media.decodedFrames} inbound frames (${packets} video relay packets; synthetic datagram types ${JSON.stringify([...packetTypes])})`);
        const snapshot=decodeVideoSnapshot(await worker.request('videoSnapshot'));
        assert.equal(snapshot.width,480);assert.equal(snapshot.height,360);
        assert.ok(snapshot.pixels.equals(Buffer.alloc(480*360*3/2,128)));
        console.log('Incoming native relay decode: pixels verified at 480x360');
      }
    }
    if(coordinated)await session.stop();
    else assert.equal((await worker.request('stop')).code,0);
    assert.equal((await worker.request('videoSnapshot')).code,-61);
    assert.equal((await worker.request('callInfo')).code,-107);
    if(pcm) {
      const stopped=(await worker.request('status')).pcmFrames;
      await delay(100);assert.deepEqual((await worker.request('status')).pcmFrames,stopped);
      assert.equal((await readFile(`/proc/${worker.processId}/task/${worker.processId}/children`,'utf8')).trim(),'');
    }
  }
  assert.deepEqual(faults,[]);
} finally {
  try {try {if(session)await session.dispose();}finally {if(worker)assert.deepEqual(await worker.close(),{code:0,signal:null});}}
  finally {if(server)server.close();if(moduleId && /^\d+$/.test(moduleId))await exec('pactl',['unload-module',moduleId]);}
}
console.log(`PASS ${coordinated?'coordinated localhost (mock 407/402/ACK)':loopback?'localhost':'offline'} incoming CPU video: 3 ${pcm?'answered encoding + silent PCM':'ringing'} cycles; no remote account`);
