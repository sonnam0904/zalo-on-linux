import {runCamera} from './camera-pump.mjs';
// Capture off is a joined FFmpeg shutdown, not a hidden preview. Audio and
// remote-video ownership remain outside this controller.
export function createManagedCamera() {
  let bound=false,finished=false,worker,options,capture,signal,stopRun;
  let captureAbort,captureTask,queue=Promise.resolve(),enabled=true,failure;
  const canceled=()=>{const error=new Error('Camera control canceled');error.name='AbortError';return error;};
  const stop=()=>{captureAbort?.abort();stopRun?.();};
  const start=()=>{
    captureAbort=new AbortController();const current=captureAbort;
    let resolveReady,rejectReady,ready=false;
    const readyTask=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    captureTask=Promise.resolve().then(()=>{
      if(signal.aborted || current.signal.aborted)throw canceled();
      return capture(worker,{...options,signal:current.signal,onReady(){
        if(!signal.aborted && !current.signal.aborted){ready=true;resolveReady();}
      }});
    }).then(()=>{if(!current.signal.aborted)throw new Error('Camera stopped unexpectedly');})
      .catch(error=>{
        // AbortError is expected during an intentional capture stop. Other
        // errors (notably preview cleanup) must not acknowledge camera-off.
        if(!signal.aborted && (!current.signal.aborted || error?.name!=='AbortError')){failure=error;stop();}
      })
      .finally(()=>{if(!ready)rejectReady(failure??canceled());});
    return readyTask;
  };
  return {
    async run(native,settings,camera=runCamera) {
      if(bound)throw new Error('Camera controller already used');
      bound=true;worker=native;options={device:settings.device,preview:settings.preview,timestampOriginNs:process.hrtime.bigint()};signal=settings.signal;capture=camera;
      const stopped=new Promise(resolve=>stopRun=resolve);
      signal.addEventListener('abort',stop,{once:true});
      try {
        if(signal.aborted)return;
        start().catch(()=>{});await stopped;
        if(failure)throw failure;
      } catch(error){if(!signal.aborted)throw error;}
      finally {
        finished=true;stop();await queue.catch(()=>{});await captureTask;
        signal.removeEventListener('abort',stop);
      }
    },
    setEnabled(value) {
      if(typeof value!=='boolean')return Promise.reject(new TypeError('Camera state must be boolean'));
      const action=queue.then(async()=>{
        if(!bound || finished || signal.aborted || failure)throw canceled();
        if(value===enabled)return;
        if(!value){captureAbort.abort();await captureTask;}
        else await start(); // Acknowledged only after the first native frame.
        if(signal.aborted || finished || failure)throw canceled();
        enabled=value;
      });
      queue=action.catch(()=>{});return action;
    }
  };
}
