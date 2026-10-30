'use strict';
const {StringDecoder}=require('node:string_decoder');
const {peerName,peerAvatar}=require('./call-presentation.cjs');
// Small control protocol on an inherited duplex pipe. Only a bounded display
// name is included, never account credentials or contact identifiers. Video
// pixels remain on their separate bounded/backpressured binary pipe.
function channel(stream,receive,onClose) {
  let buffer='',closed=false;
  const decoder=new StringDecoder('utf8');
  const fail=()=>{if(closed)return;closed=true;buffer='';onClose();};
  stream.on('error',fail);stream.on('close',fail);stream.on('end',fail);
  stream.on('data',chunk=>{
    if(closed)return;
    buffer+=decoder.write(chunk);
    if(buffer.length>4096){fail();stream.destroy();return;}
    while(buffer.includes('\n')) {
      const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
      try {const message=JSON.parse(line);
        if(!message || typeof message!=='object' || !Number.isSafeInteger(message.id) || message.id<1)throw Error();
        receive(message);
      } catch {fail();stream.destroy();return;}
    }
  });
  return {send(message){if(closed)throw new Error('Call UI pipe closed');stream.write(JSON.stringify(message)+'\n');},
    close(){fail();stream.destroy();}};
}
function createCallUIClient(stream) {
  let serial=0,pending,closed=false;
  const finish=(error,value)=>{
    const task=pending;if(!task)return;pending=null;clearTimeout(task.timer);
    task.signal?.removeEventListener('abort',task.abort);
    if(error)task.reject(error);else task.resolve(value);
  };
  const pipe=channel(stream,message=>{
    if(!pending || message.id!==pending.id || !['result','error'].includes(message.type))throw Error();
    const aborted=pending.signal?.aborted;
    if(message.type==='result' && ![true,false,'toggle','end','camera'].includes(message.value))throw Error();
    finish(aborted || message.type==='error'?new Error('Call UI request canceled or unavailable'):null,message.value);
  },()=>{closed=true;finish(new Error('Call UI pipe closed'));});
  const request=(type,kind,options={})=>{
    if(closed || pending || options.signal?.aborted)return Promise.reject(new Error('Call UI unavailable'));
    return new Promise((resolve,reject)=>{
      const id=++serial;
      const abort=()=>{
        clearTimeout(pending?.timer);
        try {pipe.send({id,type:'cancel'});}
        catch {finish(new Error('Call UI pipe closed'));return;}
        if(pending)pending.timer=setTimeout(()=>pipe.close(),5000);
      };
      pending={id,resolve,reject,signal:options.signal,abort};
      options.signal?.addEventListener('abort',abort,{once:true});
      try {pipe.send({id,type,...(['dialog','notify'].includes(type)?{kind,video:options.video===true,
        muted:options.muted===true,muteControl:options.muteControl===true,
        cameraControl:options.cameraControl===true,cameraEnabled:options.cameraEnabled!==false,
        peerName:peerName(options.peerName),peerAvatar:peerAvatar(options.peerAvatar)}:{})});}
      catch {finish(new Error('Call UI pipe closed'));}
      if(type==='clear' && pending)pending.timer=setTimeout(()=>pipe.close(),5000);
      else if(kind==='error' && pending)pending.timer=setTimeout(abort,15000);
    });
  };
  return {dialog:(kind,options)=>request('dialog',kind,options),notifyIncoming:options=>request('notify','consent',options),
    clear:()=>request('clear'),close:()=>pipe.close()};
}
function attachCallUIHost(stream,createWindow,{locked=false}={}) {
  if(typeof locked!=='boolean')throw new TypeError('Call lock must be boolean');
  let host,pending,closed=false,lastId=0;
  const clear=()=>{pending?.controller.abort();host?.dispose();host=null;};
  const pipe=channel(stream,message=>{
    if(message.type==='cancel') {
      // An action result may already be in flight when cancellation arrives.
      if(message.id>lastId)throw Error();
      if(pending?.id===message.id)pending.controller.abort();return;
    }
    if(pending || message.id!==lastId+1)throw Error();lastId=message.id;
    if(message.type==='clear'){clear();pipe.send({id:message.id,type:'result',value:true});return;}
    if(!['dialog','notify'].includes(message.type) ||
      (message.type==='dialog'?!['consent','preparing','dialing','active','error'].includes(message.kind):message.kind!=='consent') ||
      ['video','muted','muteControl','cameraControl','cameraEnabled'].some(key=>typeof message[key]!=='boolean'))throw Error();
    const task={id:message.id,controller:new AbortController()};pending=task;
    Promise.resolve().then(()=>{
      if(closed || locked || task.controller.signal.aborted)throw Error();
      host??=createWindow();
      const options={signal:task.controller.signal,video:message.video,
        muted:message.muted,muteControl:message.muteControl,cameraControl:message.cameraControl,cameraEnabled:message.cameraEnabled,
        peerName:peerName(message.peerName),peerAvatar:peerAvatar(message.peerAvatar)};
      return message.type==='notify'?host.notifyIncoming(options):host.dialog(message.kind,options);
    }).then(value=>reply('result',value),()=>reply('error'));
    function reply(type,value) {
      if(pending!==task)return;pending=null;
      if(!closed)pipe.send({id:task.id,type,value});
    }
  },()=>{closed=true;clear();});
  return {
    dispose:()=>pipe.close(),
    setLocked(value){if(typeof value!=='boolean')throw new TypeError('Call lock must be boolean');locked=value;if(value)clear();},
    render(frame,source){if(closed || locked || !host)throw new Error('Call display unavailable');return host.render(frame,source);},
    clearVideo(source){return host?.clearVideo(source);}
  };
}
module.exports={createCallUIClient,attachCallUIHost};
