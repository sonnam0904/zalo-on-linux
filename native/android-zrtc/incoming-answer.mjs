import {isIP} from 'node:net';
function parse(value,label) {
  if(typeof value!=='string' || Buffer.byteLength(value)>65536)throw new Error(`Invalid native ${label}`);
  try {return JSON.parse(value);}catch {throw new Error(`Invalid native ${label}`);}
}
function address(value) {
  if(typeof value!=='string')throw new Error('Invalid native answer address');
  const at=value.lastIndexOf(':'),host=value.slice(0,at),port=value.slice(at+1);
  if(!isIP(host) || !/^[0-9]+$/.test(port) || Number(port)<1 || Number(port)>65535)throw new Error('Invalid native answer address');
  return value;
}
// Prepare only. Caller owns user consent, native-ready/ringing phase and the
// correlated remote ACK. This function never sends 402 or starts any media.
export async function prepareIncomingAnswer(worker,{callerId,callId,video=false,signal,current}={}) {
  if(typeof callerId!=='string' || !/^[1-9][0-9]{0,19}$/.test(callerId) ||
    !Number.isInteger(callId) || callId<0 || callId>0xffffffff || typeof video!=='boolean' || typeof current!=='function')
    throw new TypeError('Explicit caller identity, media and ownership check required');
  const check=()=>{if(signal?.aborted)throw new Error('Incoming answer canceled');current();};
  async function query(operation){check();const reply=await worker.request(operation);check();if(reply.code!==0)throw new Error('Native answer data unavailable');return reply.data;}
  const info=parse(await query('callInfo'),'call info');
  if(!info || typeof info!=='object' || Array.isArray(info))throw new Error('Invalid native call info');
  const rtpAddress=address(info.rtpAddress),rtcpAddress=address(info.rtcpAddress);
  if(typeof info.sessionId!=='string' || !info.sessionId.length || info.sessionId.includes('\0') || Buffer.byteLength(info.sessionId)>65536)
    throw new Error('Invalid native answer session');
  const codec=await query('audioCodecs'),codecs=parse(codec,'audio codec');
  if(!Array.isArray(codecs) || !codecs.length || codecs.some(c=>!c || typeof c.name!=='string' || !Number.isInteger(c.payload) || c.payload<0 || c.payload>127))
    throw new Error('Invalid native audio codec');
  const extendData=await query('extendData'),extension=parse(extendData,'extension');
  if(!extension || typeof extension!=='object' || Array.isArray(extension))throw new Error('Invalid native extension');
  if(video && (extension.callType!==1 || !Array.isArray(extension.video?.codec) || !extension.video.codec.some(c=>c?.name==='h264' && c.payload===97)))
    throw new Error('Native incoming video was downgraded');
  check();
  return {callerId,callId,status:0,codec,extendData,rtcpAddress,rtpAddress,session:info.sessionId};
}
