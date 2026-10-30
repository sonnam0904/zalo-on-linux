import assert from 'node:assert/strict';
import {decodeVideoSnapshot} from './video-snapshot.mjs';
import {encodeCommand} from './worker-client.mjs';
const sample={format:'I420',width:2,height:2,sequence:'1',pixels:Buffer.from([1,2,3,4,5,6]).toString('base64')};
const reply=data=>({code:0,data:JSON.stringify(data)});
assert.deepEqual(decodeVideoSnapshot(reply(sample)),{...sample,sequence:1n,pixels:Buffer.from([1,2,3,4,5,6])});
assert.equal(decodeVideoSnapshot({code:-61}),null);
for(const value of [null,[],{}, {...sample,width:3},{...sample,height:1082},{...sample,format:'NV12'},
  {...sample,sequence:'0'},{...sample,sequence:'18446744073709551616'},{...sample,pixels:'!!!!!!!!'},
  {...sample,pixels:'AQIDBA=='},{...sample,sequence:1}])assert.throws(()=>decodeVideoSnapshot(reply(value)));
assert.throws(()=>decodeVideoSnapshot({code:-95}));
assert.throws(()=>decodeVideoSnapshot({code:0,data:'{'}));
assert.equal(encodeCommand(1,'videoSnapshot').readUInt32LE(8),15);
assert.throws(()=>encodeCommand(1,'videoSnapshot',{unexpected:true}));
const large={...sample,width:1920,height:1080,pixels:Buffer.alloc(1920*1080*3/2,127).toString('base64')};
assert.equal(decodeVideoSnapshot(reply(large)).pixels.length,1920*1080*3/2);
console.log('PASS video snapshot: strict I420/base64/dimensions/sequence, empty state, opcode, 1080p bound');
