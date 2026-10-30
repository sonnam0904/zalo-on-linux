'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const parent=path.join(os.homedir(),'zalo-native-recovery');fs.mkdirSync(parent,{recursive:true});
const fixture=fs.mkdtempSync(path.join(parent,'vips-temp-fixture-'));
const original=Module._load;let mode='success',lastFile;
Module._load=function(request,...args) {
  if(request==='electron')return {};
  if(request==='sharp')throw new Error('Fixture disables optional sharp');
  if(request==='os')return {...os,homedir:()=>fixture};
  if(request==='child_process')return {spawnSync(command,args,options){
    assert.equal(command,'vips');
    if(args[0]==='--version')return {status:0};
    lastFile=args[2];
    assert.ok(lastFile.startsWith(path.join(fixture,'.cache/zalo-native/thumbnails/image-')));
    assert.equal(fs.statSync(path.dirname(lastFile)).mode&0o777,0o700);
    assert.deepEqual(options.input,Buffer.from('synthetic input'));
    fs.writeFileSync(lastFile,'synthetic output');
    if(mode==='throw')throw new Error('Fixture spawn failure');
    return {status:mode==='success'?0:1};
  }};
  return original.call(this,request,...args);
};
(async()=>{
  try {
    const {Image}=await require('./linux.js')();
    for(mode of ['success','failure','throw']) {
      const task=Image.thumbnail(Buffer.from('synthetic input'),20,20,'png',80);
      assert.equal(typeof task.then,'function','CLI failures use the async API');
      if(mode==='success')assert.equal((await task).toString(),'synthetic output');else await assert.rejects(task);
      assert.equal(fs.existsSync(lastFile),false);assert.equal(fs.existsSync(path.dirname(lastFile)),false);
    }
    console.log('PASS vips temporary storage: private home directory, async API, cleanup after success/failure/thrown spawn; codec mocked');
    console.log(`Synthetic fixture retained: ${fixture}`);
  } finally {Module._load=original;}
})().catch(error=>{console.error(error);process.exitCode=1;});
