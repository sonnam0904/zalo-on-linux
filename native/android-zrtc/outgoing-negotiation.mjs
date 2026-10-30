import {isIP} from 'node:net';
function address(value) {
  if(typeof value!=='string') throw new Error('Invalid native server address');
  const split=value.lastIndexOf(':'),host=value.slice(0,split),port=value.slice(split+1);
  if(!isIP(host) || !/^[0-9]+$/.test(port) || +port<1 || +port>65535)
    throw new Error('Invalid native server address');
  return value;
}
// Does not own/close worker: caller must keep it alive through 416 and answer.
// APK vz.p1.onInitZrtpWithServer (0x07950c) is the 416 readiness gate;
// onMakeCall merely reports that the attempt started.
export async function negotiateOutgoing(worker,mapped,{signal,timeoutMs=10000}={}) {
  if(!Number.isInteger(timeoutMs) || timeoutMs<1) throw new Error('Invalid negotiation timeout');
  const current=()=>{if(signal?.aborted) throw new Error('Native negotiation canceled');};
  let attemptId=0,settle=null;
  const early=[];
  const relevant=new Set(['onInitZrtpWithServer','onInitZrtpRequestFailed','onCallChangeZRTP','onCallErr','onCallAutoHangup']);
  const onEvent=event=>{
    if(!relevant.has(event.event)) return;
    if(!attemptId) {if(early.length<16) early.push(event);return;}
    if(event.requestId===attemptId) settle?.(event);
  };
  worker.on('callEvent',onEvent);
  try {
    current();
    const configured=await worker.request('configure',mapped.configuration);
    if(configured.code!==0 || configured.offline!==false) throw new Error('Native network configuration unavailable');
    current();
    const attempt=await worker.request('makeCall',mapped.arguments);
    if(attempt.code!==0) throw new Error('Native makeCall rejected');
    attemptId=attempt.id;current();
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new Error('Native server negotiation timeout')),timeoutMs);
      const abort=()=>finish(new Error('Native negotiation canceled'));
      let done=false;
      const finish=(error,result)=>{
        if(done) return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        settle=null;error?reject(error):resolve(result);
      };
      settle=event=>{
        if(event.event!=='onInitZrtpWithServer') return finish(new Error(
          event.event==='onCallChangeZRTP'?'Native server change not integrated':'Native server negotiation failed'));
        try {
          if(event.args.length!==2) throw new Error('Invalid native server callback');
          finish(null,{requestId:attemptId,rtpAddress:address(event.args[0]),rtcpAddress:address(event.args[1]),callReady:false});
        } catch(error) {finish(error);}
      };
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted) abort();
      for(const event of early) if(event.requestId===attemptId) settle?.(event);
    });
  } finally {worker.off('callEvent',onEvent);}
}
