import {i420ToRgba} from './i420-rgba.mjs';
// Caller owns the canvas and must join runRemoteVideo before removing it.
// Keep the actual decoded dimensions; CSS may letterbox the canvas separately.
export function createCanvasVideoRenderer(canvas,ImageDataClass=globalThis.ImageData) {
  const context=canvas?.getContext('2d',{alpha:false});
  if(!context || typeof ImageDataClass!=='function')throw new Error('CPU video canvas unavailable');
  let disposed=false;
  const clear=()=>{context.clearRect(0,0,canvas.width,canvas.height);};
  return {
    render(frame) {
      if(disposed)throw new Error('Video renderer disposed');
      if(frame.format!=='I420')throw new Error('Unsupported video format');
      const rgba=i420ToRgba(frame.pixels,frame.width,frame.height);
      try {
        if(canvas.width!==frame.width)canvas.width=frame.width;
        if(canvas.height!==frame.height)canvas.height=frame.height;
        context.putImageData(new ImageDataClass(rgba,frame.width,frame.height),0,0);
      } finally {rgba.fill(0);}
    },
    clear,
    dispose(){if(!disposed){clear();disposed=true;}}
  };
}
