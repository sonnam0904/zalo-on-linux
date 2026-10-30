import {EventEmitter} from 'node:events';
import {desktopVoiceConfig} from './desktop-config.mjs';
import {decodeIncomingVoice,decodeIncomingVideo,incomingVideoConfig,incomingControlKey} from './incoming-control.mjs';
import {prepareIncomingAnswer} from './incoming-answer.mjs';
import {decodeIncomingAnswerAck} from './incoming-answer-ack.mjs';

// Owns one worker and one desktop signaling transport. Input is decoded
// CallConfig; control-event decoding and answer/media negotiation are separate.
export class IncomingSession extends EventEmitter {
  #worker; #signaling; #phase='idle'; #generation=0; #attempt=0;
  #running=null; #stopping=null; #waitingSignal=null; #ringSeen=false;
  #onNative;
  #readyTimeout; #readyWait=null; #readyIds=new Set(); #disposed=false;
  #controlKey=null;
  #allowVideo=false;
  #media=null;
  #answerAckSeen=false;
  #confirmedSeen=false;
  #ackWait=null;
  constructor(worker,signaling,{readyTimeoutMs=10000,allowVideo=false}={}) {
    super();this.#worker=worker;this.#signaling=signaling;
    if(typeof allowVideo!=='boolean')throw new TypeError('Incoming video opt-in must be boolean');
    this.#allowVideo=allowVideo;
    if(!Number.isInteger(readyTimeoutMs) || readyTimeoutMs<1) throw new Error('Invalid readiness timeout');
    this.#readyTimeout=readyTimeoutMs;
    this.#onNative=event=>{
      if(event.event==='onIncomingCall' && ['preparing','awaiting-native'].includes(this.#phase)) {
        this.#readyIds.add(event.requestId);
        if(event.requestId===this.#attempt) this.#readyWait?.resolve();
      }
      if(event.requestId===this.#attempt && event.event==='onCallState' && event.args[0]===3)
        this.#ringSeen=true;
      if(event.requestId===this.#attempt && event.event==='onCallState' && event.args[0]===5)
        this.#confirmedSeen=true;
    };
    worker.on('callEvent',this.#onNative);
  }
  get phase() {return this.#phase;}
  async control(message,context) {
    if(this.#disposed) throw new Error('Incoming session disposed');
    if(message?.type==='control' && message.data?.act==='answer_ack') {
      const {callId}=decodeIncomingAnswerAck(message);
      if(callId!==this.#media?.callId || this.#stopping ||
        !['sending-answer','awaiting-answer-ack','answer-acknowledged'].includes(this.#phase))
        return {handled:false,callReady:false};
      const duplicate=this.#answerAckSeen;
      this.#answerAckSeen=true;
      if(this.#phase==='awaiting-answer-ack')this.#setPhase('answer-acknowledged');
      this.#ackWait?.resolve();
      return {handled:true,duplicate,callReady:false};
    }
    const key=incomingControlKey(message);
    if(key.action==='request') {
      const video=context?.video===true;
      if(video && !this.#allowVideo)throw new Error('Incoming video is disabled');
      const decoded=video?decodeIncomingVideo(message,{...context,experimentalVideo:true}):decodeIncomingVoice(message,context);
      if(this.#controlKey?.callId===key.callId && this.#controlKey?.callerId===key.callerId)
        return {handled:true,duplicate:true,callReady:false};
      if(this.#controlKey || this.#phase!=='idle' || this.#running || this.#stopping)
        throw new Error('Incoming session busy');
      this.#controlKey=key;
      try {return await this.incoming(decoded.config,{video});}
      catch(error) {if(this.#controlKey===key) this.#controlKey=null;throw error;}
    }
    // Late cancellation of a previous call must not tear down the active one.
    if(this.#controlKey?.callId!==key.callId || this.#controlKey?.callerId!==key.callerId)
      return {handled:false,callReady:false};
    await this.stop();
    return {handled:true,callReady:false};
  }
  #setPhase(phase) {this.#phase=phase;this.emit('phase',phase);}
  async #native(operation,args={}) {
    const reply=await this.#worker.request(operation,args);
    if(reply.code!==0) throw new Error(`Native ${operation} rejected (${reply.code})`);
    return reply;
  }
  incoming(config,{video=false}={}) {
    if(this.#disposed) return Promise.reject(new Error('Incoming session disposed'));
    if(this.#phase!=='idle' || this.#running || this.#stopping)
      return Promise.reject(new Error('Incoming session busy'));
    let mapped;
    try {
      if(typeof video!=='boolean' || (video && !this.#allowVideo))throw new Error('Incoming video is disabled');
      mapped=video?incomingVideoConfig(config,{experimentalVideo:true}):desktopVoiceConfig(config,{role:'callee',video:false});
    }
    catch(error) {return Promise.reject(error);}
    const generation=++this.#generation;
    this.#answerAckSeen=false;
    this.#confirmedSeen=false;
    this.#media={video,callId:mapped.configuration.callId};
    this.#readyIds.clear();
    this.#setPhase('preparing');
    this.#running=this.#run(mapped,generation);
    return this.#running.finally(()=>{this.#running=null;});
  }
  async #run(mapped,generation) {
    const current=()=>{if(generation!==this.#generation) throw new Error('Incoming session canceled');};
    try {
      current();
      await this.#native('configure',mapped.configuration);current();
      const attempt=await this.#native('incomingCall',mapped.arguments);
      this.#attempt=attempt.id;this.#ringSeen=false;current();
      // APK vz.p1.onIncomingCall queues event 407 at classes5.dex 0x079440.
      // incomingCall returning true alone does NOT authorize ring signaling.
      this.#setPhase('awaiting-native');current();
      if(!this.#readyIds.has(this.#attempt)) await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Native incoming readiness timeout')),this.#readyTimeout);
        this.#readyWait={resolve:()=>{clearTimeout(timer);resolve();},reject:error=>{clearTimeout(timer);reject(error);}};
      }).finally(()=>{this.#readyWait=null;});
      current();
      await this.#native('callEvent',{event:'SEND_407'});current();
      this.#setPhase('signaling');current();this.#waitingSignal=407;
      try {
        const ringReq=this.#signaling.request(407,{callerId:mapped.configuration.partnerId,callId:mapped.configuration.callId});
        const softTimeout=new Promise(resolve=>setTimeout(resolve,1500));
        await Promise.race([ringReq,softTimeout]);
      } finally {this.#waitingSignal=null;}
      current();
      await this.#native('callEvent',{event:'SEND_407_SUCCESS'});current();
      await this.#native('callState',{state:'RINGING'});current();
      if(!this.#ringSeen) throw new Error('Native ringing callback missing');
      this.#setPhase('ringing');
      return {phase:'ringing',callReady:false,requestId:this.#attempt};
    } catch(error) {
      await this.#native('stop');this.#attempt=0;this.#media=null;this.#setPhase('idle');
      throw error;
    }
  }
  // Read-only preparation, not acceptance. The caller must still obtain user
  // consent and complete signaling/remote ACK before changing media state.
  prepareAnswer({callerId,signal}={}) {
    if(this.#disposed || this.#phase!=='ringing' || this.#stopping || !this.#media)
      return Promise.reject(new Error('Incoming session is not ringing'));
    const generation=this.#generation,attempt=this.#attempt;
    return prepareIncomingAnswer(this.#worker,{
      callerId,callId:this.#media.callId,video:this.#media.video,signal,
      current:()=>{
        if(this.#disposed || generation!==this.#generation || attempt!==this.#attempt ||
          this.#phase!=='ringing' || this.#stopping)
          throw new Error('Incoming answer ownership changed');
      }
    });
  }
  answer({callerId,userAccepted=false}={}) {
    if(userAccepted!==true)return Promise.reject(new Error('Explicit user acceptance required'));
    if(this.#disposed || this.#phase!=='ringing' || this.#running || this.#stopping || !this.#media)
      return Promise.reject(new Error('Incoming session is not available for answer'));
    const generation=this.#generation,attempt=this.#attempt,media=this.#media;
    // Reserve synchronously, but notify only after #running exists so a phase
    // listener that stops the call joins this transaction before reusing worker.
    this.#phase='preparing-answer';
    const current=()=>{
      if(this.#disposed || generation!==this.#generation || attempt!==this.#attempt)
        throw new Error('Incoming answer canceled');
    };
    this.#running=Promise.resolve().then(async()=>{
      try {
        current();this.emit('phase','preparing-answer');current();
        const payload=await prepareIncomingAnswer(this.#worker,{callerId,...media,current});
        current();this.#setPhase('sending-answer');current();
        this.#waitingSignal=402;
        // Observe rejection immediately, even if the native event is delayed.
        // APK s0 invokes voiceRequestAnswer before queuing SEND_402.
        const response=Promise.resolve(this.#signaling.request(402,payload)).then(
          value=>({ok:true,value}),error=>({ok:false,error}));
        await this.#native('callEvent',{event:'SEND_402'});current();
        const outcome=await response;this.#waitingSignal=null;current();
        if(!outcome.ok)throw new Error('Desktop answer signaling failed',{cause:outcome.error});
        await this.#native('callEvent',{event:'SEND_402_SUCCESS'});current();
        this.#setPhase(this.#answerAckSeen?'answer-acknowledged':'awaiting-answer-ack');
        // API success is not a correlated remote ACK. No CONFIRMED/capture.
        return {phase:this.#phase,callReady:false,requestId:attempt};
      } catch(error) {
        if(this.#waitingSignal===402)this.#signaling.cancel(402);
        this.#waitingSignal=null;
        await this.#native('stop');this.#attempt=0;this.#media=null;
        this.#controlKey=null;this.#setPhase('idle');throw error;
      }
    });
    return this.#running.finally(()=>{this.#running=null;});
  }
  waitForAnswerAck({timeoutMs=15000,signal}={}) {
    if(!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>120000)
      return Promise.reject(new TypeError('Invalid answer ACK timeout'));
    if(signal!==undefined && (typeof signal?.aborted!=='boolean' ||
      typeof signal.addEventListener!=='function' || typeof signal.removeEventListener!=='function'))
      return Promise.reject(new TypeError('Invalid answer ACK abort signal'));
    if(this.#disposed || this.#stopping || this.#running || this.#ackWait ||
      !['awaiting-answer-ack','answer-acknowledged'].includes(this.#phase))
      return Promise.reject(new Error('Incoming session cannot wait for answer ACK'));
    const generation=this.#generation,attempt=this.#attempt;
    const current=()=>generation===this.#generation && attempt===this.#attempt && !this.#disposed;
    const canceled=()=>new Error('Incoming answer ACK wait canceled');
    const wait=new Promise((resolve,reject)=>{
      let timer;
      const finish=error=>{
        clearTimeout(timer);signal?.removeEventListener('abort',abort);
        this.#ackWait=null;
        if(error)reject(error);else resolve({phase:'answer-acknowledged',callReady:false,requestId:attempt});
      };
      const abort=()=>finish(canceled());
      this.#ackWait={resolve:()=>finish(current()?null:canceled()),reject:finish};
      if(signal?.aborted){abort();return;}
      if(this.#answerAckSeen){finish();return;}
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{
        const error=new Error('Incoming answer ACK timeout');error.code='ANSWER_ACK_TIMEOUT';finish(error);
      },timeoutMs);
    });
    return wait.catch(async error=>{
      // stop() invalidates generation before rejecting this wait. Never let
      // cleanup for an older wait stop a replacement call on this worker.
      if(current())await this.stop();
      throw error;
    });
  }
  startMedia() {
    if(this.#disposed || this.#phase!=='answer-acknowledged' || !this.#answerAckSeen ||
      this.#running || this.#stopping || !this.#media)
      return Promise.reject(new Error('Incoming media requires completed answer and remote ACK'));
    const generation=this.#generation,attempt=this.#attempt,video=this.#media.video;
    const current=()=>{
      if(this.#disposed || generation!==this.#generation || attempt!==this.#attempt)
        throw new Error('Incoming media startup canceled');
    };
    this.#phase='starting-media';this.#confirmedSeen=false;
    this.#running=Promise.resolve().then(async()=>{
      try {
        current();this.emit('phase','starting-media');current();
        await this.#native('callState',{state:'CONFIRMED'});current();
        if(!this.#confirmedSeen)throw new Error('Native confirmed callback missing');
        if(video) {
          const reply=await this.#native('videoStats');current();
          let stats;try {stats=JSON.parse(reply.data);}catch {throw new Error('Invalid native video startup data');}
          if(stats?.codecId!==4 || stats.videoCall!==true || stats.canTransferMedia!==true || stats.captureThreadRunning!==true)
            throw new Error('Native incoming video media not ready');
        }
        this.#setPhase('media-started');current();
        // Native startup is not proof of remote reception. Camera pumping and
        // render ownership remain the application media owner's responsibility.
        return {phase:'media-started',callReady:false,requestId:attempt};
      } catch(error) {
        await this.#native('stop');this.#attempt=0;this.#media=null;
        this.#controlKey=null;this.#setPhase('idle');throw error;
      }
    });
    return this.#running.finally(()=>{this.#running=null;});
  }
  stop() {
    if(this.#stopping) return this.#stopping;
    ++this.#generation;
    this.#ackWait?.reject(new Error('Incoming answer ACK wait canceled'));
    this.#readyWait?.reject(new Error('Incoming session canceled'));
    if(this.#waitingSignal!==null) this.#signaling.cancel(this.#waitingSignal);
    this.#stopping=(async()=>{
      try {if(this.#running) await this.#running.catch(()=>{});
        await this.#native('stop');this.#attempt=0;this.#controlKey=null;this.#media=null;this.#setPhase('idle');
      } finally {this.#stopping=null;}
    })();
    return this.#stopping;
  }
  async dispose() {
    this.#disposed=true;
    try {await this.stop();}
    finally {this.#worker.off('callEvent',this.#onNative);}
  }
}
