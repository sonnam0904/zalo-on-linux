import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {callDialog} from './native-call-ui.mjs';
for(const outcome of ['accept','ignore','abort','failure']) {
  const controller=new AbortController(),child=new EventEmitter();let kills=0;
  child.kill=()=>{kills++;queueMicrotask(()=>child.emit('close',null));};
  let argv;
  const promise=callDialog('consent',{video:true,signal:controller.signal},(file,args,options)=>{
    assert.equal(file,'zenity');assert.equal(options.stdio,'ignore');argv=args;return child;
  });
  assert.ok(argv.includes('--no-markup'));assert.ok(argv.includes('--ok-label=Trả lời'));
  assert.ok(argv.includes('--cancel-label=Bỏ qua'));
  if(outcome==='abort')controller.abort();
  else if(outcome==='failure'){child.emit('error',new Error('private spawn diagnostic'));child.emit('close',-2);}
  else child.emit('close',outcome==='accept'?0:1);
  if(outcome==='abort') {await assert.rejects(promise,/canceled/);assert.equal(kills,1);}
  else if(outcome==='failure')await assert.rejects(promise,error=>error.message==='Native call dialog unavailable');
  else assert.equal(await promise,outcome==='accept');
  controller.abort();assert.equal(kills,outcome==='abort'?1:0,'abort listener removed after close');
}
const stopped=new AbortController();stopped.abort();
for(const video of [false,true])for(const code of [0,5]) {
  const controller=new AbortController(),child=new EventEmitter();
  const result=callDialog('error',{video,signal:controller.signal,error:'PRIVATE',callerId:'PRIVATE'},(_file,args)=>{
    assert.ok(args.includes('--error'));assert.ok(args.includes('--timeout=15'));
    assert.ok(args.includes('--ok-label=Đóng'));assert.ok(args.includes('--no-markup'));
    assert.ok(!args.join(' ').includes('PRIVATE'));
    assert.equal(args.join(' ').includes('camera'),video);
    return child;
  });
  child.emit('close',code);assert.equal(await result,true);
}
await assert.rejects(callDialog('consent',{signal:stopped.signal},()=>{throw Error('must not spawn');}),/canceled/);
console.log('PASS native GTK call UI boundary: accept/ignore, abort and process join, spawn failure redaction, listener cleanup');
