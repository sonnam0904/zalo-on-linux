// Pull-only transport: no unbounded decoded-frame event queue. Never log data.
export function decodeVideoSnapshot(reply) {
  if(reply?.code===-61)return null; // ENODATA: no current-call image
  if(reply?.code!==0 || typeof reply.data!=='string')throw new Error('Native video snapshot failed');
  const data=JSON.parse(reply.data);
  if(!data || typeof data!=='object' || Array.isArray(data))throw new Error('Invalid native video snapshot');
  const {width,height,sequence,pixels,format}=data;
  if(format!=='I420' || !Number.isInteger(width) || width<2 || width>1920 || width%2 ||
    !Number.isInteger(height) || height<2 || height>1080 || height%2 ||
    typeof sequence!=='string' || !/^[1-9][0-9]{0,19}$/.test(sequence) || BigInt(sequence)>0xffffffffffffffffn ||
    typeof pixels!=='string' || pixels.length!==4*Math.ceil(width*height*3/2/3))
    throw new Error('Invalid native video snapshot');
  const bytes=Buffer.from(pixels,'base64');
  if(bytes.length!==width*height*3/2 || bytes.toString('base64')!==pixels)throw new Error('Invalid I420 pixels');
  return {width,height,sequence:BigInt(sequence),pixels:bytes,format};
}
