// Pinned 21.12.01 classes2.dex, com.vng.zing.vn.zrtc.b / .g.
// SHA256: 321a6596e6e2f08446607c0a724036cf163a19c8803021ee4473503f411e1ebc
// Both constructors take only Enum(name, ordinal); there is no custom code field.
// receiveCallEvent is not setCallState, and these are not socket command IDs.
export const CALL_EVENTS = Object.freeze(Object.fromEntries([
  'NONE','START_CALL','SEND_401','SEND_401_SUCCESS','SEND_416','SEND_416_SUCCESS',
  'RECEIVED_415_SOCKET','RECEIVED_415_NOTI','RECEIVED_407','RECEIVED_402',
  'SEND_407','SEND_407_SUCCESS','SEND_402','SEND_402_SUCCESS','RECEIVED_403',
  'CANCEL_TIMEOUT','START_INCOMING_CALL','SEND_415','SEND_415_SUCCESS',
].map((name, code) => [name, code])));
export const NETWORK_TYPES = Object.freeze({UNKNOWN:0, WIFI:1, MOBILE_3G:2, MOBILE_2G:3});
// classes5.dex SHA256 33918b743d0fc66a51913058db41daa5a04f4c9b41ed2f0bf228a4effc54076b.
// i00.j0.V: 407/4070 success -> b.A.ordinal() then a9.b.V(3).
// i00.j0 establishCall logs CONFIRMED then a9.b.V(5) at 0x04e4be.
// Native Peer::setCallState 0x2ded10 handles 3=ring, 4=early, 5=start.
export const MEDIA_STATES = Object.freeze({RINGING:3, EARLY:4, CONFIRMED:5});
