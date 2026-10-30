'use strict';
// Real Electron nativeImage; synthetic pixels only, no account or windows.
const assert=require('node:assert/strict');
const {app,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const parent=path.join(app.getPath('home'),'zalo-native-recovery');fs.mkdirSync(parent,{recursive:true});
const fixture=fs.mkdtempSync(path.join(parent,'zimage-fixture-'));
app.setPath('userData',fixture);
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
  const {Image}=await require('./index.js')(null);
  for(const [width,height,boundW,boundH,expected] of [
    [80,40,20,20,{width:20,height:10}],
    [40,80,20,20,{width:10,height:20}],
    [80,40,60,10,{width:20,height:10}],
    [8,4,20,20,{width:8,height:4}],
  ])for(const format of ['png','jpeg','webp','gif']) {
    const source=nativeImage.createFromBitmap(Buffer.alloc(width*height*4,255),{width,height}).toPNG();
    const output=await Image.thumbnail(source,boundW,boundH,format,80);
    let decoded=output;
    if(format==='webp' || format==='gif') {
      assert.equal(output.toString('ascii',0,4),format==='webp'?'RIFF':'GIF8');
      const result=require('node:child_process').spawnSync('ffmpeg',[
        '-hide_banner','-loglevel','error','-i','pipe:0','-frames:v','1','-c:v','png','-f','image2pipe','pipe:1'
      ],{input:output,timeout:10000,maxBuffer:1024*1024});
      assert.equal(result.status,0,'Real decoder must accept encoded thumbnail');decoded=result.stdout;
    }
    assert.deepEqual(nativeImage.createFromBuffer(decoded).getSize(),expected,`${format} ${width}x${height} inside ${boundW}x${boundH}`);
  }
  await assert.rejects(Image.thumbnail(Buffer.from('not an image'),20,20,'png',80));
  const input=path.join(fixture,'synthetic-input.png'),output=path.join(fixture,'synthetic-output.png');
  fs.writeFileSync(input,nativeImage.createFromBitmap(Buffer.alloc(8*4*4,255),{width:8,height:4}).toPNG());
  let callbacks=0;
  await Image.resizeQA(input,output,4,4,80,null,(error,result)=>{
    assert.ifError(error);assert.ok(Buffer.isBuffer(result));callbacks++;
  });
  assert.equal(callbacks,1);
  assert.deepEqual(nativeImage.createFromBuffer(fs.readFileSync(output)).getSize(),{width:4,height:2});
  await assert.rejects(Image.resizeQA(input,fixture,4,4,80));
  await Image.resizeQA(path.join(fixture,'missing.png'),output,4,4,80,null,error=>{
    assert.equal(error.code,'ENOENT');callbacks++;
  });
  assert.equal(callbacks,2);
  console.log('PASS real Electron zimage: proportional bounds, no enlargement, PNG/JPEG/WebP/GIF roundtrip and invalid input');
  console.log('PASS real zimage files: callback output decode, write failure rejection and missing-input callback; synthetic files retained under home');
  app.exit(0);
}).catch(error=>{console.error(error.message);app.exit(1);});
