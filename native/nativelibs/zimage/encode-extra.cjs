'use strict';
// nativeImage only encodes PNG/JPEG. Encode a single, already-normalized PNG
// frame through bounded pipes; never mislabel PNG bytes as WebP/GIF.
module.exports=function encodeExtra(png,format,quality,{execFile=require('node:child_process').execFile}={}) {
  if(!Buffer.isBuffer(png) || png.length>32*1024*1024 || !['webp','gif'].includes(format) ||
    !Number.isInteger(quality) || quality<1 || quality>100)return Promise.reject(new Error('Invalid thumbnail encoder input'));
  const args=['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','pipe',
    '-f','image2pipe','-c:v','png','-i','pipe:0','-frames:v','1','-threads','1',
    '-c:v',format==='webp'?'libwebp':'gif',...(format==='webp'?['-quality',String(quality)]:[]),
    '-f','image2pipe','pipe:1'];
  return new Promise((resolve,reject)=>{
    const child=execFile('ffmpeg',args,{encoding:'buffer',timeout:30000,killSignal:'SIGKILL',maxBuffer:32*1024*1024},(error,stdout)=>{
      if(error)return reject(new Error('Thumbnail encoder unavailable or failed'));
      const valid=Buffer.isBuffer(stdout) && (format==='webp'?
        stdout.length>=12 && stdout.toString('ascii',0,4)==='RIFF' && stdout.toString('ascii',8,12)==='WEBP':
        stdout.length>=10 && ['GIF87a','GIF89a'].includes(stdout.toString('ascii',0,6)));
      if(!valid)return reject(new Error('Thumbnail encoder returned an invalid format'));
      resolve(stdout);
    });
    // Early encoder failure can close stdin; execFile's completion reports it.
    child.stdin.on('error',()=>{});child.stdin.end(png);
  });
};
