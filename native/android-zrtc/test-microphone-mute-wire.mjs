import assert from 'node:assert/strict';
import {encodeCommand} from './worker-client.mjs';
for(const muted of [true,false]) {
  const frame=encodeCommand(9,'microphoneMute',{muted});
  assert.equal(frame.length,16);assert.equal(frame.readUInt32LE(0),12);
  assert.equal(frame.readUInt32LE(4),9);assert.equal(frame.readUInt32LE(8),17);
  assert.equal(frame.readUInt32LE(12),muted?1:0);
}
for(const config of [null,{},[],{muted:1},{muted:'true'},{muted:true,extra:1}])
  assert.throws(()=>encodeCommand(9,'microphoneMute',config));
console.log('PASS mute wire: exact bounded command 17 and strict boolean validation');
