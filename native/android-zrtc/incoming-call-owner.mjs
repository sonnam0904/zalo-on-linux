import {IncomingSession} from './incoming-session.mjs';
import {decodeIncomingVoice,decodeIncomingVideo,incomingControlKey} from './incoming-control.mjs';
const owners=new WeakSet();
// Consent may be backed by a window that disappears without resolving its
// promise. Detach our wait on abort; still observe late rejection. The UI must
// use the supplied signal to close itself and must never start media itself.
function consentResult(requestConsent,args) {
  return new Promise((resolve,reject)=>{
    const aborted=()=>{cleanup();reject(new Error('Incoming consent canceled'));};
    const cleanup=()=>args.signal.removeEventListener('abort',aborted);
    args.signal.addEventListener('abort',aborted,{once:true});
    if(args.signal.aborted){aborted();return;}
    Promise.resolve().then(()=>{
      if(args.signal.aborted)throw new Error('Incoming consent canceled');
      return requestConsent(args);
    }).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
// The application supplies an authenticated transport, verified native identity
// and an abort-aware consent UI. No account values are logged by this owner.
export async function runIncomingCall(worker,transport,message,{context,callerId,
  requestConsent,runMedia,signal,onPhase=()=>{},ringTimeoutMs=60000,ackTimeoutMs=15000}={}) {
  if(typeof requestConsent!=='function' || typeof runMedia!=='function' ||
    typeof callerId!=='string' || !/^[1-9][0-9]{0,19}$/.test(callerId) ||
    !Number.isInteger(ringTimeoutMs) || ringTimeoutMs<1 || ringTimeoutMs>120000 ||
    !Number.isInteger(ackTimeoutMs) || ackTimeoutMs<1 || ackTimeoutMs>120000 || typeof onPhase!=='function')
    throw new TypeError('Explicit incoming UI, media owner, caller and timeout required');
  if(!worker || typeof worker.request!=='function' || typeof worker.on!=='function' || typeof worker.off!=='function' ||
    !transport || typeof transport.request!=='function' || typeof transport.on!=='function' || typeof transport.off!=='function' ||
    (signal!==undefined && (typeof signal?.aborted!=='boolean' || typeof signal.addEventListener!=='function' || typeof signal.removeEventListener!=='function')))
    throw new TypeError('Incoming worker, transport and abort signal required');
  const video=context?.video===true;
  // Reject unsupported identity/media before registering ownership or devices.
  const decoded=video?decodeIncomingVideo(message,{...context,experimentalVideo:true}):decodeIncomingVoice(message,context);
  if(owners.has(worker))throw new Error('Incoming worker already owned');
  if(signal?.aborted)throw new Error('Incoming call canceled');
  const controller=new AbortController(),session=new IncomingSession(worker,transport,{allowVideo:video});
  owners.add(worker);
  let failure,ringTimer,stopping,mediaRunning=false,mediaStarted=false,remoteEnded=false;
  const pending=new Set();
  const cancel=()=>{
    controller.abort();
    if(!mediaRunning)stopping??=session.stop().catch(error=>{failure??=error;});
  };
  const abort=()=>cancel();
  const nativeFault=()=>{
    failure??=new Error('Incoming native media failed');cancel();
  };
  const control=event=>{
    // The desktop control stream broadcasts a successful `answer` to the
    // recipient's other signed-in devices.  For this incoming owner that is a
    // terminal remote action, just like cancel/endcall; our own accepted path
    // receives `answer_ack` instead.
    if(!['answer','answer_ack','cancel','endcall','end_call'].includes(event?.act))return;
    const envelope={type:'control',data:event};
    // An unrelated malformed control must not tear down this call.
    if(event.act!=='answer_ack') {
      let key;try {key=incomingControlKey(envelope);}catch {return;}
      if(key.callId!==decoded.key.callId || key.callerId!==decoded.key.callerId)return;
      remoteEnded=true;
      cancel();return;
    } else if(String(event.data?.callId)!==String(decoded.key.callId))return;
    const task=session.control(envelope,context).then(result=>{
      if(result.handled && event.act!=='answer_ack')cancel();
    }).catch(error=>{failure??=error;cancel();}).finally(()=>pending.delete(task));
    pending.add(task);
  };
  const phase=value=>{
    try {onPhase(value);}catch(error){failure??=error;queueMicrotask(cancel);}
  };
  const check=()=>{if(controller.signal.aborted)throw failure??new Error('Incoming call canceled');};
  try {
    session.on('phase',phase);transport.on('control',control);
    worker.on('nativeFault',nativeFault);worker.on('workerClosed',nativeFault);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)cancel();check();
    await session.control(message,context);check();
    ringTimer=setTimeout(()=>{failure=new Error('Incoming consent timeout');cancel();},ringTimeoutMs);
    let accepted;
    try {accepted=await consentResult(requestConsent,{video,callerId,signal:controller.signal});}
    catch(error){throw failure??error;}
    clearTimeout(ringTimer);check();
    if(accepted!==true) {
      // The shipped desktop renderer maps command 405 to
      // /api/voicecall/cancel. Its callType follows the desktop convention:
      // 0 = voice, 1 = video. This is the pre-answer rejection path; command
      // 409 is reserved for a call whose media session was already started.
      await transport.request(405,{toId:callerId,callId:decoded.key.callId,callType:video?1:0});
      // The server accepts 405 (error_code 0) but the caller's other devices kept ringing in a
      // live test; also send the end-call request the Windows client uses. Best effort.
      try {await transport.request(409,{toId:callerId,callId:decoded.key.callId});} catch {}
      return {accepted:false,callReady:false};
    }
    await session.answer({callerId,userAccepted:true});check();
    await session.waitForAnswerAck({timeoutMs:ackTimeoutMs,signal:controller.signal});check();
    await session.startMedia();mediaStarted=true;check();
    mediaRunning=true;
    try {await runMedia(worker,{video,signal:controller.signal});}
    finally {mediaRunning=false;}
    if(!controller.signal.aborted)throw new Error('Incoming media stopped unexpectedly');
    if(failure)throw failure;
    return {accepted:true,callReady:false};
  } finally {
    clearTimeout(ringTimer);controller.abort();
    signal?.removeEventListener('abort',abort);transport.off('control',control);
    worker.off('nativeFault',nativeFault);worker.off('workerClosed',nativeFault);
    // Desktop command 409 is sendEndCall(toId, callId), not a ZRTC enum.
    // Do not echo a remote hangup. Explicit pre-answer rejection has already
    // used command 405 above.
    // The media task has already joined before reaching this cleanup.
    try {
      try {
        await Promise.all([...pending]);await stopping;
      } finally {
        // Native PCM is owned by the session, not the video/UI media task.
        // Stop it before waiting on HTTPS, which can take the full API timeout.
        try {await session.dispose();}
        finally {
          if(mediaStarted && !remoteEnded)
            await transport.request(409,{toId:callerId,callId:decoded.key.callId});
        }
      }
    }
    finally {session.off('phase',phase);owners.delete(worker);}
  }
}
