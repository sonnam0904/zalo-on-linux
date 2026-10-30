import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {NativeWorker} from './worker-client.mjs';
const runtime=process.argv[2];
await assert.rejects(NativeWorker.start(runtime,{network:'true'}),/boolean/);
const server=dgram.createSocket('udp4');
await new Promise((resolve,reject)=>{server.once('error',reject);server.bind(0,'127.0.0.1',resolve);});
let packets=0,bytes=0;
server.on('message',packet=>{packets++;bytes+=packet.length;});
let worker,primaryError;
try {
  worker=await NativeWorker.start(runtime,{network:true});
  worker.on('nativeFault',kind=>console.error('Native fault category:',kind));
  assert.equal((await worker.request('status')).offline,false);
  const config=await worker.request('configure',{userId:123,partnerId:456,callId:789,protocol:1,
    session:'fixture',settings:'{}',zrtcConfig:'{}',enableChangeZrtp:true});
  assert.equal(config.code,0);
  const address=`127.0.0.1:${server.address().port}`;
  const result=await worker.request('makeCall',{servers:JSON.stringify([{rtpaddr:address,rtcpaddr:address}])});
  assert.equal(result.code,0);assert.equal(result.callReady,false);
  const codecs=await worker.request('audioCodecs'),extra=await worker.request('extendData');
  assert.equal(codecs.code,0);assert.ok(Array.isArray(JSON.parse(codecs.data)));
  assert.equal(extra.code,0);assert.equal(typeof JSON.parse(extra.data),'object');
  // Let the engine's own networking thread attempt the supplied loopback peer.
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal((await worker.request('stop')).code,0);
  assert.ok(packets>0,'Native engine sent no UDP to its configured loopback server');
  console.log(`PASS native network opt-in: ${packets} loopback UDP packets, ${bytes} bytes; no real server, devices, or accepted call`);
} catch(error) {primaryError=error;console.error('Network attempt failed:',error.message);throw error;} finally {
  if(worker) {
    const exit=await worker.close();
    if(!primaryError) assert.deepEqual(exit,{code:0,signal:null});
  }
  server.close();
}
