// Convert the existing NV21 (VU) capture to a small I420 preview. No second capture,
// renderer getUserMedia, disk file or signaling route is involved.
export function previewFrame(pixels,width,height,sequence) {
  if(!Buffer.isBuffer(pixels) || width!==640 || height!==480 || pixels.length!==width*height*3/2 ||
    typeof sequence!=='bigint' || sequence<1n)throw new TypeError('Invalid local preview frame');
  const w=160,h=120,output=Buffer.alloc(w*h*3/2),uv=width*height;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)output[y*w+x]=pixels[y*4*width+x*4];
  for(let y=0;y<h/2;y++)for(let x=0;x<w/2;x++) {
    const source=uv+y*4*width+x*8,target=y*w/2+x;
    output[w*h+target]=pixels[source+1];output[w*h*5/4+target]=pixels[source];
  }
  return {format:'I420',width:w,height:h,sequence,pixels:output};
}
