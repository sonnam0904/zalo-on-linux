// Linux V4L2 -> FFmpeg NV21 (VU) -> one outstanding native frame request.
// The caller owns the worker and must await this pump before stopping it.
import {spawn} from 'node:child_process';
import {previewFrame} from './local-preview.mjs';
const owners=new WeakSet();
const width=640,height=480,frameBytes=width*height*3/2;
function aborted() {const error=new Error('Camera capture canceled');error.name='AbortError';return error;}
export async function runCamera(worker,{device,frameLimit,signal,stallMs=10000,onReady=()=>{},timestampOriginNs=process.hrtime.bigint(),preview}={},spawnCapture=spawn) {
  if(!worker || typeof worker.request!=='function')throw new TypeError('Native worker required');
  if(typeof device!=='string' || !/^\/dev\/video[0-9]+$/.test(device))throw new TypeError('Explicit V4L2 device required');
  if(frameLimit!==undefined && (!Number.isInteger(frameLimit) || frameLimit<1 || frameLimit>18000))
    throw new TypeError('Invalid camera frame limit');
  if(signal!==undefined && !(signal instanceof AbortSignal))throw new TypeError('Invalid camera cancellation signal');
  if(frameLimit===undefined && !signal)throw new TypeError('Continuous capture requires cancellation');
  if(!Number.isInteger(stallMs) || stallMs<100 || stallMs>30000)throw new TypeError('Invalid camera stall timeout');
  if(typeof onReady!=='function')throw new TypeError('Invalid camera readiness callback');
  if(preview && (typeof preview.render!=='function' || typeof preview.clear!=='function'))throw new TypeError('Invalid preview sink');
  if(typeof timestampOriginNs!=='bigint' || timestampOriginNs<0n || timestampOriginNs>process.hrtime.bigint())throw new TypeError('Invalid camera timestamp origin');
  if(signal?.aborted)throw aborted();
  if(owners.has(worker))throw new Error('Camera pump already active for worker');
  owners.add(worker);
  let child,closed,watchdog,killTimer,stopping=false,failure,frames=0;
  const stop=()=>{
    if(!child || stopping)return;
    stopping=true;
    if(child.exitCode===null && child.signalCode===null) {
      child.kill('SIGTERM');
      killTimer=setTimeout(()=>{if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');},2000);
    }
  };
  const arm=()=>{clearTimeout(watchdog);watchdog=setTimeout(()=>{failure=new Error('Camera stalled');stop();},stallMs);};
  try {
    const args=['-hide_banner','-loglevel','error','-nostdin','-f','v4l2','-input_format','mjpeg',
      '-video_size',`${width}x${height}`,'-framerate','30','-i',device];
    if(frameLimit!==undefined)args.push('-frames:v',String(frameLimit));
    // ZRTC's Android OnByteBufferFrameCaptured path consumes NV21, not NV12.
    // Feeding UV here swaps chroma and produces the blue/red cast seen by peers.
    args.push('-pix_fmt','nv21','-f','rawvideo','pipe:1');
    child=spawnCapture(process.env.ZALO_FFMPEG || 'ffmpeg',args,{stdio:['ignore','pipe','pipe']});
    closed=new Promise(resolve=>{
      child.once('error',()=>{failure=new Error('Unable to start camera capture');resolve({code:null,signal:null});});
      child.once('close',(code,signal)=>{clearTimeout(killTimer);resolve({code,signal});});
    });
    // Drain diagnostics without retaining media, device serials or stderr text.
    child.stderr.resume();
    signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted)stop();
    arm();
    let pending=Buffer.alloc(0);
    const origin=timestampOriginNs;
    for await(const chunk of child.stdout) {
      if(signal?.aborted || failure)break;
      pending=Buffer.concat([pending,chunk]);
      while(pending.length>=frameBytes) {
        if(signal?.aborted || failure)break;
        if(frameLimit!==undefined && frames>=frameLimit)throw new Error('Camera exceeded frame limit');
        const pixels=pending.subarray(0,frameBytes);pending=pending.subarray(frameBytes);
        const result=await worker.request('videoFrame',{pixels,width,height,rotation:0,timestampNs:process.hrtime.bigint()-origin});
        if(result.code!==0)throw new Error('Native worker rejected camera frame');
        if(preview && !signal?.aborted) {
          const frame=previewFrame(pixels,width,height,process.hrtime.bigint()-origin+1n);
          try {await preview.render(frame);}finally {frame.pixels.fill(0);}
        }
        frames++;if(frames===1 && !signal?.aborted)onReady();arm();
      }
    }
    const exit=await closed;
    if(signal?.aborted)throw aborted();
    if(failure)throw failure;
    if(exit.code!==0 || exit.signal)throw new Error('Camera capture failed or disconnected');
    if(pending.length)throw new Error('Camera ended with a partial NV21 frame');
    if(frameLimit!==undefined && frames!==frameLimit)throw new Error('Camera ended before frame limit');
    if(frameLimit===undefined)throw new Error('Camera capture ended unexpectedly');
    return {frames,width,height};
  } catch(error) {
    // Killing FFmpeg may close stdout before its async iterator reaches EOF.
    // Preserve the owner's cancellation/stall reason instead of stream noise.
    if(signal?.aborted)throw aborted();
    if(failure)throw failure;
    throw error;
  } finally {
    clearTimeout(watchdog);signal?.removeEventListener('abort',stop);
    stop();if(closed)await closed;
    clearTimeout(killTimer);
    try {if(preview)await preview.clear();}finally {owners.delete(worker);}
  }
}
