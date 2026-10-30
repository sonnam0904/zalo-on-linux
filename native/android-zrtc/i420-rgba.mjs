// CPU fallback, planar I420 -> opaque RGBA, limited-range BT.601.
// Color-space negotiation/rotation must be handled by the call display owner.
// No browser or Node dependencies; usable in a renderer or unit tests.
export function i420ToRgba(pixels,width,height) {
  if(!(pixels instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) ||
    width<2 || height<2 || width>1920 || height>1080 || width%2 || height%2 ||
    pixels.length!==width*height*3/2)throw new TypeError('Invalid I420 image');
  const ySize=width*height,uvSize=ySize/4,out=new Uint8ClampedArray(ySize*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const index=y*width+x,uv=(y>>1)*(width>>1)+(x>>1);
    const c=pixels[index]-16,d=pixels[ySize+uv]-128,e=pixels[ySize+uvSize+uv]-128;
    out[index*4]=(298*c+409*e+128)>>8;
    out[index*4+1]=(298*c-100*d-208*e+128)>>8;
    out[index*4+2]=(298*c+516*d+128)>>8;
    out[index*4+3]=255;
  }
  return out;
}
