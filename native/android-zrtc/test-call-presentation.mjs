import assert from 'node:assert/strict';
import presentation from './call-presentation.cjs';
import setup from '../qt-call-cap-linux/outgoing-setup.js';
const {peerName,peerAvatar}=presentation;
assert.equal(peerName('  Liên\n hệ\u202e thử  '),'Liên hệ thử');
assert.equal(peerName(null),'');assert.equal(peerName('a'.repeat(513)),'');
assert.equal(Array.from(peerName('🎥'.repeat(81))).length,80);
assert.equal(peerName('<b>Liên hệ</b>'),'<b>Liên hệ</b>','Name remains plain text, not parsed HTML');
assert.equal(peerAvatar('https://s120.avatar.talk.zdn.vn/a.jpg#ignored'),'https://s120.avatar.talk.zdn.vn/a.jpg');
assert.equal(peerAvatar('https://s120-ava-talk.zadn.vn/a.jpg'),'https://s120-ava-talk.zadn.vn/a.jpg');
for(const bad of ['http://s120.avatar.talk.zdn.vn/a.jpg','file:///etc/passwd','data:image/png;base64,AA==',
  'https://zdn.vn.evil.example/a.jpg','https://user@zdn.vn/a.jpg',null])assert.equal(peerAvatar(bad),'');
let release,context;
const response=new Promise(resolve=>release=resolve);
const transport={async request(command,payload){
  assert.equal(command,401);assert.deepEqual(Object.keys(payload).sort(),['callId','calleeId','codec','type']);
  return response;
},cancel(){}};
const owner=new setup.OutgoingSetup(transport,{callId:()=>123,onConfig:async(_config,options)=>{context=options;return {};}});
const request={type:1,partner:[{id:'456',name:'Liên hệ ban đầu',avatar:'https://s120.avatar.talk.zdn.vn/a.jpg'}]};
const run=owner.start(request);request.partner[0].name='Tên bị sửa sau đó';request.partner[0].avatar='https://evil.example/a.jpg';release({});await run;
assert.equal(context.peerName,'Liên hệ ban đầu');assert.equal(context.calleeId,'456');
assert.equal(context.peerAvatar,'https://s120.avatar.talk.zdn.vn/a.jpg');
console.log('PASS call presentation: bounded Unicode/plain text, control stripping, immutable per-call name, no display name in signaling');
