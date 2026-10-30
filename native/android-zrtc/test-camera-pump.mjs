import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {runCamera} from './camera-pump.mjs';
const bytes=640*480*3/2;
let child,spawns=0,kills=[];
function capture(chunks,{stall=false,code=0,executable='ffmpeg'}={}) {
  return (command,args,options)=>{
    spawns++;assert.equal(command,executable);assert.equal(args[args.indexOf('-i')+1],'/dev/video0');
    assert.equal(args[args.indexOf('-pix_fmt')+1],'nv21');
    assert.equal(options.stdio[0],'ignore');
    child=new EventEmitter();child.exitCode=null;child.signalCode=null;
    child.stdout=stall?new Readable({read(){}}):Readable.from(chunks);
    child.stderr=Readable.from([]);
    let ended=false;
    const end=(exit,signal)=>{if(ended)return;ended=true;child.exitCode=exit;child.signalCode=signal;child.emit('close',exit,signal);};
    child.stdout.once('end',()=>end(code,null));
    child.kill=signal=>{kills.push(signal);child.stdout.destroy();end(null,signal);return true;};
    return child;
  };
}
let pending=0,maximum=0,received=[];
const worker={request:async(op,frame)=>{
  assert.equal(op,'videoFrame');assert.equal(frame.pixels.length,bytes);
  pending++;maximum=Math.max(maximum,pending);await delay(1);pending--;
  received.push(frame.timestampNs);return {code:0};
}};
assert.deepEqual(await runCamera(worker,{device:'/dev/video0',frameLimit:2},capture([
  Buffer.alloc(17),Buffer.alloc(bytes-17),Buffer.alloc(bytes)
])),{frames:2,width:640,height:480});
assert.equal(maximum,1);assert.ok(received[1]>received[0]);
const inheritedFfmpeg=process.env.ZALO_FFMPEG;
try {
  process.env.ZALO_FFMPEG='/opt/zalo-package/tools/ffmpeg';
  assert.equal((await runCamera(worker,{device:'/dev/video0',frameLimit:1},
    capture([Buffer.alloc(bytes)],{executable:process.env.ZALO_FFMPEG}))).frames,1);
} finally {
  if(inheritedFfmpeg===undefined)delete process.env.ZALO_FFMPEG;else process.env.ZALO_FFMPEG=inheritedFfmpeg;
}
await assert.rejects(runCamera(worker,{device:'/dev/video0',frameLimit:1},capture([Buffer.alloc(13)])),/partial/);
await assert.rejects(runCamera(worker,{device:'/dev/video0',frameLimit:2},capture([Buffer.alloc(bytes)])),/before frame limit/);
await assert.rejects(runCamera(worker,{device:'/dev/video0',frameLimit:1},capture([],{code:1})),/failed or disconnected/);
const before=spawns;
for(const options of [{device:'https://camera',frameLimit:1},{device:'/dev/video0',frameLimit:0},{device:'/dev/video0'}])
  await assert.rejects(runCamera(worker,options,capture([])));
const canceled=new AbortController();canceled.abort();
await assert.rejects(runCamera(worker,{device:'/dev/video0',signal:canceled.signal},capture([])),{name:'AbortError'});
assert.equal(spawns,before);
const controller=new AbortController();
const active=runCamera(worker,{device:'/dev/video0',signal:controller.signal},capture([],{stall:true}));
await assert.rejects(runCamera(worker,{device:'/dev/video0',frameLimit:1},capture([])),/already active/);
controller.abort();await assert.rejects(active,{name:'AbortError'});
assert.ok(kills.includes('SIGTERM'));
await assert.rejects(runCamera(worker,{device:'/dev/video0',frameLimit:1,stallMs:100},capture([],{stall:true})),/stalled/);
await assert.rejects(runCamera({request:async()=>({code:-1})},{device:'/dev/video0',frameLimit:1},capture([Buffer.alloc(bytes)])),/rejected camera/);
assert.equal((await runCamera(worker,{device:'/dev/video0',frameLimit:1},capture([Buffer.alloc(bytes)]))).frames,1);
let previewPixels,cleared=false;
await runCamera(worker,{device:'/dev/video0',frameLimit:1,preview:{
  async render(frame){assert.equal(frame.width,160);assert.equal(frame.height,120);previewPixels=frame.pixels;assert.ok(previewPixels.some(v=>v!==0));},
  async clear(){cleared=true;}
}},capture([Buffer.alloc(bytes,128)]));
assert.ok(cleared);assert.ok(previewPixels.every(v=>v===0),'Temporary preview pixels must be erased after render ACK');
let release,entered;
const requested=new Promise(resolve=>{entered=resolve;});
const heldWorker={request:()=>{entered();return new Promise(resolve=>{release=()=>resolve({code:0});});}};
const inFlightAbort=new AbortController();
const inFlight=runCamera(heldWorker,{device:'/dev/video0',signal:inFlightAbort.signal},capture([Buffer.alloc(bytes)]));
await requested;
inFlightAbort.abort();
await assert.rejects(runCamera(heldWorker,{device:'/dev/video0',frameLimit:1},capture([])),/already active/);
release();await assert.rejects(inFlight,{name:'AbortError'});
await assert.rejects(runCamera(worker,{device:'/dev/video0',frameLimit:1},()=>{throw new Error('spawn failed');}),/spawn failed/);
assert.equal((await runCamera(worker,{device:'/dev/video0',frameLimit:1},capture([Buffer.alloc(bytes)]))).frames,1);
console.log('PASS camera pump: complete-frame framing, backpressure, validation, cancellation, exclusive ownership, stall, disconnect and worker rejection cleanup');
