// Configuration contract from native/nativelibs/zcall/vcmac.js:setConfigData.
// Do not apply this to an arbitrary recvSignal envelope: callers must supply
// the decoded call configuration, not guess whether response.data is config.
import {isIP} from 'node:net';
function integer(value,key) {
  if(typeof value==='string' && /^(0|[1-9][0-9]*)$/.test(value)) value=Number(value);
  if(!Number.isSafeInteger(value) || value<0 || value>0xffffffff)
    throw new TypeError(`Unsupported uint32 call field: ${key}`);
  return value;
}
function string(value,key,empty=false) {
  if(typeof value!=='string' || value.includes('\0') || (!empty && !value.length))
    throw new TypeError(`Invalid call string: ${key}`);
  return value;
}
function json(value,key) {
  if(!value || typeof value!=='object' || Array.isArray(value)) throw new TypeError(`Missing call object: ${key}`);
  return JSON.stringify(value);
}
function address(value,key) {
  string(value,key);
  const split=value.lastIndexOf(':'), host=value.slice(0,split), port=value.slice(split+1);
  if(!isIP(host) || !/^[0-9]+$/.test(port) || Number(port)<1 || Number(port)>65535)
    throw new TypeError(`Invalid native server address: ${key}`);
  return value;
}
export function desktopVoiceConfig(config,{role,video,offlineConfiguration=false,abortOnServerChange=false}={}) {
  if(video!==false) throw new Error('Native video is not implemented; request voice explicitly');
  if(!['caller','callee'].includes(role)) throw new TypeError('Invalid call role');
  if(!config || typeof config!=='object' || Array.isArray(config)) throw new TypeError('Invalid call configuration');
  if(config.changeZRTP?.enable == 1 && offlineConfiguration!==true && abortOnServerChange!==true) throw new Error('Dynamic ZRTP server switching is not integrated');
  const configuration={
    userId:integer(config.fromId,'fromId'),partnerId:integer(config.toId,'toId'),
    protocol:integer(config.protocol,'protocol'),callId:integer(config.callId,'callId'),
    clientVersion:integer(config.clientVersion??0,'clientVersion'),
    session:string(config.sessId,'sessId'),settings:json(config.settings,'settings'),
    zrtcConfig:json(config.zrtc_config,'zrtc_config'),
  };
  // The JNI config setter is ported; online server-change event handling is
  // not. Only the explicitly offline configuration path may enable it yet.
  if(config.changeZRTP?.enable == 1) configuration.enableChangeZrtp=true;
  if(role==='caller') {
    if(!Array.isArray(config.servers)) throw new TypeError('Missing caller server list');
    for(const server of config.servers) {
      if(!server || typeof server!=='object') throw new TypeError('Invalid caller server');
      address(server.rtpaddr,'rtpaddr');address(server.rtcpaddr,'rtcpaddr');
    }
    return {configuration,operation:'makeCall',arguments:{servers:JSON.stringify(config.servers)}};
  }
  return {configuration,operation:'incomingCall',arguments:{
    rtpAddress:address(config.rtpIP,'rtpIP'),rtcpAddress:address(config.rtcpIP,'rtcpIP'),
    relayServer:string(config.relayServer??'','relayServer',true),
    audioCodec:string(config.audioConfig,'audioConfig'),
    extendData:string(config.extendData??'','extendData',true),
  }};
}
const configuring = new WeakSet();
export async function startDesktopVoice(worker,config,options) {
  // Complete validation precedes native mutation; never truncate desktop IDs.
  const mapped=desktopVoiceConfig(config,options);
  if(configuring.has(worker)) throw new Error('Native call configuration busy');
  configuring.add(worker);
  try {
  const applied=await worker.request('configure',mapped.configuration);
  if(applied.code!==0) throw new Error(`Native configuration rejected (${applied.code})`);
  const attempt=await worker.request(mapped.operation,mapped.arguments);
  if(attempt.code!==0) {
    await worker.request('stop');
    throw new Error(`Native call attempt rejected (${attempt.code})`);
  }
  return attempt; // accepted attempt is not a connected call
  } finally { configuring.delete(worker); }
}
