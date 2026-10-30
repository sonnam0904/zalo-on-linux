const assert=require('node:assert/strict');
const {Duplex}=require('node:stream');
const {createVideoPipeSink,attachVideoPipeReceiver}=require('./video-pipe.cjs');
function pair(){
  let a,b;
  const make=other=>new Duplex({read(){},write(chunk,encoding,done){
    // Split every record to exercise transport framing; preserve write ownership.
    const copy=Buffer.from(chunk);other().push(copy.subarray(0,2));other().push(copy.subarray(2));done();
  }});
  a=make(()=>b);b=make(()=>a);return [a,b];
}
(async()=>{
  const [a,b]=pair();let release,entered,clears=0,seen;
  const started=new Promise(r=>entered=r);
  const receiver=attachVideoPipeReceiver(b,{render:async frame=>{
    seen=frame.pixels;assert.deepEqual([...seen],[1,2,3,4,5,6]);entered();await new Promise(r=>release=r);
  },clear:()=>{clears++;}});
  const sink=createVideoPipeSink(a);
  const frame={format:'I420',width:2,height:2,sequence:1n,pixels:Buffer.from([1,2,3,4,5,6])};
  const rendering=sink.render(frame);await started;
  await assert.rejects(sink.render(frame),/already processing/);
  release();await rendering;await sink.clear();assert.equal(clears,1);assert.ok(seen.every(x=>x===0));
  sink.close();receiver.close();await assert.rejects(sink.clear(),/closed/);
  const [c,d]=pair();const stalled=createVideoPipeSink(c,{timeoutMs:20});
  await assert.rejects(stalled.clear(),/closed/);d.destroy();
  console.log('PASS private video pipe: fragmented frame/ACK, renderer backpressure, clear, erasure, timeout, close');
})().catch(error=>{console.error(error);process.exitCode=1;});
