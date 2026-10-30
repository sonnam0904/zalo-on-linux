import assert from 'node:assert/strict';
import {createCanvasVideoRenderer} from './canvas-video-renderer.mjs';
let cleared=0,image;
const canvas={width:1,height:1,getContext(type,options){
  assert.equal(type,'2d');assert.deepEqual(options,{alpha:false});
  return {clearRect:()=>{cleared++;},putImageData:data=>{image={...data,pixels:Uint8ClampedArray.from(data.pixels)};}};
}};
class FakeImageData {constructor(pixels,width,height){Object.assign(this,{pixels,width,height});}}
const renderer=createCanvasVideoRenderer(canvas,FakeImageData);
const frame={format:'I420',width:2,height:2,pixels:new Uint8Array([16,16,235,235,128,128])};
renderer.render(frame);
assert.equal(canvas.width,2);assert.equal(canvas.height,2);
assert.deepEqual([...image.pixels],[0,0,0,255,0,0,0,255,255,255,255,255,255,255,255,255]);
renderer.clear();renderer.dispose();renderer.dispose();assert.equal(cleared,2);
assert.throws(()=>renderer.render(frame),/disposed/);
assert.throws(()=>createCanvasVideoRenderer({getContext:()=>null},FakeImageData),/unavailable/);
console.log('PASS canvas adapter: decoded dimensions, RGBA delivery, idempotent dispose, no post-dispose render (mock context)');
