import {callDialog,activeCallControls} from './native-call-ui.mjs';
import {createManagedCamera} from './managed-camera.mjs';

export async function withOutgoingCallUI(worker,{signal,video=false,runMedia},runCall,dialog=callDialog) {
  if(video && typeof runMedia!=='function')throw new TypeError('Video media owner required');
  const controller=new AbortController(),abort=()=>controller.abort();
  const cameraControl=video?createManagedCamera():undefined;
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
  let stage,task,mediaTask,failure,answered=false,cleanup;
  const stopUI=async()=>{stage?.abort();await task;};
  const open=kind=>{
    const currentStage=new AbortController();stage=currentStage;
    const stop=()=>currentStage.abort();controller.signal.addEventListener('abort',stop,{once:true});
    if(controller.signal.aborted)stop();
    task=Promise.resolve().then(()=>{
      if(currentStage.signal.aborted)return;
      return kind==='dialing'?dialog(kind,{video,signal:currentStage.signal}):
        activeCallControls(worker,{video,signal:currentStage.signal,cameraControl},dialog);
    }).then(()=>{if(!currentStage.signal.aborted)controller.abort();})
      .catch(error=>{if(!currentStage.signal.aborted){failure=error;controller.abort();}})
      .finally(()=>controller.signal.removeEventListener('abort',stop));
  };
  const beforeCleanup=()=>cleanup??=(async()=>{
    controller.abort();await stopUI();await mediaTask;
    const reply=await worker.request('stop');
    if(reply?.code!==0)throw new Error('Outgoing audio shutdown failed');
  })();
  try {
    if(controller.signal.aborted)throw new Error('Outgoing call canceled');
    open('dialing');
    const result=await runCall({signal:controller.signal,beforeCleanup,onAnswered:async()=>{
      if(answered)throw new Error('Outgoing UI already answered');
      answered=true;await stopUI();
      if(controller.signal.aborted)throw new Error('Outgoing call canceled');
      open('active');
      if(runMedia)mediaTask=Promise.resolve().then(()=>{
        if(!controller.signal.aborted)return runMedia(worker,{signal:controller.signal,cameraControl});
      }).then(()=>{
        if(!controller.signal.aborted)throw new Error('Outgoing media stopped unexpectedly');
      }).catch(error=>{if(!controller.signal.aborted){failure=error;controller.abort();}});
    }});
    if(failure)throw failure;
    return result;
  } catch(error) {throw failure??error;}
  finally {
    signal?.removeEventListener('abort',abort);controller.abort();await beforeCleanup();
  }
}
export const withOutgoingVoiceUI=withOutgoingCallUI;
