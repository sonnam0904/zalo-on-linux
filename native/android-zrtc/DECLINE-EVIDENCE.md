# Incoming decline investigation — 2026-09-10

Status: **implemented at the authenticated desktop boundary**. The incoming
action is now “Từ chối” and sends desktop command 405 before local teardown.
No account profile was read.

Static input: pinned Android `classes5.dex`, SHA-256
`33918b743d0fc66a51913058db41daa5a04f4c9b41ed2f0bf228a4effc54076b`.
Offsets below are file offsets from SDK 35.0.0 `dexdump -d`, not native addresses.

## Answer status is not a generic reject enum

- `vz.s0.k2` at `0x06cd48` accepts receiver ID, status, call ID and five strings.
  Its debug argument order and register moves independently identify status.
  At `0x06ceb0` it invokes `IVoipZalo.voiceRequestAnswer`; the branch at
  `0x06ceb6` skips the native SEND_402 task when status is nonzero.
- At `0x068692`, status is set to **1** before calling `k2` at `0x0686b4`.
  The preceding branch explicitly reports the device already in a native call.
  The final string argument is a reason object with value 1.
- At `0x06764c`, status is set to **3** before invoking `j2` at `0x067670`.
  The preceding branch explicitly rejects an unsupported non-ZRTP protocol.
  `j2` at `0x06cd18` forwards to `k2`, adding an empty final string.

These prove busy and unsupported-protocol paths, not a user's decline action.
No status value should be invented for the GTK button from these paths.

## Separate cancellation path found

`vz.s0.e2:(IZZ)V` at `0x06c444` reads peer ID and call ID from current call state.
It forwards its first integer argument unchanged into `IVoipZalo.cancelCall`
at `0x06c506`. Its two boolean arguments select a separate integer:

| First boolean (logged as isVideo) | Second boolean | Final integer |
| --- | --- | --- |
| false | false | 0 |
| true | false | 1 |
| false | true | 2 |
| true | true | 3 |

An inherited callsite is `vz.c1.e2` at `0x07851e` in `vz.p1`; searching only for
`vz.s0.e2` misses it. Next trace this caller's integer argument and UI origin,
then the plugin implementation's request field mapping. The second boolean's
meaning and cancellation integer semantics remain unverified.

Further tracing: `vz.p1.g` at `0x078474` obtains the integer from virtual
`vz.c1.J()` before invoking cancellation. The implementation `vz.s0.J` at
`0x0667cc` logs `getEndCallType` and derives its result from call state; it is
not a fixed voice/video flag. It has distinct paths yielding 0 through 6,
-1, and error-dependent values. The base-class implementation returning zero
must not be substituted for the runtime override.

In pinned `classes2.dex` (SHA-256
`321a6596e6e2f08446607c0a724036cf163a19c8803021ee4473503f411e1ebc`),
`pa.l.cancelCall` at `0x4f8328` serializes all four incoming integers in order
into a binary request, then sets socket command **405** at `0x4f83c6`.
This independently links Android cancellation to command 405, but still does
not establish a specific user-decline callType for the desktop HTTP endpoint.

The shipped desktop renderer separately maps command **405** to
`sendCancelCall(toId, callId, callType)`. Its API builder uses
`/api/voicecall/cancel`, `callerId`, `callId`, `callType`, fixed `status: 0` and
client IMEI. Command **402** instead calls the answer endpoint with an explicit
status. Android's four-integer cancellation interface cannot yet be assumed
equivalent to the desktop's three-argument wrapper.

`test-desktop-signaling.js` exercises the shipped renderer's command 405
dispatch and extracts the actual static API builder. With synthetic peer/call
IDs and identity encryption it verifies endpoint, parameter names, fixed
status zero and request code 11305. The shipped desktop call-message mapping
also identifies `calltype === 1` as video and every other value as audio. The
owner therefore sends callType 0 for voice and 1 for video; composition tests
cover both values without making a network request.

## UI and end-call cross-check

The `Hang up immediately!` branch in `ZmInCallActivity` sets `qz.q.Y` at
`0x098bc8`; a conditional branch sets `qz.q.X` at `0x098bec`, while another
invokes `qz.q.V0(true)` at `0x098c2c` (the setter for field W). Thus the UI
changes multiple flags before teardown. Their names must not be interpreted
as caller/callee labels without checking initialization.

The cancellation callsite `vz.p1.g` is guarded by `qz.q.X()` and `G0()` being
true, and `v0()` being false (`0x0784ce` through `0x0784fa`). Getter `X()` is
field **e0**, not field X. `U0(boolean)` sets e0. This distinction matters:
matching obfuscated field and method names would produce an incorrect trace.

Separately, `vz.s0.W4` at `0x06c864` forwards explicit status into
`IVoipZalo.voiceEndCall` at `0x06c918`. It is reached through `h2`; one callsite
in `i00.j0.U` at `0x04c02c` supplies status 2 for event reason -17, otherwise
zero (`0x04bf7a` through `0x04bfa2`). This is not the desktop HTTP builder's
fixed status 3. Android's internal event reasons must not be copied into the
desktop payload without establishing endpoint semantics.

The desktop signaling test also extracts the actual `sendEndCall` builder and
verifies `/api/voicecall/endcall`, `uidTo`, fixed status 3 and request code
11306. This covers the builder already used for ending accepted incoming
media, not permission to reuse it for declining unanswered invitations.

## Reproduce without private data

Run `dexdump -d` on the pinned DEX and filter for these method references:
`Lvz/s0;.k2:`, `Lvz/s0;.j2:`, `Lvz/c1;.e2:` and
`IVoipZalo;.cancelCall:`. Preserve enough preceding instructions to track
register assignment. In the desktop bundle, inspect case 405 and the static
`sendCancelCall` implementation. No captures or live account API requests are
needed for these checks.
