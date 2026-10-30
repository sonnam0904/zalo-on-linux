'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {IncomingName}=require('./incoming-name');
(async()=>{
  const sent=[],lookup=new IncomingName(message=>sent.push(message),{timeoutMs:30});
  let abort=new AbortController(),result=lookup.resolve('456',abort.signal),first=sent.at(-1);
  assert.equal(first.command,'getAliasName');assert.match(first.data.requestId,/^[a-f0-9-]{36}$/);
  assert.equal(lookup.receive({type:'response',command:'other'}),false);
  lookup.receive({type:'response',command:'getAliasName',data:{...first.data,noisedId:'789',aliasName:'Wrong'}});
  assert.ok(lookup.pending);abort.abort();assert.equal(await result,'');
  abort=new AbortController();result=lookup.resolveContact('456',abort.signal);const second=sent.at(-1);
  assert.notEqual(first.data.requestId,second.data.requestId);
  lookup.receive({type:'response',command:'getAliasName',data:{...first.data,aliasName:'Stale contact'}});
  assert.ok(lookup.pending,'Stale response must not resolve new same-contact lookup');
  lookup.receive({type:'response',command:'getAliasName',data:{...second.data,aliasName:' Liên\n hệ thử ',avatar:'https://s120.avatar.talk.zdn.vn/a.jpg'}});
  assert.deepEqual(await result,{peerName:'Liên hệ thử',peerAvatar:'https://s120.avatar.talk.zdn.vn/a.jpg'});assert.equal(lookup.pending,null);
  assert.equal(await lookup.resolve('456',new AbortController().signal),'','Unpatched/slow renderer must fall back');
  const failed=new IncomingName(()=>{throw Error('transport unavailable');});
  assert.equal(await failed.resolve('456',new AbortController().signal),'');
  assert.equal(await lookup.resolve('../bad',new AbortController().signal),'');
  for(const file of ['compact-app-pc.e08d0d44f38873747a6b.js','lazy/default-login-main-startup-shared-worker-znotification.9e3e92e88644da772301.js']) {
    const source=fs.readFileSync(path.resolve(__dirname,'../../pc-dist',file),'utf8');
    const start=source.indexOf('case "getAliasName": {'),end=source.indexOf('break',start);
    assert.ok(start>=0 && end>start);
    const body=source.slice(start+'case "getAliasName": {'.length,end);
    const contactBinding=body.match(/const e = ([A-Za-z_$][\w$]*)\.default\.getDName/)[1];
    const invoke=new Function(contactBinding,'n','t',body);let reply;
    const context={_sendToNative(message){reply=message;}};
    const contacts={default:{getDName(id){assert.equal(id,'456');return 'Liên hệ thử';},getMiniInfo(id){assert.equal(id,'456');return {avatar:'https://s120.avatar.talk.zdn.vn/a.jpg'};}}};
    invoke.call(context,contacts,second.data,'getAliasName');
    assert.deepEqual(reply,{type:'response',command:'getAliasName',data:{...second.data,aliasName:'Liên hệ thử',avatar:'https://s120.avatar.talk.zdn.vn/a.jpg'}});
    invoke.call(context,contacts,{noisedId:'456',requestId:'bad'},'getAliasName');assert.ok(!Object.hasOwn(reply.data,'requestId'));
    invoke.call(context,contacts,{noisedId:'456'},'getAliasName');assert.ok(!Object.hasOwn(reply.data,'requestId'));
  }
  console.log('PASS incoming name: correlated renderer lookup, same-contact stale response isolation, abort/timeout fallback, both actual bundle responders');
})().catch(error=>{console.error(error);process.exitCode=1;});
