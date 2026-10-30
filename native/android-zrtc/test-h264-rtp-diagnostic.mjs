import assert from 'node:assert/strict';
import {h264RtpToAnnexB as decode} from './h264-rtp-diagnostic.mjs';
function rtp(bytes,seq=0) {
  const header=Buffer.alloc(12);header[0]=128;header[1]=97;header.writeUInt16BE(seq,2);
  header.writeUInt32BE(123,4);header.writeUInt32BE(456,8);
  return Buffer.concat([header,Buffer.from(bytes)]);
}
assert.equal(decode([rtp([0x65,1,2])]).toString('hex'),'00000001650102');
assert.equal(decode([rtp([0x78,0,2,0x67,1,0,2,0x68,2])]).toString('hex'),'000000016701000000016802');
assert.equal(decode([rtp([0x7c,0x85,1],65535),rtp([0x7c,0x45,2],0)]).toString('hex'),'00000001650102');
for(const payload of [[0x78],[0x78,0],[0x78,0,5,0x67],[0x7c,0xc5,1],[0x7c,0x45,1],[0xff]])
  assert.throws(()=>decode([rtp(payload)]));
assert.throws(()=>decode([rtp([0x7c,0x85,1])]),/Incomplete/);
assert.throws(()=>decode([rtp([0x65]),rtp([0x61],2)]),/sequence/);
const changed=rtp([0x61],1);changed.writeUInt32BE(789,8);
assert.throws(()=>decode([rtp([0x65]),changed]),/sources/);
const padded=Buffer.concat([rtp([0x65]),Buffer.from([0,2])]);padded[0]|=32;
assert.equal(decode([padded]).toString('hex'),'0000000165');
padded[padded.length-1]=0;assert.throws(()=>decode([padded]),/padding/);
const extension=Buffer.concat([rtp([]),Buffer.from([0xbe,0xde,0,1,0,0,0,0,0x65])]);extension[0]|=16;
assert.equal(decode([extension]).toString('hex'),'0000000165');
extension.writeUInt16BE(2,14);assert.throws(()=>decode([extension]),/extension/);
console.log('PASS strict RTP/H.264 diagnostic: single NAL, STAP-A, FU-A, wrap, extension/padding and malformed/loss guards');
const dialect={packetization:'zrtc-annexb'};
const key=rtp([0,0,0,1,0x67,1,0,0,1,0x68,2,0,0,0,1,0x65,3]);key[1]=128|98;
const delta=rtp([0,0,0,1,0x41,4],1);delta[1]|=128;
assert.equal(decode([key,delta],dialect).toString('hex'),'000000016701000000016802000000016503000000014104');
assert.throws(()=>decode([key]),/payload type/);
const unmarked=Buffer.from(key);unmarked[1]&=127;
assert.throws(()=>decode([unmarked],dialect),/Unfragmented/);
for(const bytes of [[0x65,3],[0,0,0,1],[0,0,1,0xff]]) {
  const p=rtp(bytes);p[1]|=128;
  assert.throws(()=>decode([p],dialect));
}
const gap=Buffer.from(delta);gap.writeUInt16BE(3,2);
assert.throws(()=>decode([key,gap],dialect),/sequence/);
assert.throws(()=>decode([key],{packetization:'guess'}),/Unknown/);
console.log('PASS explicit ZRTC Annex-B dialect: PT 98 keyframe / PT 97 delta, mixed start codes, marker and malformed guards');
function zfragment(bytes,seq,flags,marker=false,pt=98) {
  const p=rtp([0x1c,flags,...bytes],seq);p[1]=pt|(marker?128:0);return p;
}
const first=zfragment([0,0],0,128),middle=zfragment([0,1,0x67],1,0),last=zfragment([1,2],2,64,true);
assert.equal(decode([first,middle,last],dialect).toString('hex'),'00000001670102');
assert.throws(()=>decode([middle,last],dialect),/Unmatched/);
assert.throws(()=>decode([first,last],dialect),/sequence/);
assert.throws(()=>decode([first,middle],dialect),/Incomplete/);
assert.throws(()=>decode([zfragment([1],0,192,true)],dialect),/flags/);
assert.throws(()=>decode([zfragment([1],0,128,true)],dialect),/flags/);
assert.throws(()=>decode([zfragment([1],0,129)],dialect),/header/);
assert.throws(()=>decode([first,zfragment([1],1,64,false)],dialect),/flags/);
const changedTime=Buffer.from(middle);changedTime.writeUInt32BE(999,4);
assert.throws(()=>decode([first,changedTime,last],dialect),/Unmatched/);
assert.throws(()=>decode([first,zfragment([1],1,64,true,97)],dialect),/Unmatched/);
console.log('PASS ZRTC fragmented Annex-B: split prefix, reassembly, loss, truncation, timestamp/type and marker guards');
