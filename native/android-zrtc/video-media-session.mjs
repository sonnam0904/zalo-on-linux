import {runCamera} from './camera-pump.mjs';
import {runRemoteVideo} from './remote-video-pump.mjs';
export async function runVideoMedia(worker,{device,signal,sink,cameraControl,preview},camera=runCamera,remote=runRemoteVideo) {
  if(signal.aborted)return;
  const controller=new AbortController(),abort=()=>controller.abort();
  signal.addEventListener('abort',abort,{once:true});
  let failure;
  const unsubscribe=sink.onClose?.(()=>{
    if(!controller.signal.aborted){failure=new Error('Video display closed');controller.abort();}
  });
  const cancelSubscription=sink.onCancel?.(()=>{
    if(!controller.signal.aborted){failure=new Error('Video call canceled from display');controller.abort();}
  });
  const guard=task=>Promise.resolve().then(task).then(()=>{
    if(!controller.signal.aborted)throw new Error('Video media stopped unexpectedly');
  }).catch(error=>{if(!controller.signal.aborted)failure=error;controller.abort();});
  try {
    await Promise.all([
      guard(()=>cameraControl?cameraControl.run(worker,{device,preview,signal:controller.signal},camera):camera(worker,{device,preview,signal:controller.signal})),
      guard(()=>remote(worker,{signal:controller.signal,render:sink.render,clear:sink.clear}))
    ]);
    if(failure)throw failure;
  } finally {unsubscribe?.();cancelSubscription?.();signal.removeEventListener('abort',abort);controller.abort();}
}
