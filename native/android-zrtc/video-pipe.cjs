'use strict';
// Dedicated inherited duplex pipe only. No media enters signaling/log routes.
const MAX=1920*1080*3/2;
function encode(id,frame) {
  const size=frame?frame.pixels.length:0;
  if(frame && (frame.format!=='I420' || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
    frame.width<2 || frame.height<2 || frame.width>1920 || frame.height>1080 || frame.width%2 || frame.height%2 ||
    !Buffer.isBuffer(frame.pixels) || size!==frame.width*frame.height*3/2 || typeof frame.sequence!=='bigint' ||
    frame.sequence<1n || frame.sequence>0xffffffffffffffffn))throw new Error('Invalid video pipe frame');
  const packet=Buffer.alloc(28+size);
  packet.writeUInt32LE(24+size);packet.writeUInt32LE(id,4);packet.writeUInt32LE(frame?1:0,8);
  if(frame){packet.writeUInt32LE(frame.width,12);packet.writeUInt32LE(frame.height,16);packet.writeBigUInt64LE(frame.sequence,20);frame.pixels.copy(packet,28);}
  return packet;
}
function createVideoPipeSink(stream,{timeoutMs=5000}={}) {
  let id=0,pending,ack=Buffer.alloc(0),closed=false,canceled=false;
  const listeners=new Set();
  const cancellations=new Set();
  const fail=()=>{
    const first=!closed;
    closed=true;
    if(pending){clearTimeout(pending.timer);pending.reject(new Error('Video display pipe closed'));pending=null;}
    if(first)for(const callback of listeners)callback();
  };
  stream.on('error',fail);stream.on('close',fail);stream.on('end',fail);
  stream.on('data',chunk=>{
    if(closed)return;
    if(ack.length+chunk.length>1024){fail();stream.destroy();return;}
    ack=Buffer.concat([ack,chunk]);
    while(ack.length>=4){
      const value=ack.readUInt32LE();ack=ack.subarray(4);
      // Zero is a call-cancel control, never a frame request ID.
      if(value===0){if(!canceled){canceled=true;for(const callback of cancellations)callback();}continue;}
      if(!pending || value!==pending.id){fail();stream.destroy();return;}
      const completed=pending;pending=null;if(completed.clear)canceled=false;
      clearTimeout(completed.timer);completed.resolve();
    }
  });
  const send=frame=>{
    if(closed)return Promise.reject(new Error('Video display pipe closed'));
    if(frame && canceled)return Promise.reject(new Error('Video call canceled'));
    if(pending)return Promise.reject(new Error('Video display already processing a frame'));
    if(id===0xffffffff)return Promise.reject(new Error('Video pipe sequence exhausted'));
    const packet=encode(++id,frame);
    return new Promise((resolve,reject)=>{
      pending={id,clear:!frame,resolve,reject,timer:setTimeout(()=>{fail();stream.destroy();},timeoutMs)};
      stream.write(packet,error=>{packet.fill(0);if(error){fail();stream.destroy();}});
    });
  };
  return {render:send,clear:()=>send(null),close:()=>{fail();stream.destroy();},
    onCancel(callback){cancellations.add(callback);if(canceled)callback();return ()=>cancellations.delete(callback);},
    onClose(callback){listeners.add(callback);if(closed)callback();return ()=>listeners.delete(callback);}};
}
function attachVideoPipeReceiver(stream,{render,clear}) {
  let buffer=Buffer.alloc(0),busy=false,closed=false,lastId=0;
  const fail=()=>{closed=true;buffer.fill(0);buffer=Buffer.alloc(0);stream.destroy();};
  stream.on('error',fail);stream.on('close',()=>{closed=true;buffer.fill(0);buffer=Buffer.alloc(0);});
  stream.on('end',fail);
  stream.on('data',chunk=>{
    if(closed)return;
    if(busy || buffer.length+chunk.length>MAX+28){fail();return;}
    buffer=Buffer.concat([buffer,chunk]);
    if(buffer.length<4)return;
    const length=buffer.readUInt32LE();
    if(length<24 || length>MAX+24){fail();return;}
    if(buffer.length<length+4)return;
    if(buffer.length!==length+4){fail();return;}
    const packet=buffer;buffer=Buffer.alloc(0);
    const id=packet.readUInt32LE(4),kind=packet.readUInt32LE(8),width=packet.readUInt32LE(12),height=packet.readUInt32LE(16),sequence=packet.readBigUInt64LE(20);
    let frame;
    try {
      if(id!==lastId+1 || kind>1)throw Error();
      if(kind) {frame={format:'I420',width,height,sequence,pixels:packet.subarray(28)};const checked=encode(id,frame);checked.fill(0);}
      else if(length!==24 || width || height || sequence)throw Error();
    } catch {packet.fill(0);fail();return;}
    lastId=id;busy=true;
    Promise.resolve().then(()=>closed?undefined:frame?render(frame):clear()).then(()=>{
      packet.fill(0);busy=false;
      if(!closed){const ack=Buffer.alloc(4);ack.writeUInt32LE(id);stream.write(ack);}
    },()=>{packet.fill(0);busy=false;fail();});
  });
  return {close:fail};
}
module.exports={createVideoPipeSink,attachVideoPipeReceiver};
