import assert from 'node:assert/strict';
import {previewFrame} from './local-preview.mjs';
const source=Buffer.alloc(640*480*3/2),ySize=640*480;
for(let y=0;y<480;y++)for(let x=0;x<640;x++)source[y*640+x]=(x+y)%256;
// NV21 stores V then U. The I420 preview must expose U then V planes.
for(let i=ySize;i<source.length;i+=2){source[i]=61;source[i+1]=193;}
const frame=previewFrame(source,640,480,123n);
assert.equal(frame.width,160);assert.equal(frame.height,120);assert.equal(frame.sequence,123n);
for(let y=0;y<120;y++)for(let x=0;x<160;x++)assert.equal(frame.pixels[y*160+x],(x*4+y*4)%256);
assert.ok(frame.pixels.subarray(160*120,160*120*5/4).every(v=>v===193));
assert.ok(frame.pixels.subarray(160*120*5/4).every(v=>v===61));
frame.pixels.fill(0);assert.equal(source[ySize],61,'Preview clearing must not mutate capture input');
assert.throws(()=>previewFrame(Buffer.alloc(10),640,480,1n),/Invalid/);
assert.throws(()=>previewFrame(source,640,480,0n),/Invalid/);
console.log('PASS local preview: bounded downscale, NV21 VU -> I420 UV chroma order, independent pixel ownership, validation');
