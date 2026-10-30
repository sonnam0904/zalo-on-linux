'use strict';
const {attachCallUIHost}=require('./call-ui-pipe.cjs');
const {attachVideoPipeReceiver}=require('./video-pipe.cjs');
const createWindow=require('./call-window.cjs');
module.exports=function attachDesktopCallWindow(controlStream,videoStream,electron,options,previewStream) {
  const host=attachCallUIHost(controlStream,()=>createWindow(electron),options);
  const receiver=videoStream?attachVideoPipeReceiver(videoStream,{render:frame=>host.render(frame),clear:()=>host.clearVideo()}):null;
  const preview=previewStream?attachVideoPipeReceiver(previewStream,{render:frame=>host.render(frame,'local'),clear:()=>host.clearVideo('local')}):null;
  if(videoStream) {
    videoStream.once('close',()=>host.dispose());videoStream.once('end',()=>host.dispose());
  }
  if(previewStream){previewStream.once('close',()=>host.dispose());previewStream.once('end',()=>host.dispose());}
  controlStream.once('close',()=>{receiver?.close();preview?.close();});
  return {setLocked:host.setLocked,dispose(){host.dispose();receiver?.close();preview?.close();}};
};
