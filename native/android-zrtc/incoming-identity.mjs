// Incoming controls have already crossed Zalo's authenticated renderer
// control channel before reaching this isolated helper. Bind the native
// uint32 recipient carried by that control to the currently logged-in desktop
// account. Do not issue a second 401 while that account is already receiving a
// call: the server treats the overlapping outgoing probe as a competing call
// and tears the real incoming call down on a cold start.
export async function resolveIncomingIdentity(_transport,identity,message,{signal}={}) {
  const ticket=identity.ticket();
  if(!ticket.account || !signal || signal.aborted)throw new Error('Incoming identity unavailable');
  const data=message?.data?.data;
  const raw=data?.uidTo;
  const candidate=typeof raw==='string' && /^[1-9][0-9]{0,9}$/.test(raw)?Number(raw):raw;
  if(!Number.isInteger(candidate) || candidate<1 || candidate>0xffffffff)
    throw new Error('Invalid incoming identity envelope');
  let remembered;
  try {remembered=identity.resolve(ticket);}catch {}
  if(remembered!==undefined) {
    if(remembered!==candidate)throw new Error('Incoming recipient changed');
    return remembered;
  }
  if(signal.aborted)throw new Error('Incoming identity canceled');
  identity.remember(ticket,candidate);
  return identity.resolve(ticket);
}
