import assert from 'node:assert/strict';
import {desktopVoiceConfig,startDesktopVoice} from './desktop-config.mjs';
import {NativeWorker} from './worker-client.mjs';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const config={fromId:'123',toId:'456',protocol:1,callId:789,clientVersion:'681',sessId:'fixture',
  settings:{},zrtc_config:{},servers:[],rtpIP:'127.0.0.1:9000',rtcpIP:'127.0.0.1:9001',
  audioConfig:JSON.stringify([{name:'opus/16000/1',payload:112,frmPtime:20,dynamicFptime:0}]),extendData:'{}',video:{enable:1}};
const caller={role:'caller',video:false},callee={role:'callee',video:false};
assert.equal(desktopVoiceConfig(config,caller).configuration.userId,123);
assert.throws(()=>desktopVoiceConfig({...config,fromId:'18446744073709551615'},caller),/uint32/);
assert.throws(()=>desktopVoiceConfig(config,{role:'caller'}),/video/);
assert.throws(()=>desktopVoiceConfig({...config,zrtc_config:undefined},caller),/call object/);
assert.throws(()=>desktopVoiceConfig({...config,rtpIP:'localhost:9000'},callee),/address/);
assert.throws(()=>desktopVoiceConfig({...config,changeZRTP:{enable:1}},caller),/switching/);
let mutated=false;
await assert.rejects(startDesktopVoice({request(){mutated=true;}},{...config,sessId:''},caller),/string/);
assert.equal(mutated,false);
// Compare mappings against the actual legacy desktop wrapper. The native
// binding is a spy here; real engine execution is tested separately below.
const recorded={};
const native=new Proxy({}, {get:(_,name)=>(...args)=>recorded[name]=args});
const context={module:{exports:{}},console:{log(){},error(){}},process,
  require(name) {
    if(name==='./binding.js') return {MainApp:()=>native};
    if(name==='electron') return {remote:{app:{getPath:()=>'/tmp'}}};
    if(name==='os' || name==='path') return require(name);
    throw new Error('Unexpected legacy dependency');
  }};
vm.runInNewContext(await readFile(new URL('../nativelibs/zcall/vcmac.js',import.meta.url),'utf8'),context);
await context.module.exports.setConfigData(config,true,false);
const mapped=desktopVoiceConfig(config,caller);
assert.deepEqual(Array.from(recorded.setConfig).slice(0,7),[
  mapped.configuration.settings,config.fromId,config.toId,config.protocol,
  config.callId,mapped.configuration.session,mapped.configuration.zrtcConfig,
]);
assert.equal(recorded.setListServers[0],mapped.arguments.servers);
// Local media mode comes from caller intent, not the response's video flag.
assert.equal(recorded.setConfig[8],false);
await context.module.exports.setConfigData(config,false,false);
assert.deepEqual(Array.from(recorded.setConfigServer),[config.rtcpIP,config.rtpIP]);
assert.deepEqual(Array.from(recorded.setMediaConfig),[config.audioConfig,config.extendData]);
const worker=await NativeWorker.start(process.argv[2]);
try {
  const active=startDesktopVoice(worker,config,caller);
  await assert.rejects(startDesktopVoice(worker,config,callee),/busy/);
  assert.equal((await active).code,0);await worker.request('stop');
  for(const options of [caller,callee,caller,callee]) {
    const attempt=await startDesktopVoice(worker,config,options);
    assert.equal(attempt.code,0);assert.equal(attempt.callReady,false);assert.equal(attempt.offline,true);
    assert.equal((await worker.request('stop')).code,0);
  }
} finally {assert.deepEqual(await worker.close(),{code:0,signal:null});}
console.log('PASS desktop config -> native caller/callee: legacy wrapper parity, configuration race guard, 5 offline attempts and clean stop; no live signaling');
