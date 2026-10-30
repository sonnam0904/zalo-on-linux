import {createCanvasVideoRenderer} from './canvas-video-renderer.mjs';
const renderer=createCanvasVideoRenderer(document.querySelector('canvas'));
window.linuxVideo.onFrame(frame=>{
  renderer.render(frame);document.getElementById('status').hidden=true;
  frame.pixels.fill(0);
});
window.addEventListener('pagehide',()=>renderer.dispose(),{once:true});
