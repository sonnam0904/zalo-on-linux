// Tie camera ownership to an answered outgoing call; no camera during ringing.
import {runCamera} from './camera-pump.mjs';
export async function withCameraSession(worker,{device,signal,onPhase=()=>{}},runCall,pump=runCamera) {
  if(typeof device!=='string' || !/^\/dev\/video[0-9]+$/.test(device))throw new TypeError('Explicit camera device required');
  if(signal?.aborted)throw new Error('Video call canceled');
  const controller=new AbortController();
  const abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  let camera,failed,started=false;
  const onMediaStarted=()=>{
    if(controller.signal.aborted)throw new Error('Video call canceled');
    if(started)throw new Error('Camera already started');
    started=true;
    camera=Promise.resolve().then(()=>pump(worker,{device,signal:controller.signal})).then(()=>{
      if(!controller.signal.aborted)throw new Error('Camera ended during active call');
    }).catch(error=>{
      if(!controller.signal.aborted) {
        failed=error;controller.abort();onPhase('camera-failed');
      }
    });
    onPhase('camera-start-requested'); // not proof of capture or remote display
  };
  try {
    const result=await runCall({signal:controller.signal,onMediaStarted});
    if(failed)throw failed;
    return result;
  } catch(error) {throw failed || error;}
  finally {
    signal?.removeEventListener('abort',abort);controller.abort();
    if(camera)await camera;
  }
}
