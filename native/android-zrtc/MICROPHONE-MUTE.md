# Microphone mute backend

Worker command 17 (`microphoneMute`, `{muted: boolean}`) gates recording PCM
before `nativeDataIsRecorded`. Muted blocks are zero-filled. Playback is not
modified. The mutex spans the recording callback, so setter acknowledgment
waits for any earlier callback to return. Already encoded/in-flight audio is
not recalled. The microphone device remains open; this is transmission mute,
not device shutdown. Native stop resets the gate for the next call.

Commands require an active initialized call and exactly one 32-bit 0/1 value;
idle requests return `-ENOTCONN`. The JS encoder rejects coercible booleans.

Verification:

- `test-capture-gate.c`: nonzero synthetic PCM, zeroing/restoration over 1,000
  cycles and setter acknowledgment blocked while a callback owns the gate.
  Compile with `cc -std=c11 -Wall -Wextra -Werror -pthread`.
- `test-microphone-mute-wire.mjs`: command framing and strict input validation.
- Rebuilt native worker: `test-worker.mjs` covers idle rejection; the incoming
  owner native fixture toggles mute/unmute in three media cycles and verifies
  rejection after stop. Its PCM is silent; it does not prove remote audible mute.

Trial build: `~/zalo-native-recovery/mute-check/runtime`. Existing installed
runtime was not overwritten. Rebuild the worker before running these updated
native fixtures; older workers do not implement command 17.

Outgoing and incoming controls now use the persistent call window and update
mute state only after a successful native response. The new window and diagnostic
runtime were deployed/restarted with approval, as documented in `CALL-WINDOW.md`.

## Non-silent native evidence, 2026-09-10

Rebuilt worker at `~/zalo-native-recovery/mute-evidence-20260910/runtime` passed
`test-incoming-owner-native.mjs RUNTIME --tone`: three native incoming call
cycles using a 440 Hz sine in a dedicated virtual Pulse sink, separate virtual
playback sink, and localhost signaling/media. No microphone, physical speaker,
real account or saved recording was involved.

Worker responses now include aggregate `captureGate` counters: nonzero input
blocks, nonzero blocks forwarded to `nativeDataIsRecorded`, muted blocks and
current mute state. No PCM samples are included. The snapshot acquires the
capture mutex **before** the output mutex to avoid callback lock inversion.
Counters are lifetime totals; compare deltas, not absolute values per call.

The tone test verifies nonzero input continues while muted, forwarded-nonzero
count remains exactly unchanged after mute ACK, and increases after unmute.
This proves the native recording ingress gate, **not silence heard by a real
remote account**. Previously encoded/in-flight sound cannot be recalled. The
user's report of unreliable mute still needs a new two-account acceptance test
after matching main/helper/runtime deployment.
