import assert from 'node:assert/strict';
import {decodeIncomingVideo,decodeIncomingVoice,incomingVideoConfig} from './incoming-control.mjs';
const extension={callType:1,video:{codec:[{name:'h264',payload:97}]}};
const params={id:789,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},rtpIP:'127.0.0.1:9000',
  rtcpIP:'127.0.0.1:9001',video:{enable:1},extendData:JSON.stringify(extension)};
const request=(p={},data={})=>({type:'control',data:{act_type:'voip',act:'request',data:{
  uidFrom:'456',uidTo:'123',callId:'789',codec:'[{"name":"opus/16000/1","payload":112}]',params:JSON.stringify({...params,...p}),...data}}});
const context={nativeLocalId:123,experimentalVideo:true};
const decoded=decodeIncomingVideo(request(),context);
const mapped=incomingVideoConfig(decoded.config,{experimentalVideo:true});
assert.equal(mapped.operation,'incomingCall');assert.equal(mapped.configuration.userId,123);
assert.equal(mapped.configuration.partnerId,456);assert.equal(mapped.configuration.callId,789);
assert.equal(mapped.configuration.videoCall,true);assert.equal(mapped.configuration.supportVideoCall,true);
assert.equal(mapped.arguments.extendData,params.extendData);
assert.throws(()=>decodeIncomingVoice(request(),context),/media/);
for(const experimentalVideo of [undefined,false,1,'true'])assert.throws(()=>decodeIncomingVideo(request(),{...context,experimentalVideo}),/opt-in/);
assert.throws(()=>incomingVideoConfig(decoded.config),/opt-in/);
for(const video of [undefined,{}, {enable:0},{enable:'1'},{enable:2}])assert.throws(()=>decodeIncomingVideo(request({video}),context),/media/);
for(const extra of ['{}','{"secret":',JSON.stringify({...extension,callType:0}),JSON.stringify({callType:1,video:{codec:[{name:'vp8',payload:96}]}})]) {
  assert.throws(()=>decodeIncomingVideo(request({extendData:extra}),context),error=>!error.message.includes('secret'));
  assert.throws(()=>incomingVideoConfig({...decoded.config,extendData:extra},{experimentalVideo:true}));
}
assert.throws(()=>decodeIncomingVideo(request({}, {uidTo:'124'}),context),/recipient/);
assert.throws(()=>decodeIncomingVideo(request({id:790}),context),/call ID/);
assert.throws(()=>decodeIncomingVideo(request({}, {uidFrom:'9999999999999999999'}),context),/uint32/);
assert.throws(()=>decodeIncomingVideo(request({changeZRTP:{enable:1}}),context),/switching/);
console.log('PASS incoming video boundary: explicit opt-in, native identities, media/H.264, flags, no voice downgrade, redacted errors');
