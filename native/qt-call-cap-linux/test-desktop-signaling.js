"use strict";
const assert=require('node:assert/strict');
const {DesktopSignaling}=require('./desktop-signaling');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
(async()=>{
    const sent=[];
    const bridge=new DesktopSignaling(m=>sent.push(m),{timeoutMs:40});
    const offer={calleeId:'456',callId:123,codec:'[]',type:1};
    const first=bridge.request(401,offer);
    assert.deepEqual(sent,[{type:'sendSignal',command:401,data:offer}]);
    await assert.rejects(bridge.request(401,offer),/busy/);
    assert.equal(bridge.receive({type:'sendSignal',command:401,data:{}}),false);
    assert.equal(bridge.receive({type:'recvSignal',command:402,data:{}}),false);
    const serverResponse={id:123,error_code:7,data:{fixture:true}};
    assert.equal(bridge.receive({type:'recvSignal',command:401,data:serverResponse}),true);
    assert.deepEqual(await first,serverResponse);
    let control;
    bridge.on('control',data=>control=data);
    const incoming={act_type:'voip',act:'request',data:{uidN:'456',callId:123}};
    assert.equal(bridge.receive({type:'control',data:incoming}),true);
    assert.deepEqual(control,incoming);
    const ringing=bridge.request(407,{callerId:'456',callId:123});
    await assert.rejects(ringing,/timeout/);
    assert.equal(bridge.receive({type:'recvSignal',command:407,data:{}}),false);
    await assert.rejects(bridge.request(407,{callerId:'456',callId:123}),/expired/);
    await assert.rejects(bridge.request(401,{...offer,zpw_sek:'never forwarded'}),/Unexpected/);
    await assert.rejects(bridge.request(11,{}),/Unsupported/);
    const end=bridge.request(409,{toId:'456',callId:123});
    bridge.close();await assert.rejects(end,/closed/);
    await assert.rejects(bridge.request(401,offer),/closed/);
    // Exercise the shipped renderer methods, not a reimplementation of its
    // dispatch table. Only the authenticated API itself is replaced by a spy.
    const bundle=fs.readFileSync(path.join(__dirname,'../../pc-dist/compact-app-pc.e08d0d44f38873747a6b.js'),'utf8');
    function method(name,next) {
        const start=bundle.indexOf('                '+name+'(');
        const end=bundle.indexOf('                '+next+'(',start);
        assert.ok(start>=0 && end>start);
        return bundle.slice(start,end).trim();
    }
    const calls=[];
    let apiFailure=null;
    const decoded={id:123,sessId:'fixture',servers:[],settings:{}};
    const decoderStart=bundle.indexOf('        kCOK: function(');
    const decoderEnd=bundle.indexOf('        kCR7:',decoderStart);
    assert.ok(decoderStart>=0 && decoderEnd>decoderStart);
    const decoderModule=vm.runInNewContext('({'+bundle.slice(decoderStart,decoderEnd)+'})').kCOK;
    const decoderExports={};
    const dependencies={
        '1pet':{ERR_KICK_OUT:-999},
        'z0WU':{default:{decodeAES:text=>text,logCoreError(){}}}, // identity AES fixture only
        'X4fA':{a:{onKickoutSession(){}}},'PoHQ':{p:{triggerEvent(){}}},
    };
    const load=id=>dependencies[id];load.d=(target,key,get)=>Object.defineProperty(target,key,{get});
    decoderModule({},decoderExports,load);
    const payload=await decoderExports.a({status:200,data:{error_code:0,data:JSON.stringify({error_code:0,data:decoded})}});
    assert.equal(JSON.stringify(payload),JSON.stringify(decoded));
    await assert.rejects(decoderExports.a({status:200,data:{error_code:0,data:JSON.stringify({error_code:7,error_message:'fixture'})}}),e=>e.error_code===7);
    const api=new Proxy({}, {get:(_,name)=>(...args)=>{
        calls.push({name,args});return apiFailure?Promise.reject(apiFailure):Promise.resolve(decoded);
    }});
    const renderer=vm.runInNewContext('({'+method('handleUpdate','handleSendSignal')+','+
        method('handleSendSignal','handleSendSignalError')+','+
        method('handleSendSignalError','isNoNetwork')+','+
        method('handleRecvSignal','isIncomingCallEvent')+'})',{
        s:{default:api},A:{default:{call:{using_queue:false}}},
        v:{a:{BACKGROUND_2_FOREGROUND:1},b:{activeApp(){}}},
    });
    renderer.logInfo=()=>{};
    renderer.logError=()=>{};

    renderer.handleRecvSignal=renderer.handleRecvSignal.bind(renderer);
    const integrated=new DesktopSignaling(m=>renderer.handleSendSignal(null,m.command,m.data));
    renderer._sendToNative=m=>integrated.receive(m);
    const delivered=await integrated.request(401,offer);
    assert.equal(delivered,decoded); // already-decoded data, not an envelope
    assert.equal(calls[0].name,'requestCall');
    assert.deepEqual(calls[0].args,['456',123,'[]',1]);
    await integrated.request(416,{calleeId:'456',rtcpAddress:'127.0.0.1:9',rtpAddress:'127.0.0.1:8',codec:'[]',extendData:'{}',session:'fixture',callId:123});
    assert.deepEqual(calls[1],{name:'sendRequestCall',args:['456','127.0.0.1:9','127.0.0.1:8','[]','{}','fixture',123]});
    await integrated.request(409,{toId:'456',callId:123});
    assert.deepEqual(calls[2],{name:'sendEndCall',args:['456',123]});
    // Cancellation is 405, not an answer status. This verifies forwarding,
    // not which callType is appropriate for a user's decline action.
    await integrated.request(405,{toId:'456',callId:123,callType:0});
    assert.deepEqual(calls[3],{name:'sendCancelCall',args:['456',123,0]});
    const cancelStart=bundle.indexOf('                static sendCancelCall(');
    const cancelEnd=bundle.indexOf('                static sendEndCall(',cancelStart);
    assert.ok(cancelStart>=0 && cancelEnd>cancelStart);
    const CancelAPI=vm.runInNewContext('(class {'+bundle.slice(cancelStart,cancelEnd)+'})',{
        g:{b:{getVoiceCallDomain:()=> 'https://fixture.invalid'}},
        r:{default:{encodeAES:text=>text}}, // synthetic identity encryption
        w:{a:{getZaloClientID:()=> 'fixture-imei'}},
    });
    CancelAPI._getCommonParams=()=> 'fixture=1';
    CancelAPI._get=(url,body,code)=>({url,body,code});
    const canceled=CancelAPI.sendCancelCall('456',123,0);
    const url=new URL(canceled.url);
    assert.equal(url.pathname,'/api/voicecall/cancel');
    assert.equal(canceled.code,11305);
    assert.equal(canceled.body,null);
    assert.deepEqual(JSON.parse(url.searchParams.get('params')),
        {callerId:'456',callId:123,callType:0,status:0,imei:'fixture-imei'});
    // End and cancel have different endpoint schemas. Keep the real end
    // builder covered: incoming media ownership currently uses command 409.
    const endStart=cancelEnd;
    const endEnd=bundle.indexOf('                static sendHoldRequestCall(',endStart);
    assert.ok(endEnd>endStart);
    const EndAPI=vm.runInNewContext('(class {'+bundle.slice(endStart,endEnd)+'})',{
        g:{b:{getVoiceCallDomain:()=> 'https://fixture.invalid'}},
        r:{default:{encodeAES:text=>text}},
        w:{a:{getZaloClientID:()=> 'fixture-imei'}},
    });
    EndAPI._getCommonParams=CancelAPI._getCommonParams;
    EndAPI._get=CancelAPI._get;
    const ended=EndAPI.sendEndCall('456',123);
    const endURL=new URL(ended.url);
    assert.equal(endURL.pathname,'/api/voicecall/endcall');
    assert.equal(ended.code,11306);
    assert.equal(ended.body,null);
    assert.deepEqual(JSON.parse(endURL.searchParams.get('params')),
        {uidTo:'456',callId:123,status:3,imei:'fixture-imei'});
    const errors=[];
    renderer._sendToNative=m=>{errors.push(m);integrated.receive(m);};
    renderer.handleSendSignalError(401,{error_code:9},{callId:123});
    assert.equal(errors.length,0); // old engines do not opt into this extension
    renderer.handleUpdate(null,'linux-native-capabilities',{signalingErrors:true});
    apiFailure={error_code:9,error_message:'private',request:{responseURL:'secret'}};
    await assert.rejects(integrated.request(401,{...offer,callId:124}),e=>e.code===9 && e.command===401);
    assert.equal(JSON.stringify(errors[0]),JSON.stringify({type:'recvSignalError',command:401,data:{callId:124,errorCode:9}}));
    apiFailure=null;
    decoded.id=125;
    assert.equal(await integrated.request(401,{...offer,callId:125}),decoded); // a real error reply permits a fresh-ID retry
    integrated.close();
    {
    const retry=new DesktopSignaling(()=>{}, {timeoutMs:20});
    const canceled=retry.request(401,{...offer,callId:200});
    const canceledResult=assert.rejects(canceled,/canceled/);retry.cancel(401);await canceledResult;
    const replacement=retry.request(401,{...offer,callId:201});
    assert.equal(retry.receive({type:'recvSignal',command:401,data:{id:200,fromId:1}}),false);
    assert.equal(retry.receive({type:'recvSignal',command:401,data:{id:'201',fromId:1}}),false);
    assert.equal(retry.receive({type:'recvSignalError',command:401,data:{callId:200,errorCode:1}}),false);
    assert.equal(retry.receive({type:'recvSignal',command:401,data:{id:201,fromId:123}}),true);
    assert.deepEqual(await replacement,{id:201,fromId:123});
    await assert.rejects(retry.request(401,{...offer,callId:200}),/reused/);
    await assert.rejects(retry.request(401,{...offer,callId:202}),/timeout/);
    const afterTimeout=retry.request(401,{...offer,callId:203});
    assert.equal(retry.receive({type:'recvSignal',command:401,data:{id:202}}),false);
    retry.receive({type:'recvSignal',command:401,data:{id:203}});assert.deepEqual(await afterTimeout,{id:203});
    retry.close();
    console.log('PASS 401 retry: cancellation/timeout recovery, stale success/error rejection, strict response ID, retired-ID rejection');
    }
    console.log('PASS desktop signaling boundary: exact host frames, response/control grammar, no false success, timeout isolation, close');
})().catch(e=>{console.error(e);process.exitCode=1;});
