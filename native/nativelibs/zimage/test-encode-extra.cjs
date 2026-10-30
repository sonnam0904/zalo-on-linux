const assert=require('node:assert/strict');
const encode=require('./encode-extra.cjs');
(async()=>{
  for(const format of ['webp','gif'])for(const mode of ['ok','error','wrong-format']) {
    let writes=0;
    const output=Buffer.from(format==='webp'?'RIFF0000WEBPfixture':'GIF89a0000fixture');
    const pending=encode(Buffer.from('normalized PNG'),format,80,{execFile(command,args,options,callback){
      assert.equal(command,'ffmpeg');assert.equal(options.timeout,30000);assert.equal(options.maxBuffer,32*1024*1024);
      assert.equal(args[args.indexOf('-protocol_whitelist')+1],'pipe');
      assert.equal(args[args.indexOf('-frames:v')+1],'1');
      assert.equal(args.at(-1),'pipe:1');assert.ok(!args.some(arg=>arg.includes('/tmp/')));
      queueMicrotask(()=>callback(mode==='error'?new Error('private process details'):null,mode==='wrong-format'?Buffer.from('PNG'):output));
      return {stdin:{on(){},end(input){assert.equal(input.toString(),'normalized PNG');writes++;}}};
    }});
    if(mode==='ok')assert.deepEqual(await pending,output);
    else await assert.rejects(pending,error=>!error.message.includes('private'));
    assert.equal(writes,1);
  }
  for(const [input,format,quality] of [[null,'gif',80],[Buffer.alloc(1),'jpeg',80],[Buffer.alloc(1),'webp',Infinity]])
    await assert.rejects(encode(input,format,quality),/Invalid/);
  console.log('PASS extra encoders: fixed pipe argv, single frame, bounded process, correct format gate, no raw process errors');
})().catch(error=>{console.error(error);process.exitCode=1;});
