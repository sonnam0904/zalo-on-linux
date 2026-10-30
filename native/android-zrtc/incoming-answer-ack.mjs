// ZaloCall 26.8.20 PE: answer_ack branch 0x71e084; its 4-byte info
// constructor 0x803210 reads data.callId. No caller ID is required there.
export function decodeIncomingAnswerAck(message) {
  const control=message?.data,data=control?.data;
  if(message?.type!=='control' || control?.act_type!=='voip' || control.act!=='answer_ack' ||
    !data || typeof data!=='object' || Array.isArray(data))
    throw new Error('Invalid incoming answer ACK');
  const value=data.callId;
  if(!(typeof value==='number' && Number.isInteger(value)) &&
    !(typeof value==='string' && /^(0|[1-9][0-9]{0,9})$/.test(value)))
    throw new Error('Invalid answer ACK call ID');
  const callId=Number(value);
  if(callId<0 || callId>0xffffffff)throw new Error('Invalid answer ACK call ID');
  return {callId};
}
