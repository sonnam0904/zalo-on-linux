// Strict ordered-loopback diagnostic, not a production jitter buffer.
// RFC 3550 §5.1 and RFC 6184 §5.6–5.8. No SRTP or interleaved mode.
const start=Buffer.from([0,0,0,1]);
export function h264RtpToAnnexB(packets,{payloadType=97,packetization='rfc6184'}={}) {
  if(!['rfc6184','zrtc-annexb'].includes(packetization))throw new Error('Unknown packetization');
  let sequence,ssrc,fragment=null,zrtcFragment=null,size=0;
  const output=[];
  const emit=nal=>{
    if(!nal.length || (nal[0]&128) || (nal[0]&31)<1 || (nal[0]&31)>23)throw new Error('Invalid NAL');
    size+=nal.length+4;if(size>16*1024*1024)throw new Error('Diagnostic stream exceeds limit');
    output.push(start,nal);
  };
  for(const packet of packets) {
    if(!Buffer.isBuffer(packet) || packet.length<12 || packet[0]>>>6!==2)throw new Error('Invalid RTP header');
    const typeId=packet[1]&127;
    // Observed pinned ZRTC dialect: PT 97 delta frames, PT 98 keyframes,
    // Annex-B access units, optionally wrapped in a custom type-0 FU-A. Never auto-detect it
    // as RFC 6184; caller must explicitly opt into this fixture diagnostic.
    if(packetization==='zrtc-annexb' ? ![97,98].includes(typeId) : typeId!==payloadType)
      throw new Error('Unexpected RTP payload type');
    const seq=packet.readUInt16BE(2),stamp=packet.readUInt32BE(4),source=packet.readUInt32BE(8);
    if(ssrc!==undefined && ssrc!==source)throw new Error('Mixed RTP sources');
    if(sequence!==undefined && seq!==((sequence+1)&65535))throw new Error('RTP sequence gap or reorder');
    ssrc=source;sequence=seq;
    let offset=12+4*(packet[0]&15),end=packet.length;
    if(offset>end)throw new Error('Truncated RTP CSRC');
    if(packet[0]&16) {
      if(offset+4>end)throw new Error('Truncated RTP extension');
      offset+=4+4*packet.readUInt16BE(offset+2);
      if(offset>end)throw new Error('Truncated RTP extension');
    }
    if(packet[0]&32) {
      const padding=packet[end-1];
      if(!padding || padding>end-offset)throw new Error('Invalid RTP padding');
      end-=padding;
    }
    let payload=packet.subarray(offset,end);
    if(packetization==='zrtc-annexb') {
      if(payload[0]===0x1c) {
        // Observed dialect wraps the complete Annex-B byte stream, retaining
        // its prefix. Unlike RFC 6184 FU-A, no NAL header byte is reconstructed.
        if(payload.length<=2 || (payload[1]&63))throw new Error('Invalid ZRTC fragment header');
        const begin=!!(payload[1]&128),last=!!(payload[1]&64);
        if(begin && last || last!==!!(packet[1]&128))throw new Error('Invalid ZRTC fragment flags');
        if(begin) {
          if(zrtcFragment)throw new Error('Incomplete ZRTC access unit');
          zrtcFragment={stamp,typeId,parts:[],size:0};
        } else if(!zrtcFragment || zrtcFragment.stamp!==stamp || zrtcFragment.typeId!==typeId)
          throw new Error('Unmatched ZRTC fragment');
        zrtcFragment.parts.push(payload.subarray(2));zrtcFragment.size+=payload.length-2;
        if(zrtcFragment.size>4*1024*1024)throw new Error('ZRTC access unit exceeds limit');
        if(!last)continue;
        payload=Buffer.concat(zrtcFragment.parts);zrtcFragment=null;
      } else {
        if(zrtcFragment)throw new Error('Incomplete ZRTC access unit');
        if(!(packet[1]&128))throw new Error('Unfragmented ZRTC access unit required');
      }
      const codes=[];
      for(let at=0;at+2<payload.length;at++) {
        if(payload[at]===0 && payload[at+1]===0) {
          const length=payload[at+2]===1 ? 3 : at+3<payload.length && payload[at+2]===0 && payload[at+3]===1 ? 4 : 0;
          if(length) {codes.push({at,length});at+=length-1;}
        }
      }
      if(!codes.length || codes[0].at!==0)throw new Error('Missing ZRTC Annex-B prefix');
      for(let n=0;n<codes.length;n++)emit(payload.subarray(codes[n].at+codes[n].length,codes[n+1]?.at??payload.length));
      continue;
    }
    if(!payload.length || payload[0]&128)throw new Error('Invalid H.264 payload');
    const type=payload[0]&31;
    if(type>=1 && type<=23) {
      if(fragment)throw new Error('Incomplete FU-A');
      emit(payload);
    } else if(type===24) {
      if(fragment)throw new Error('Incomplete FU-A');
      let at=1,count=0;
      while(at<payload.length) {
        if(at+2>payload.length)throw new Error('Truncated STAP-A');
        const length=payload.readUInt16BE(at);at+=2;
        if(!length || at+length>payload.length)throw new Error('Invalid STAP-A length');
        emit(payload.subarray(at,at+length));at+=length;count++;
      }
      if(!count)throw new Error('Empty STAP-A');
    } else if(type===28) {
      if(payload.length<2 || payload[1]&32)throw new Error('Invalid FU-A');
      const begin=!!(payload[1]&128),last=!!(payload[1]&64),nal=(payload[0]&224)|(payload[1]&31);
      if(begin && last)throw new Error('Invalid FU-A flags');
      if((nal&31)<1 || (nal&31)>23)throw new Error('Invalid FU-A NAL type');
      if(begin) {
        if(fragment)throw new Error('Incomplete FU-A');
        fragment={stamp,nal,parts:[Buffer.from([nal])],size:1};
      } else if(!fragment || fragment.stamp!==stamp || fragment.nal!==nal)throw new Error('Unmatched FU-A');
      fragment.parts.push(payload.subarray(2));fragment.size+=payload.length-2;
      if(fragment.size>4*1024*1024)throw new Error('FU-A exceeds limit');
      if(last) {emit(Buffer.concat(fragment.parts));fragment=null;}
    } else throw new Error('Unsupported H.264 packetization');
  }
  if(fragment)throw new Error('Incomplete FU-A');
  if(zrtcFragment)throw new Error('Incomplete ZRTC access unit');
  if(!output.length)throw new Error('No H.264 NAL units');
  return Buffer.concat(output);
}
