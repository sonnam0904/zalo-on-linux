import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {CALL_EVENTS, MEDIA_STATES} from './protocol-enums.mjs';
const exec = promisify(execFile);
async function validateDevices(pcm) {
  await Promise.all([['source','sources'],['sink','sinks']].map(async ([key,kind])=>{
    const result=await exec('pactl',['--format=json','list',kind],{timeout:3000,maxBuffer:2*1024*1024});
    const rows=JSON.parse(result.stdout);
    if(!Array.isArray(rows) || !rows.some(row=>row.name===pcm[key])) throw new Error('Selected PCM device is unavailable');
  }));
}
// Connection diagnostics: numeric engine events, plus engine stats/log text with
// IPs and long numbers redacted, bounded in size and rate.
const TRACE_EVENTS=new Set(['onCallState','onCallAutoHangup','onCallErr','onCallQualityChanged','onCallUpdateP2PStatus','onCallAudioState','onCallVideoState']);
const TEXT_EVENTS=new Set(['onCallStats','onCallLog']);
let lastText=0;
// Dead-relay watchdog: once confirmed, two consecutive stats reports with no inbound
// media at all (audio and video) means the relay path is not delivering to us.
export const callHealth=new EventEmitter();
const health={confirmed:false,zeroReports:0,fired:false};
export function watchHealth(message) {
  if(message.event==='onCallState') {
    const state=message.args[0];
    if(state===5){health.confirmed=true;health.zeroReports=0;health.fired=false;}
    else if(state===6||state===3){health.confirmed=false;health.zeroReports=0;}
  } else if(message.event==='onCallStats' && health.confirmed && !health.fired && typeof message.args[0]==='string') {
    let stats;
    try {stats=JSON.parse(message.args[0]);} catch {return;}
    if(!Number.isFinite(stats.inputBw)) return;
    health.zeroReports=stats.inputBw<=5?health.zeroReports+1:0;
    if(health.zeroReports>=2){health.fired=true;callHealth.emit('noInboundMedia');}
  }
}
function traceEvent(message) {
  watchHealth(message);
  if(process.env.ZALO_ZCALL_LOG==='0') return;
  let detail;
  if(TRACE_EVENTS.has(message.event)) detail=JSON.stringify(message.args.filter(Number.isInteger));
  else if(TEXT_EVENTS.has(message.event) && typeof message.args[0]==='string') {
    const now=Date.now();
    if(message.event==='onCallStats' && now-lastText<2500) return;
    if(message.event==='onCallStats') lastText=now;
    detail=message.args[0].replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g,'<ip>').replace(/\d{7,}/g,'<n>')
      .replace(/[\r\n]+/g,' ').slice(0,400);
  } else return;
  try {
    appendFileSync(path.join(homedir(),'.config','ZaloData','zcall-agent.log'),
      `${new Date().toISOString()} [zcall-agent] native event ${message.event} ${detail}\n`);
  } catch {}
}
// A configured device can vanish (HDMI off, Bluetooth switched, webcam unplugged).
// Calls must still work, so fall back to the system default for that side only.
async function resolvePcm(pcm) {
  const out={...pcm};
  await Promise.all([['source','sources','get-default-source'],['sink','sinks','get-default-sink']].map(async ([key,kind,getDefault])=>{
    const result=await exec('pactl',['--format=json','list',kind],{timeout:3000,maxBuffer:2*1024*1024});
    const rows=JSON.parse(result.stdout);
    if(!Array.isArray(rows) || rows.some(row=>row.name===out[key])) return;
    let name=(await exec('pactl',[getDefault],{timeout:3000})).stdout.trim();
    if(!rows.some(row=>row.name===name) || name.endsWith('.monitor'))
      name=rows.map(row=>row.name).find(n=>typeof n==='string' && !n.endsWith('.monitor'));
    if(name) {
      console.warn(`[zrtc] selected ${key} unavailable; using ${name}`);
      out[key]=name;
    }
  }));
  return out;
}
const HASH = 'c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe';
const OPS = {initialize:1, stop:2, status:3, shutdown:4, configure:5, makeCall:6, callEvent:7, incomingCall:8, audioCodecs:9, callState:10, extendData:11, updateCallerInfo:12, videoFrame:13, videoStats:14, videoSnapshot:15, callInfo:16, microphoneMute:17};
const FIELDS = ['userId','partnerId','protocol','callId','clientVersion','session','settings','zrtcConfig','enableChangeZrtp','videoCall','supportVideoCall'];
export function encodeCommand(id, operation, config = {}) {
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || !OPS[operation]) throw new Error('Invalid worker command');
  const parts = [];
  if (operation === 'microphoneMute') {
    if(!config || Object.keys(config).length!==1 || typeof config.muted!=='boolean')
      throw new Error('Microphone mute requires an explicit boolean');
    const data=Buffer.alloc(4);data.writeUInt32LE(config.muted?1:0);parts.push(data);
  } else if (operation === 'configure') {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid configuration');
    for (const [key, value] of Object.entries(config)) {
      const field = FIELDS.indexOf(key);
      if (field < 0) throw new Error(`Unsupported configuration field: ${key}`);
      let data;
      if (field >= 8) {
        if(typeof value!=='boolean') throw new Error(`Invalid boolean field: ${key}`);
        data=Buffer.alloc(4);data.writeUInt32LE(value?1:0);
      } else if (field < 5) {
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`Invalid integer field: ${key}`);
        data = Buffer.alloc(4); data.writeUInt32LE(value);
      } else {
        if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid string field: ${key}`);
        data = Buffer.from(value);
      }
      const header = Buffer.alloc(8); header.writeUInt32LE(field); header.writeUInt32LE(data.length, 4);
      parts.push(header, data);
    }
  } else if (operation === 'videoFrame') {
    const {pixels,width,height,rotation,timestampNs}=config;
    if(Object.keys(config).length!==5 || !Buffer.isBuffer(pixels) ||
      !Number.isInteger(width) || width<2 || width>1920 || width%2 ||
      !Number.isInteger(height) || height<2 || height>1080 || height%2 ||
      ![0,90,180,270].includes(rotation) || typeof timestampNs!=='bigint' ||
      timestampNs<0n || timestampNs>0x7fffffffffffffffn || pixels.length!==width*height*3/2)
      throw new Error('Invalid NV21 video frame');
    const header=Buffer.alloc(20);
    header.writeUInt32LE(width);header.writeUInt32LE(height,4);header.writeUInt32LE(rotation,8);
    header.writeBigUInt64LE(timestampNs,12);parts.push(header,pixels);
  } else if (operation === 'makeCall') {
    if (!config || Object.keys(config).length !== 1 || typeof config.servers !== 'string' ||
        !config.servers.length || config.servers.includes('\0')) throw new Error('makeCall requires a nonempty servers string');
    parts.push(Buffer.from(config.servers));
  } else if (operation === 'callEvent') {
    if (!config || Object.keys(config).length !== 1 || !Object.hasOwn(CALL_EVENTS, config.event))
      throw new Error('Unknown native call event');
    const data = Buffer.alloc(4); data.writeUInt32LE(CALL_EVENTS[config.event]); parts.push(data);
  } else if (operation === 'callState') {
    if (!config || Object.keys(config).length !== 1 || !Object.hasOwn(MEDIA_STATES, config.state))
      throw new Error('Unknown native media state');
    const data = Buffer.alloc(4); data.writeUInt32LE(MEDIA_STATES[config.state]); parts.push(data);
  } else if (operation === 'incomingCall' || operation === 'updateCallerInfo') {
    const fields = operation === 'incomingCall'
      ? ['rtpAddress','rtcpAddress','relayServer','audioCodec','extendData']
      : ['audioCodec','extendData'];
    if (!config || Object.keys(config).some(key => !fields.includes(key))) throw new Error('Invalid incoming fields');
    for (const key of fields) {
      const value = config[key];
      if (typeof value !== 'string' || value.includes('\0')) throw new Error(`Invalid incoming field: ${key}`);
      const data = Buffer.from(value), header = Buffer.alloc(4); header.writeUInt32LE(data.length);
      parts.push(header,data);
    }
  } else if (Object.keys(config).length) throw new Error('Command does not accept configuration');
  const length = 8 + parts.reduce((n, b) => n + b.length, 0);
  if (length > 1024 * 1024) throw new Error('Worker command exceeds 1 MiB');
  const header = Buffer.alloc(12);
  header.writeUInt32LE(length); header.writeUInt32LE(id, 4); header.writeUInt32LE(OPS[operation], 8);
  return Buffer.concat([header, ...parts]);
}
export class NativeWorker extends EventEmitter {
  #child; #pending = new Map(); #nextId = 1; #buffer = ''; #ready; #timer; #settled = false;
  #expectsPcm = false;
  #expectsOffline = true;
  #pcm;
  #generation=0; #checkingDevices=false;
  static async start(runtime, {pcm,network=false,cpuVideo=false,experimentalVideoNetwork=false} = {}) {
    if(typeof network!=='boolean') throw new Error('Network opt-in must be boolean');
    if(typeof cpuVideo!=='boolean' || typeof experimentalVideoNetwork!=='boolean') throw new Error('Video opt-ins must be boolean');
    if(experimentalVideoNetwork && (!cpuVideo || !network)) throw new Error('Experimental video network requires CPU video and network');
    if(cpuVideo && network && !experimentalVideoNetwork) throw new Error('CPU video is offline-only without experimental video network opt-in');
    const root = path.resolve(runtime), apk = path.join(root, 'apk/lib/x86_64');
    if (createHash('sha256').update(await readFile(path.join(apk, 'libzrtc.so'))).digest('hex') !== HASH)
      throw new Error('Unsupported ZRTC library hash');
    const env = {...process.env, LD_LIBRARY_PATH:[path.join(root,'results/platform'),apk,path.join(root,'bionic')].join(':')};
    delete env.LD_PRELOAD; delete env.LD_AUDIT;
    delete env.ZRTC_PCM_HOST; delete env.ZRTC_PCM_SOURCE; delete env.ZRTC_PCM_SINK;
    const args = [path.join(root,'results/zrtc-worker'),path.join(apk,'libzrtc.so')];
    if(network) args.push('--signaling-network');
    if(cpuVideo) args.push('--cpu-video');
    if(experimentalVideoNetwork) args.push('--cpu-video-network');
    if (pcm !== undefined) {
      if (pcm && typeof pcm.source==='string' && typeof pcm.sink==='string') pcm=await resolvePcm(pcm);
      if (!pcm || Object.keys(pcm).some(key => !['source','sink'].includes(key)) ||
          !['source','sink'].every(key => typeof pcm[key] === 'string' && /^[A-Za-z0-9_.:-]+$/.test(pcm[key])))
        throw new Error('PCM requires explicit source and sink device names');
      env.ZRTC_PCM_HOST = path.join(root,'results/pcm-host');
      env.ZRTC_PCM_SOURCE = pcm.source; env.ZRTC_PCM_SINK = pcm.sink;
      args.push('--local-pcm');
      await validateDevices(pcm);
    }
    const worker = new NativeWorker();
    worker.#expectsPcm = pcm !== undefined;
    worker.#expectsOffline = !network;
    worker.#pcm = pcm && {...pcm};
    worker.#ready = new Promise((resolve, reject) => {
      worker.once('_ready', resolve); worker.once('_failed', reject);
    });
    worker.#child = spawn(path.join(root,'bionic/linker64'), args,
      {env, stdio:['pipe','ignore','pipe','pipe']});
    worker.exited = new Promise(resolve => worker.#child.once('close', (code, signal) => resolve({code,signal})));
    // Drain diagnostics but do not expose native log payloads to app logs.
    worker.#child.stderr.on('data', chunk => {
      // Classify known runtime faults without forwarding native payload logs.
      const text = chunk.toString();
      if (process.env.ZRTC_DEBUG_BACKTRACE) {
        const frames = text.split('\n').filter(l=>l.startsWith('FAULT_STACK'));
        if (frames.length) process.stderr.write(frames.join('\n')+'\n');
      }
      for (const [pattern, kind] of [[/destroyed mutex/,'destroyed-mutex'],[/FORTIFY:/,'fortify'],
        [/double free/,'double-free'],[/JNI_UNIMPLEMENTED/,'jni-unimplemented'],[/UNIMPLEMENTED: OpenSLES/,'opensles-unavailable']])
        if (pattern.test(text)) worker.emit('nativeFault',kind);
    });
    worker.#child.stdin.on('error', error => worker.#fail(error));
    worker.#child.on('error', error => worker.#fail(error));
    worker.#child.on('close', (code, signal) => {
      worker.#fail(new Error(`Native worker closed (${code ?? signal})`));
      // An idle media owner may have no pending request to observe rejection.
      // Expose a detachable lifecycle event without native diagnostic payloads.
      worker.emit('workerClosed');
    });
    worker.#child.stdio[3].setEncoding('utf8');
    worker.#child.stdio[3].on('data', chunk => worker.#receive(chunk));
    worker.#timer = setTimeout(() => worker.#fail(new Error('Native worker readiness timeout')), 10000);
    await worker.#ready;
    return worker;
  }
  #fail(error) {
    clearTimeout(this.#timer);
    if (!this.#settled) { this.#settled = true; this.emit('_failed', error); }
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    if (this.#child?.exitCode === null && this.#child?.signalCode === null) this.#child.kill('SIGKILL');
  }
  #receive(chunk) {
    this.#buffer += chunk;
    // A bounded 1920x1080 I420 snapshot occupies ~4.2 MB as base64 JSON.
    if (this.#buffer.length > 8 * 1024 * 1024) return this.#fail(new Error('Worker output exceeds limit'));
    let end;
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch { return this.#fail(new Error('Invalid worker JSON')); }
      if (message.type === 'ready' && !this.#settled) {
        if (message.protocol !== 1 || message.offline !== this.#expectsOffline || message.callReady !== false ||
            message.localPcm !== this.#expectsPcm)
          return this.#fail(new Error('Unsupported worker capabilities'));
        clearTimeout(this.#timer); this.#settled = true; this.emit('_ready', message);
      } else if (message.type === 'response') {
        const pending = this.#pending.get(message.id);
        if (!pending || !Number.isInteger(message.code)) return this.#fail(new Error('Unexpected worker response'));
        clearTimeout(pending.timer); this.#pending.delete(message.id); pending.resolve(message);
      } else if (message.type === 'event') {
        if (typeof message.event !== 'string' || !Array.isArray(message.args) ||
            !Number.isInteger(message.requestId)) return this.#fail(new Error('Invalid worker event'));
        traceEvent(message);
        this.emit('callEvent', message);
      } else return this.#fail(new Error('Unexpected worker message'));
    }
  }
  request(operation, config = {}) {
    const id = this.#nextId++;
    const frame = encodeCommand(id, operation, config);
    if (['stop','shutdown','configure'].includes(operation)) this.#generation++;
    if (operation==='callState' && this.#pcm && config.state!=='RINGING') {
      if(this.#checkingDevices) return Promise.reject(new Error('PCM device check busy'));
      this.#checkingDevices=true;
      const generation=this.#generation;
      const current=()=>{if(generation!==this.#generation) throw new Error('PCM device check canceled');};
      return validateDevices(this.#pcm).then(()=>{current();return this.#send(id,operation,frame);},async()=>{
        current();
        const stopped=await this.request('stop');
        return {...stopped,id,code:-19};
      }).finally(()=>{this.#checkingDevices=false;});
    }
    return this.#send(id,operation,frame);
  }
  #send(id,operation,frame) {
    if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) return Promise.reject(new Error('Worker is closed'));
    if (this.#pending.size >= 32) return Promise.reject(new Error('Worker request queue is full'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new Error(`Worker ${operation} timeout`)), 10000);
      this.#pending.set(id, {resolve, reject, timer});
      this.#child.stdin.write(frame);
    });
  }
  get processId() { return this.#child?.pid; }
  async close() {
    const timer = setTimeout(() => this.#child.kill('SIGKILL'), 10000);
    try {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      try { await this.request('shutdown'); } finally { this.#child.stdin.end(); }
    }
    return await this.exited;
    } finally { clearTimeout(timer); }
  }
}
