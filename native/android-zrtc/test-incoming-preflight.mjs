import assert from 'node:assert/strict';
import {prepareIncomingDesktop} from './incoming-preflight.mjs';
const message={data:{data:{uidN:'9999999999999999999'}}};
const failure=new Error('private raw signaling must not reach UI');
const run=(controller,deps)=>prepareIncomingDesktop({}, {}, message,{signal:controller.signal},deps);
{
  const controller=new AbortController(),events=[];
  assert.deepEqual(await run(controller,{
    resolveIdentity:async()=>{events.push('identity');return 123;},
    resolveName:async(id,signal)=>{assert.equal(id,message.data.data.uidN);assert.equal(signal,controller.signal);events.push('name');return 'Tên thử';},
    dialog:()=>assert.fail('Unexpected error UI'),
  }),{nativeLocalId:123,peerName:'Tên thử',peerAvatar:''});
  assert.deepEqual(events,['identity','name']);
}
{
  const controller=new AbortController();
  assert.deepEqual(await run(controller,{
    resolveIdentity:async()=>123,
    resolveContact:async()=>({peerName:'Tên có ảnh',peerAvatar:'https://s120.avatar.talk.zdn.vn/a.jpg'}),
    dialog:()=>assert.fail('Unexpected error UI'),
  }),{nativeLocalId:123,peerName:'Tên có ảnh',peerAvatar:'https://s120.avatar.talk.zdn.vn/a.jpg'});
}
for(const stage of ['identity','name']) {
  const controller=new AbortController(),dialogs=[];
  await assert.rejects(run(controller,{
    resolveIdentity:async()=>{if(stage==='identity')throw failure;return 123;},
    resolveName:async()=>{assert.equal(stage,'name');throw failure;},
    dialog:async(kind,options)=>{dialogs.push({kind,options});throw new Error('UI unavailable');},
  }),error=>error===failure);
  assert.deepEqual(dialogs,[{kind:'error',options:{signal:controller.signal}}]);
}
for(const stage of ['before','identity','name']) {
  const controller=new AbortController();
  if(stage==='before')controller.abort();
  let names=0,identities=0;
  await assert.rejects(run(controller,{
    resolveIdentity:async()=>{identities++;if(stage==='identity')controller.abort();return 123;},
    resolveName:async()=>{names++;controller.abort();return 'Canceled';},
    dialog:()=>assert.fail('Canceled preflight must not open UI'),
  }),/canceled/);
  assert.equal(identities,stage==='before'?0:1);
  assert.equal(names,stage==='name'?1:0);
}
console.log('PASS incoming preflight: visible generic failures, original error retained, cancellation at each boundary, no private error data');
