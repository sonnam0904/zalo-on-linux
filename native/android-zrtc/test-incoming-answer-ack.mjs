import assert from 'node:assert/strict';
import {decodeIncomingAnswerAck} from './incoming-answer-ack.mjs';
const envelope=callId=>({type:'control',data:{act_type:'voip',act:'answer_ack',data:{callId}}});
for(const callId of [0,'0',789,'789',4294967295,'4294967295'])
  assert.equal(decodeIncomingAnswerAck(envelope(callId)).callId,Number(callId));
for(const callId of [undefined,null,true,{},[],1.5,-1,4294967296,'01','1e3','789garbage',' 789','+789'])
  assert.throws(()=>decodeIncomingAnswerAck(envelope(callId)),/call ID/);
for(const message of [null,{type:'recvSignal',command:402,data:{}},
  {type:'control',data:{act_type:'voip',act:'answer',data:{callId:789}}},
  {type:'control',data:{act_type:'other',act:'answer_ack',data:{callId:789}}}])
  assert.throws(()=>decodeIncomingAnswerAck(message),/ACK/);
console.log('PASS incoming answer_ack decoding: observed callId-only structure, strict uint32, no confusion with 402 API response or answer');
