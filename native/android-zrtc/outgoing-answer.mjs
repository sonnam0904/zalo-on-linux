// APK classes5: j0.v0 0x04cdb2 accepts response 0; j0.w0 0x04d0a8
// applies peer media before j0.u 0x04e3c8 sends 408 and sets CONFIRMED.
function objectJSON(value) {
  if(typeof value!=='string' || value.length>65536) throw new Error('Invalid answer JSON');
  let parsed;try {parsed=JSON.parse(value);} catch {throw new Error('Invalid answer JSON');}
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('Invalid answer object');
  return parsed;
}
export function decodeOutgoingAnswer(control,configuration) {
  const data=control?.data;
  if(control?.act_type!=='voip' || control.act!=='answer' || !data ||
    String(data.callId)!==String(configuration.callId) || String(data.uidFrom)!==String(configuration.partnerId))
    throw new Error('Uncorrelated answer');
  if(data.status!==0 && data.status!=='0') throw new Error('Peer did not accept call');
  const params=objectJSON(data.params);
  const audioCodec=params.codec ?? data.codec;
  if(typeof audioCodec!=='string' || audioCodec.length>65536) throw new Error('Invalid answer codec');
  let codecs;try {codecs=JSON.parse(audioCodec);} catch {throw new Error('Invalid answer codec');}
  if(!Array.isArray(codecs) || !codecs.length || codecs.some(c=>!c || typeof c.name!=='string' ||
    !Number.isInteger(c.payload) || c.payload<0 || c.payload>127)) throw new Error('Invalid answer codec');
  objectJSON(params.extendData);
  return {audioCodec,extendData:params.extendData};
}
export async function acceptOutgoingAnswer(worker,signaling,control,configuration,
  {calleeId,signal,current=()=>{},onPhase=()=>{}}={}) {
  const check=()=>{if(signal?.aborted) throw new Error('Answer canceled');current();};
  const media=decodeOutgoingAnswer(control,configuration);
  check();
  const updated=await worker.request('updateCallerInfo',media);
  if(updated.code!==0) throw new Error('Peer codec negotiation failed');
  check();onPhase('peer-codec-applied');
  await signaling.request(408,{calleeId,callId:configuration.callId});
  check();onPhase('answer-acknowledged');
  const started=await worker.request('callState',{state:'CONFIRMED'});
  if(started.code!==0) throw new Error('Native media startup failed');
  check();onPhase('media-started');
  // Dispatch and device counters alone are not proof of remote audio reception.
  return {callReady:false};
}
