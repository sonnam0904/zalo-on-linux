import assert from 'node:assert/strict';
import {callerResponse} from './caller-response.mjs';
const fixture={id:789,fromId:123,toId:456,protocol:1,sessId:'fixture',
  settings:{},zrtc_config:{},video:{enable:0},changeZRTP:{enable:0},
  servers:[{rtpaddr:'127.0.0.1:9000',rtcpaddr:'127.0.0.1:9001'}]};
const mapped=callerResponse(fixture,{callId:789,clientVersion:'681',video:false});
assert.equal(mapped.configuration.callId,789);assert.equal(mapped.configuration.userId,123);
assert.equal(mapped.configuration.partnerId,456);assert.equal(mapped.configuration.clientVersion,681);
assert.equal(mapped.arguments.servers,JSON.stringify(fixture.servers));
assert.equal(fixture.callId,undefined);
assert.throws(()=>callerResponse(fixture,{callId:789}),error=>error.code==='CONFIG_MEDIA');
assert.throws(()=>callerResponse(fixture,{callId:789,video:true}),error=>error.code==='CONFIG_MEDIA');
assert.throws(()=>callerResponse(fixture,{callId:789,video:true,experimentalVideo:1}),error=>error.code==='CONFIG_MEDIA');
const video=callerResponse(fixture,{callId:789,video:true,experimentalVideo:true});
assert.equal(video.configuration.videoCall,true);assert.equal(video.configuration.supportVideoCall,true);
assert.equal(mapped.configuration.videoCall,undefined);
assert.equal(callerResponse({...fixture,video:{enable:1}},{callId:789,video:false}).configuration.userId,123);
for(const [change,code] of [[{id:790},'CONFIG_CALL_ID'],
  [{changeZRTP:{enable:1}},'CONFIG_DYNAMIC_ZRTP'],[{fromId:'9999999999999999999'},'CONFIG_FIELDS']])
  assert.throws(()=>callerResponse({...fixture,...change},{callId:789,video:false}),error=>error.code===code);
console.log('PASS caller response: observed id mapping, strict correlation, native identities, media/dynamic ZRTP gates');
