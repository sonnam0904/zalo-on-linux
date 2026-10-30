import {desktopVoiceConfig} from './desktop-config.mjs';
function fail(code) {const error=new Error(code);error.code=code;throw error;}
// Authenticated, already-decoded 401 response. Observed desktop response uses
// id, not legacy CallConfig.callId. Do not substitute the requested ID silently.
export function callerResponse(response,{callId,clientVersion=0,video,experimentalVideo=false,offlineConfiguration=false,abortOnServerChange=false}={}) {
  if(!response || typeof response!=='object' || Array.isArray(response)) fail('CONFIG_FIELDS');
  if(!Number.isInteger(callId) || callId<1 || callId>0x7fffffff || response.id!==callId)
    fail('CONFIG_CALL_ID');
  // Legacy vcmac.setConfigData passes isVideoCall separately to setConfig;
  // response.video.enable is not used to select the local media mode there.
  // Require explicit media intent from the validated UI request. Video also
  // requires an independent experimental opt-in; response.video is not intent.
  if(typeof experimentalVideo!=='boolean' || !(video===false || video===true && experimentalVideo)) fail('CONFIG_MEDIA');
  if(response.changeZRTP?.enable == 1 && offlineConfiguration!==true && abortOnServerChange!==true) fail('CONFIG_DYNAMIC_ZRTP');
  const config={...response,callId:response.id,clientVersion};
  try {
    const mapped=desktopVoiceConfig(config,{role:'caller',video:false,offlineConfiguration,abortOnServerChange});
    if(video)Object.assign(mapped.configuration,{videoCall:true,supportVideoCall:true});
    return mapped;
  }
  catch {fail('CONFIG_FIELDS');}
}
