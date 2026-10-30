import {desktopVoiceConfig} from './desktop-config.mjs';

// Live desktop control/request schema, observed 2026-09-09. This boundary
// requires a separately verified native local identity. local.id and uidN are
// desktop identifiers, NOT native uint32 identities. Never derive one from them.
function object(value,field) {
  if(!value || typeof value!=='object' || Array.isArray(value))
    throw new TypeError(`Invalid incoming ${field}`);
  return value;
}
function uint32(value,field) {
  if(typeof value==='string' && /^(0|[1-9][0-9]{0,9})$/.test(value)) value=Number(value);
  if(!Number.isInteger(value) || value<0 || value>0xffffffff)
    throw new TypeError(`Invalid incoming uint32 ${field}`);
  return value;
}
function json(value,field) {
  if(typeof value!=='string' || Buffer.byteLength(value)>65536)
    throw new TypeError(`Invalid incoming JSON ${field}`);
  // JSON.parse errors can contain fragments of session material. Do not leak
  // the original exception or attach the original payload as an error cause.
  try {return JSON.parse(value);} catch {throw new TypeError(`Invalid incoming JSON ${field}`);}
}
export function incomingControlKey(message) {
  const control=object(message?.data,'control');
  if(message.type!=='control' || control.act_type!=='voip' ||
     !['request','answer','cancel','endcall','end_call'].includes(control.act))
    throw new TypeError('Unsupported incoming control');
  const data=object(control.data,'data');
  return {action:control.act,callId:uint32(data.callId,'callId'),callerId:uint32(data.uidFrom,'uidFrom')};
}
export function decodeIncomingVoice(message,{nativeLocalId,clientVersion=0}={}) {
  return decodeIncoming(message,{nativeLocalId,clientVersion},false);
}
export function decodeIncomingVideo(message,{nativeLocalId,clientVersion=0,experimentalVideo=false}={}) {
  if(experimentalVideo!==true)throw new Error('Incoming video requires explicit experimental opt-in');
  return decodeIncoming(message,{nativeLocalId,clientVersion},true);
}
function decodeIncoming(message,{nativeLocalId,clientVersion},video) {
  const key=incomingControlKey(message);
  if(key.action!=='request') throw new TypeError('Expected incoming request');
  const data=message.data.data,params=object(json(data.params,'params'),'params');
  const localId=uint32(nativeLocalId,'verified local identity');
  if(uint32(data.uidTo,'uidTo')!==localId) throw new Error('Incoming recipient mismatch');
  if(uint32(params.id,'params.id')!==key.callId) throw new Error('Incoming call ID mismatch');
  let callType;
  try {
    const ext=typeof params.extendData==='string'?JSON.parse(params.extendData):params.extendData;
    if(ext && typeof ext==='object' && Number.isInteger(ext.callType)) callType=ext.callType;
  } catch {}
  if(params.video?.enable!==0 && params.video?.enable!==1)
    throw new Error('Incoming video or unknown media is unsupported');
  const isIncomingVideo=params.video.enable===1 && (callType===undefined || callType===1);
  if(video!==isIncomingVideo) throw new Error('Incoming video or unknown media is unsupported');
  const codecs=json(data.codec,'codec');
  if(!Array.isArray(codecs) || !codecs.length) throw new Error('Invalid incoming codec offer');
  const config={fromId:localId,toId:key.callerId,callId:key.callId,clientVersion,
    protocol:params.protocol,sessId:params.sessId,settings:params.settings,
    zrtc_config:params.zrtc_config,changeZRTP:params.changeZRTP,
    rtpIP:params.rtpIP,rtcpIP:params.rtcpIP,relayServer:params.rtpSerIp??'',
    audioConfig:data.codec,extendData:params.extendData??''};
  // APK d00.r.r0 parses sessId/rtpIP/rtcpIP/rtpSerIp from params;
  // outer codec is the caller's offer, not params.codec (local capabilities).
  // The live schema establishes shape, not identity/media values. Keep this
  // adapter opt-in until a verified nativeLocalId is supplied by integration.
  desktopVoiceConfig(config,{role:'callee',video:false});
  if(video) {
    const extension=object(json(config.extendData,'video extension'),'video extension');
    if(extension.callType!==1 || !Array.isArray(extension.video?.codec) ||
      !extension.video.codec.some(codec=>codec?.name==='h264' && codec.payload===97))
      throw new Error('Incoming H.264 offer is unsupported');
  }
  return {key,config};
}
export function incomingVideoConfig(config,{experimentalVideo=false}={}) {
  if(experimentalVideo!==true)throw new Error('Incoming video requires explicit experimental opt-in');
  const extension=object(json(config?.extendData,'video extension'),'video extension');
  if(extension.callType!==1 || !Array.isArray(extension.video?.codec) ||
    !extension.video.codec.some(codec=>codec?.name==='h264' && codec.payload===97))
    throw new Error('Incoming H.264 offer is unsupported');
  const mapped=desktopVoiceConfig(config,{role:'callee',video:false});
  mapped.configuration.videoCall=true;mapped.configuration.supportVideoCall=true;
  return mapped;
}
