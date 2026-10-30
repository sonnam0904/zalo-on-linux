import assert from 'node:assert/strict';
import {runRemoteVideo} from './remote-video-pump.mjs';
import {i420ToRgba} from './i420-rgba.mjs';
const frame=(sequence='1')=>({code:0,data:JSON.stringify({format:'I420',width:2,height:2,sequence,pixels:Buffer.alloc(6,128).toString('base64')})});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
for(const [y,uv,expected] of [[16,[128,128],[0,0,0,255]],[235,[128,128],[255,255,255,255]],
  [81,[90,240],[255,0,0,255]],[145,[54,34],[0,255,1,255]],[41,[240,110],[0,0,255,255]]]) {
  const rgba=i420ToRgba(Uint8Array.from([y,y,y,y,...uv]),2,2);
  for(let i=0;i<4;i++)assert.deepEqual([...rgba.slice(i*4,i*4+4)],expected);
}
assert.throws(()=>i420ToRgba(new Uint8Array(6),3,2));
{
  const controller=new AbortController(),entered=deferred(),release=deferred();
  let requests=0,clears=0,retained;
  const worker={request:async()=>{requests++;return frame();}};
  const run=runRemoteVideo(worker,{signal:controller.signal,clear:()=>{clears++;},render:async f=>{
    retained=f.pixels;entered.resolve();await release.promise;
  }});
  await entered.promise;
  await assert.rejects(runRemoteVideo(worker,{signal:controller.signal,render:()=>{},clear:()=>{}}),/already active/);
  controller.abort();assert.equal(clears,0);assert.equal(requests,1);
  release.resolve();await run;assert.equal(clears,1);assert.ok(retained.every(x=>x===0));
}
{
  const controller=new AbortController(),pending=deferred();let renders=0,clears=0;
  const run=runRemoteVideo({request:()=>pending.promise},{signal:controller.signal,render:()=>{renders++;},clear:()=>{clears++;}});
  controller.abort();pending.resolve(frame());await run;
  assert.equal(renders,0);assert.equal(clears,1);
}
{
  const controller=new AbortController();let requests=0,renders=0,clears=0;
  await runRemoteVideo({request:async()=>{
    requests++;if(requests===4){controller.abort();return frame('2');}
    return requests===3?{code:-61}:frame();
  }},{signal:controller.signal,fps:60,render:()=>{renders++;},clear:()=>{clears++;}});
  assert.equal(renders,1);assert.equal(clears,2); // disappearance + final teardown
}
{
  const worker={request:async()=>frame()},controller=new AbortController();let clears=0;
  await assert.rejects(runRemoteVideo(worker,{signal:controller.signal,render:()=>{throw Error('render failure');},clear:()=>{clears++;}}),/render failure/);
  assert.equal(clears,1);
  controller.abort();await runRemoteVideo(worker,{signal:controller.signal,render:()=>{},clear:()=>{}});
}
console.log('PASS remote video pump: backpressure, joined abort, no late render, duplicate suppression, clear/failure; I420 color vectors');
