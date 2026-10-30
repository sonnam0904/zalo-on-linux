import assert from 'node:assert/strict';
import {resolveIncomingIdentity} from './incoming-identity.mjs';
import identities from '../qt-call-cap-linux/native-identity.js';
const message=(video=false)=>({type:'control',data:{act_type:'voip',act:'request',data:{uidFrom:'456',uidTo:'123',uidN:'9999999999999999999',callId:'789',
  codec:'[{"name":"opus/16000/1","payload":112}]',params:JSON.stringify({id:789,protocol:1,sessId:'fixture',settings:{},zrtc_config:{},
    rtpIP:'127.0.0.1:9000',rtcpIP:'127.0.0.1:9001',video:{enable:video?1:0},
    ...(video?{extendData:JSON.stringify({callType:1,video:{codec:[{name:'h264',payload:97}]}})}:{})})}}});
const fresh=()=>{const identity=new identities.NativeIdentity();identity.setAccount('8888888888888888888');return identity;};
for(const video of [false,true]) {
  const identity=fresh(),transport={request(){throw new Error('Incoming binding must not create a competing 401');}};
  assert.equal(await resolveIncomingIdentity(transport,identity,message(video),{
    signal:new AbortController().signal,videoEnabled:video}),123);
  assert.equal(identity.resolve(),123);
  assert.equal(await resolveIncomingIdentity(transport,identity,message(video),{signal:new AbortController().signal}),123);
}
const noAccount=new identities.NativeIdentity();
const denied={request(){throw new Error('must not request');}};
await assert.rejects(resolveIncomingIdentity(denied,noAccount,message(),{signal:new AbortController().signal}));
const malformed=message();malformed.data.data.uidTo='4294967296';
await assert.rejects(resolveIncomingIdentity(denied,fresh(),malformed,{signal:new AbortController().signal}),/envelope/);
const conflict=fresh();conflict.remember(conflict.ticket(),124);
await assert.rejects(resolveIncomingIdentity(denied,conflict,message(),{signal:new AbortController().signal}),/recipient changed/);
const canceled=fresh(),controller=new AbortController();controller.abort();
await assert.rejects(resolveIncomingIdentity(denied,canceled,message(),{signal:controller.signal}),/unavailable/);
assert.throws(()=>canceled.resolve(),/unavailable/);
console.log('PASS first-incoming identity: authenticated control binding, no competing 401, cache/conflict/account/cancellation gates');
