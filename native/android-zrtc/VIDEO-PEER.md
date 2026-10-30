# CPU video integration status

This is an experimental **offline Peer integration**, not working Zalo video
calling. Voice uses the existing adapter unchanged. The agent does not request
`cpuVideo`, and CPU video with network enabled requires the additional explicit
`experimentalVideoNetwork: true` opt-in (checked in both client and worker).
Incoming CPU-video initialization is also explicitly unsupported for now.

## What is now connected

Logitech C922 `/dev/video0` -> ffmpeg MJPEG-to-NV21 -> bounded binary worker
commands -> Linux VideoSource -> original VideoCapturer owned by the original
Peer. The original Peer capture callback remains registered, including its FPS
and media-transfer conditions. No invented EGL context or Java camera object is
passed into the library.

The adapter borrows the capturer at Peer offset `0x620`. It does not replace the
native shared pointer, destroy the capturer, or take over the Peer codec. It
joins the original encode thread and releases its source before Peer teardown.

`videoFramesSubmitted` counts I420 submissions whose original capturer callback
returned. It does **not** count encoded frames, RTP packets, remote delivery, or
displayed frames. The `callReady` response remains false.

## Version-specific adaptation

Only libzrtc SHA-256
`c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe`
is accepted by NativeWorker. Runtime patches additionally check the original
instruction bytes before installation. The ELF file is not modified.

- `Peer::initialize + 0x59`: remove the Android EGL prerequisite only in the
  explicitly selected CPU-video worker. Original initialization results remain
  authoritative; no forced success return.
- `_initVideoCodingAndCapture + 0x3b3`: select the original CPU codec branch.
  Setting the Peer hardware byte before initialization alone was insufficient:
  a diagnostic still reached `MediaCodecVideoEncoder.<init>`. The branch-level
  adaptation avoids that Android object creation.
- `+ 0x75e`: replace Android camera creation with Linux source binding and
  register the original Peer callback at `Peer + 0x18`. The trampoline returns
  the actual binding result through original cleanup at `+ 0x88a`.
- `_startVideoCapture`: start the original capturer encode thread, only after
  successful binding. Camera input is supplied explicitly through IPC; this
  does not claim that a physical camera was opened by that method.

Installation happens before JNI startup. Executable pages are not kept
writable. Any partial installation failure terminates the diagnostic worker.

## Reproduction and evidence

Build with the existing `build-worker.sh`, then run:

```sh
node native/android-zrtc/test-worker-video-peer.mjs RUNTIME_DIR
node native/android-zrtc/test-camera-peer.mjs RUNTIME_DIR
```

Verified locally:

- Three successful original Peer video initialize/submit/stop cycles, 30
  synthetic frames each; submission rejected before initialization/after stop.
- Thirty real Logitech frames through the actual Peer capturer; no saved
  images and no network permission in the worker.
- Standard video mode still reports its original missing-EGL failure; three
  voice retries pass. Ordinary outgoing voice and malformed IPC tests pass.

## Remaining live-call work

Do not enable live video in the app based on these tests alone. The actual video codec
offer/answer, confirmed-state PCM/video startup, encoded Peer RTP delivery,
remote decoding/rendering, mute/camera switching, device removal, and UI call
lifecycle still need integration and verification. The standalone H.264 codec
roundtrip is separate evidence and does not prove these live Peer paths.

## Answer/encoding integration and a fixed negotiation bug

The config must independently set **both** `videoCall` and `supportVideoCall`.
The latter uses the original JNI setter at `0x2c9b20` (CallConfig byte `0x34`),
which `_initCallConfig` passes to `CallController::setSupportVideoCall`.
With the support flag omitted, the native offer has `callType: 0`, no video
codec, and `updateCallerInfo` downgrades the controller's video mode to false.
The capture thread and audio may still run, but no video is encoded. Earlier
capture-only tests did not detect this; the answer test now asserts video mode
remains true and encoded output increases.

With both flags set, the actual native offer contains `callType: 1` and
`video.codec: [{"name":"h264","payload":97}]`. The offline answer test reuses
this native extension and audio offer as its explicit synthetic partner media,
applies the original JNI caller-info update, mocks only the desktop 408 ACK,
and dispatches CONFIRMED with temporary silent audio devices:

```sh
node native/android-zrtc/test-outgoing-answer-pcm.mjs RUNTIME_DIR --cpu-video
```

Three verified cycles each accepted 30 capture frames, delivered 30 inputs to
the Peer encoder, and produced 27 nonempty H.264 outputs (1,541 bytes for the
flat synthetic fixture). PCM capture/playback also advanced and stopped cleanly.
These are **local encoding and lifecycle** results, not remote RTP delivery.

The `videoStats` command reads native codec ID, media eligibility, capture
thread state, FPS and native capture/encoder input samples. Native
`GetEncodeStats` still reports `0/0`; those opaque fields are not interpreted
as encoded-output counters. Actual encoded frame/byte totals are observed at
the original codec `SendData` entry, using its checked 17-byte prologue and an
unchanged call-through trampoline. The original Peer callback and PayloadRouter
still receive the original arguments and return value. Totals are cumulative
for the worker and are not packet or delivery counters.

## Experimental loopback transport

The diagnostic-only network opt-in can now run CPU video alongside the existing
native UDP transport. No agent/UI path enables it. Its command-line equivalent
requires all of `--cpu-video`, `--signaling-network`, and `--cpu-video-network`;
the last flag without the first two is rejected.

```sh
node native/android-zrtc/test-outgoing-answer-pcm.mjs RUNTIME_DIR --video-loopback
```

This test binds only `127.0.0.1` and uses temporary silent audio devices.
The synthetic relay now answers the exact fixture initialization request with
a type-2 success response and a **nonzero connection ID** at byte 29. Earlier
zero-ID responses reached the native handler but left selection index -1.
The corrected responder produces the real `onInitZrtpWithServer` callback;
the test waits for it rather than forcing native server readiness.

The original response parser is `ZRTPPacket::_parsePacketInternal` (`0x3a74d0`),
with controller handler at `0x3c9fb0`. Outbound video is a type-13 envelope,
four-byte relay connection ID, then RTP. Investigation of actual received
packets found the pinned engine's dialect differs from RFC 6184 packetization:
PT **98** carries the keyframe, PT **97** the subsequent delta frames, with
Annex-B access-unit bytes after the RTP header/extension. The earlier PT-97-only
counter omitted every keyframe and could not prove decodability.

`h264-rtp-diagnostic.mjs` retains its strict RFC 6184 mode and adds an explicit
`zrtc-annexb` diagnostic option. It does not guess formats or silently reinterpret
standard H.264 RTP. The dialect mode requires ordered, single-source,
contiguous packets. It supports both whole access units and the observed
fragment wrapper `1c 80` (start), `1c 00` (middle), `1c 40` (end). This wrapper
retains the entire Annex-B byte stream; do not reconstruct an additional NAL
header byte as in standard FU-A. End flags must match the RTP marker, while
timestamp and payload type stay constant throughout an access unit. A partial
unit, missing sequence, unexpected marker or oversized unit is rejected.
It is still not a production jitter buffer, loss/retransmission handler or
SRTP implementation. Real camera loopback evidence is recorded below; remote
account interoperability still needs separate validation.

Verified on 2026-09-09: three clean cycles received **81 H.264 RTP packets /
6,243 RTP bytes**. Independent FFmpeg decoding produced **27 frames per cycle**
at **480×360**; every decoded frame's pixel checksum matched the flat NV21
fixture. The native default encoder downscales the 640×480 capture input;
capture dimensions must not be advertised as decoded/output dimensions.
PCM capture/playback and teardown still pass in the same test.

### Motion and fragmented-frame fixture

```sh
node native/android-zrtc/test-outgoing-answer-pcm.mjs RUNTIME_DIR --video-motion-loopback
node native/android-zrtc/test-h264-rtp-diagnostic.mjs
```

The deterministic moving-checkerboard fixture exercises large encoded frames,
without camera capture or personal media. Three verified cycles each encoded
27 frames / 154,860 bytes and received 131 video RTP packets; independent FFmpeg
decoded all 27 into distinct 480×360 images without error output. Total received
video RTP: **393 packets / 473,172 bytes**. Unit tests cover fragment boundaries
(including a split Annex-B prefix), missing start/end/sequence, timestamp/type
mismatch and marker validation.

Stopping immediately after the last submitted frame initially yielded only nine
decoded frames because the sender still had queued video. The fixture now waits
for all encoded access units to arrive (bounded at five seconds) before stopping
and verifies the complete count. Measured drain time was **1,600–1,609 ms** after
capture submission finished. This is useful transport evidence, **not acceptable
real-time latency proof**. Rate-control/pacing behavior under sustained camera
input must be measured and integrated; do not add this drain delay to normal
user hangup or claim that the queued stream is already a low-latency video call.

### Logitech camera through the native sender

```sh
node native/android-zrtc/test-camera-pump.mjs
node native/android-zrtc/test-outgoing-answer-pcm.mjs RUNTIME_DIR --video-camera-loopback
```

`camera-pump.mjs` provides reusable V4L2 MJPEG 640×480@30 capture via FFmpeg,
NV21 framing and sequential submission to the native worker. There is only one
outstanding frame request and one camera owner per worker. It requires an
explicit `/dev/videoN` path; continuous capture requires an AbortSignal. The
caller must await the pump's completion before destroying the worker. Stall,
abort, disconnect, malformed/partial frames and native rejection release the
capture child; termination escalates to SIGKILL after two seconds if necessary.
The unit test also checks cancellation while a native frame request is pending.
Only this fixed capture format has been integrated; device/format selection and
hotplug recovery in the live call UI are not complete.

On 2026-09-09 the real Logitech C922 at `/dev/video0` passed three loopback cycles:
30 submitted frames and 27 independently decoded 480×360 frames per cycle,
all with distinct image checksums. The listener received **97 H.264 RTP packets /
51,803 RTP bytes**. Remaining sender drain time after capture completion measured
0 ms for this scene, unlike the synthetic stress pattern. This is not an
exposure-to-display latency measurement. PCM remained on silent virtual devices;
no physical microphone was used, no images were saved, and no media left the
loopback interface. FFmpeg/camera ownership was released between cycles.

This proves real camera → native encoding → local UDP → independently decoded
frames. It does **not** prove interoperability with another Zalo account, inbound native decoding/rendering,
video-call controls or full video-call readiness. The app defaults to voice;
an outgoing-only experimental camera branch is now present in the agent but
has not been exercised against another Zalo account. See
[OUTGOING-VIDEO.md](OUTGOING-VIDEO.md) for its gates and remaining work.

### Native inbound decoder (local synthetic relay)

```sh
node native/android-zrtc/test-outgoing-answer-pcm.mjs RUNTIME_DIR --video-receive-loopback
```

Verified on 2026-09-09: three cycles each delivered 27 frames through the original
native receive/jitter/H.264 decode path, **81 decoded frames at 480×360** total.
The isolated relay converts outbound type 13 (connection ID + RTP) into inbound
type 14 (RTP only), rewriting the SSRC to synthetic partner 456. It responds only
to the existing fixture handshake and sends back to the local sender socket.
No real account, camera, physical microphone or external relay is involved.

A checked call-through observer on the pinned library's `FrameToRender` records
the frame count and original `VideoFrame.width()/height()` results, then invokes
the original function and callbacks unchanged. `videoStats` exposes cumulative
`decodedFrames`, `decodedWidth` and `decodedHeight`; tests compare per-cycle
deltas. The observer is installed only with the experimental CPU-video adapter.
The native decoder is not replaced with FFmpeg. Independent FFmpeg decoding of
the outgoing packets additionally checks the synthetic pixels, but native
decoded pixels are now also exported and compared by the IPC test below.

This establishes native inbound decoding for ordered, lossless, flat-image
loopback traffic. It does not establish a visible remote-video window,
fragmented inbound frames, loss recovery, real-account
interoperability or exposure-to-display latency. The next integration step is
a lifetime-safe CPU frame export and Linux display path, followed by those
acceptance tests. The actual Zalo process was not restarted by this diagnostic.

### Owned CPU frame mailbox

`video-frame-store.c` now receives I420 planes synchronously from that observer,
using the original const `VideoFrame.buffer(PlaneType)` and `stride(PlaneType)`
methods (pinned plane IDs Y=0, U=1, V=2). It packs rows without native padding
into one bounded latest-frame mailbox; no decoder-owned pointers survive the
callback. The C snapshot API copies pixels and dimensions/sequence atomically
into caller-owned memory. Even dimensions up to 1920×1080 are supported;
unsupported layouts are rejected. It has no unbounded queue or disk output.

Stopping disables publication and clears retained pixels under the same mutex,
before native teardown; late callbacks cannot repopulate it. Starting the next
call clears the mailbox again and retains a monotonically increasing sequence.
The decoder callback still forwards to the original function unchanged.

The host unit test passes AddressSanitizer/UndefinedBehaviorSanitizer, covering
stride packing, recycling input memory, short destination buffers, invalid
dimensions and stop/restart isolation:

```sh
cc -Wall -Wextra -Werror -fsanitize=address,undefined -pthread \
  native/android-zrtc/test-video-frame-store.c native/android-zrtc/video-frame-store.c \
  -o /tmp/zrtc-test-video-frame-store
/tmp/zrtc-test-video-frame-store
```

The rebuilt worker also passed the three-cycle native inbound fixture with the
mailbox attached (81 decoded frames).

### Pull-based snapshot IPC

Worker operation 15, `videoSnapshot`, returns the current mailbox image as I420
with width, height, monotonically increasing sequence (decimal string), and
base64 pixels inside response data. `-ENODATA` means no current-call image;
voice-only workers reject it with `-ENOTSUP`. Requests have no payload. The
consumer must not log or persist response data. `video-snapshot.mjs` strictly
validates dimensions, encoding, byte count and 64-bit sequence before exposing
an owned Buffer. `test-video-snapshot.mjs` covers malformed replies and the
1920×1080 bound. The worker response bound is now 8 MiB to fit a maximum-size
snapshot (~4.2 MB encoded). This is a bounded initial transport, not a claim
that base64 is an efficient final full-rate video path.

The real native receive fixture verifies every byte of a 480×360 I420 snapshot
against the flat synthetic input in each of three cycles, not merely a decoded
frame counter. Snapshots after stop and before the next call must be absent.
The test also passed at least 15 pixel-checked snapshots requested while capture
and native decoding were still active, with nondecreasing sequence numbers.
No media is saved or logged. Display integration, color/motion correctness,
orientation, sustained frame rate and real-account calls remain acceptance gates.

### Display consumer components

`remote-video-pump.mjs` pulls snapshots sequentially and awaits each render,
suppresses duplicate sequence numbers, rejects sequence regression, and clears
the display when the image disappears or the loop exits. Abort during a worker
request prevents late rendering; abort during rendering waits for that operation
before clearing. The owner must await the pump before destroying the worker or
canvas. Only one consumer is allowed per worker. Decoded Buffers are zeroed after
the renderer finishes consuming them. The pump has a bounded 1–60 fps cadence,
but no measured full-rate performance claim is made.

`canvas-video-renderer.mjs` accepts a caller-owned 2D canvas, preserves decoded
pixel dimensions, and uses `i420-rgba.mjs` as the CPU fallback. The current color
conversion assumes limited-range BT.601; color metadata negotiation and rotation
are not implemented. Unit vectors cover black, white, red, green and blue.
Pump lifecycle tests cover backpressure, abort while rendering/requesting,
duplicate frames, disappearance and renderer failure. The canvas adapter test
uses a mocked context, **not a rendered browser or live call window**.

```sh
node native/android-zrtc/test-remote-video-pump.mjs
node native/android-zrtc/test-canvas-video-renderer.mjs
```

The source integration below now attaches the consumer to a scoped media route.
A real canvas/Electron acceptance test and user-assisted remote video are still
required. Do not route base64 media through existing signaling capture logs.

### Dedicated media pipe protocol

`video-pipe.cjs` implements a separate duplex channel for the agent/display
boundary, without using signaling capture or application log callbacks. Each
record has little-endian length, request ID, kind (frame/clear), dimensions,
64-bit frame sequence and packed I420 pixels. Bounds match the mailbox. The
receiver validates framing/dimensions and acknowledges the request ID only after
the supplied renderer completes. One frame is in flight; a five-second missing
ACK closes the sink instead of accumulating frames. Media buffers owned by this
layer are zeroed after consumption/write completion. Owners must still clear
and dispose their actual display on pipe termination.

`node native/android-zrtc/test-video-pipe.cjs` passed fragmented record/ACK,
renderer backpressure, clear, buffer erasure, timeout and explicit-close tests
using paired in-memory Duplex streams. It caught an ACK-before-ready race:
receiver state and retained pixels must be released before sending the ACK.
The source integration below wires the helper's inherited descriptors to an
Electron window. Malformed-input coverage still needs expansion. No claim of
visible video, live process integration or sandbox isolation follows from the
in-memory protocol test.

### Experimental app wiring (source only; not deployed/restarted)

On Linux with the explicit video/network/media flags, the main-process helper
spawn now allocates a dedicated duplex fd 3 and attaches `video-window.cjs`.
Only the host supplies `ZALO_ZCALL_VIDEO_PIPE=3`; normal voice spawning removes
that inherited variable. The agent opens that descriptor, then after answered
video negotiation runs `runVideoMedia` inside its existing invitation/camera
lifetime. Camera and remote-display pumps share cancellation and are joined
before worker teardown. A closed display pipe cancels the media session even
when no new remote frames are arriving. No frame is sent via `sendToHost`.

The display host lazily creates a local BrowserWindow on the first image, with
context isolation, sandbox, no page Node integration, denied permissions,
blocked navigation/new windows and a no-network CSP. A minimal preload exposes
only the frame subscription, internally returning painted ACKs. Main validates
the ACK sender and request ID. Clear destroys the current video window without
closing the reusable helper pipe; user close now sends a call-cancel control
and triggers the existing outgoing-call cancellation path. The view preserves aspect ratio
and follows the requested gray palette. It is an Electron Linux window using
the native media engine, **not a Qt widget rewrite**.

`test-video-media-session.mjs` verifies joined camera/display teardown for local
cancel, camera failure and display close. `test-video-window.cjs` covers private
pipe -> scoped ACK, restricted window configuration, permission handlers,
clear/recreate and listener disposal using mock Electron boundaries. Those
tests and existing outgoing invitation/setup tests pass. They do **not** prove
actual preload execution, compositor output or a real-account video call.

These latest main-process changes have not been copied into the installed app;
do not mix the new helper with the older installed host (it has no video fd).
The window currently lacks local preview, account title, mic/camera controls
and lock integration. Native incoming video remains unsupported. Full live
acceptance and privacy testing are required before enabling video by default.

### Real Electron fixture acceptance

On 2026-09-09, `test-video-electron.cjs` ran separately from the account app
using the installed Electron 22.3.27 binary, a fresh temporary profile and CDP
bound to localhost port 9239. It spawns a separate Node-mode sender with an
actual inherited duplex fd 3, then uses the production pipe, window, preload,
canvas and ACK modules. Only synthetic four-color I420 frames are generated;
no account, native decoder, camera, microphone or external relay participates.

Agent-browser verified the exact fixture file URL and read actual canvas pixels:
640×480, black `[0,0,0,255]`, white `[255,255,255,255]`, red `[255,0,0,255]`, blue
`[0,0,255,255]`. The waiting status was hidden and page `typeof require` was
`undefined`. A screenshot was visually inspected (synthetic colors only).
Clear produced an ACK and destroyed the window; another frame recreated it
on the same pipe with successful rendering/ACK. Closing the window as a user
caused subsequent media to be rejected. The revised fixture explicitly tests
that rejection (`closed` command) and exits zero only on its expected result;
child test failures now propagate nonzero exit status. The fixture processes
and its agent-browser session were closed afterward; the account app was not.

The initial normal launch failed because the installed `chrome-sandbox` SUID
helper is not configured correctly. This account-free test was approved and
rerun with `--no-sandbox --disable-gpu`. Therefore page Node isolation and actual
rendering were tested, **OS sandbox enforcement and GPU output were not**.
Do not turn that test switch into a new release default or change system SUID
permissions without separate authorization. Safe sandbox packaging remains a
release gate. Temporary fixture profile directories are left under `/tmp`.

Reproduce with an unused local CDP port and the actual Electron binary:

```sh
electron --remote-debugging-address=127.0.0.1 --remote-debugging-port=9239 \
  native/android-zrtc/test-video-electron.cjs
```

Current stdin commands: `frame`, `clear`, `quit`; after closing the video window,
`reopen` verifies current-call rejection, clears it and starts another frame on
the same pipe. The earlier `closed` command tested the superseded permanent-pipe
close behavior. The fixture self-terminates after
three minutes. Use agent-browser with a separate named session for inspection.
The four-color fixture alone does not prove native decoder → real window;
the combined fixture below now covers that local pipeline. Neither proves
live two-account video, lock privacy, frame-rate/latency or reopening a call
after the user has permanently closed its helper media pipe.

### Combined native decode → real display fixture

```sh
electron --remote-debugging-address=127.0.0.1 --remote-debugging-port=9239 \
  native/android-zrtc/test-video-electron.cjs --native-loopback /absolute/RUNTIME_DIR
```

This mode spawns the existing native receive loopback test with its private
display fd. The production `runRemoteVideo` consumes actual worker snapshots,
verifies their I420 pixels, forwards them through the inherited pipe and waits
for the actual Electron canvas ACK. It stops/joins the pump and clears the
window between three native call cycles. The final image remains for a bounded
15-second inspection interval, after which the fixture finishes automatically.

Verified on 2026-09-09 with the same explicitly approved account-free
`--no-sandbox --disable-gpu` limitation: native encoding and decoding each
produced **81 frames**, the loopback relay received **81 RTP packets / 6,243
RTP bytes**, and **66 frames** reached painted ACKs. The latest-frame consumer
can skip frames; this count is not an FPS measurement or a claim of no drops.
All native snapshot pixels checked in the test matched the synthetic flat
image. Agent-browser inspected the real fixture canvas at **480×360**, waiting
status hidden, no page `require`, with RGBA sample **[130,130,130,255]**, as
expected from limited-range I420 [128,128,128]. A later all-canvas-pixels check
missed the inspection interval after the fixture exited and is **not counted
as passing**. Child test/host exited zero; no fixture null-sink modules remained.
The account application was not restarted or connected to a real caller.

This is now local native encode → relay → native decode → snapshot consumer →
inherited pipe → Electron canvas evidence. Color/motion interoperability,
incoming video, sustained latency, privacy controls and real-account acceptance
are still required before video is release-ready.

### Call cancellation without destroying the helper pipe

The display-close behavior was revised after the real fixture exposed the
recovery limitation. Reverse control word zero now means cancel the current
call, distinct from numbered ACKs and actual transport closure. The sink blocks
new frame submissions while canceled; successful clear ACK resets that state
for the next call. The receiver drops old-call frames until clear. If the user
closes during rendering, the outstanding request is released without pretending
the frame was painted; normal teardown can then send clear without deadlock.
Only actual pipe failure/renderer crash/timeout permanently disposes the route.

`runVideoMedia` subscribes to call cancellation separately from pipe failure,
aborts both pumps and awaits cleanup, then removes both subscriptions. Boundary
tests now pass user cancellation while idle and during an outstanding renderer
request, clear and next-call window recreation on the same pipe, and joined
media teardown. The revised recovery protocol was subsequently verified in
real Electron on 2026-09-09: agent-browser closed the first window; `reopen`
verified canceled-frame rejection, clear ACK and a new window on the same
inherited pipe. The new canvas was 640 pixels wide and its red-bar sample was
[255,0,0,255]. The fixture exited zero via `quit`; its automation session was
closed. This used the same account-free no-sandbox/CPU-rendering caveat above.

### App-lock bridge (source only)

Both bundled store implementations of `setAppLock` now publish an optional
boolean `linux-app-lock` message through the existing native-call bridge.
Main intercepts it before helper startup/signaling, accepts only the main
window's webContents sender and a boolean payload, retains the state for a
future video helper, and updates an existing display host. The display host
destroys the video window, cancels the current media session, and refuses to
create a window while locked (including frames arriving during load). Unlock
does not automatically resume the previous call; normal clear/new-call
lifecycle remains required. No password or passcode value crosses this bridge.

`scripts/test-video-lock-bridge.cjs` executes the actual extracted bundled store
methods and main guard, covering both lock values, optional delivery, wrong
sender and wrong type. Display boundary tests cover locked-window destruction,
rejecting new windows while locked, and new-call recovery after unlock. Header
regressions still pass. Actual account passcode, lock/unlock during a live call,
system-screen-lock and notification privacy remain unverified. These newest
bundle changes are **not deployed** into the installed application yet.

Additional lock-race coverage found and fixed an idle-helper cancellation bug:
locking with no video window must retain the lock state without sending a
cancel event that would poison the next call after unlock. Cancellation is now
deduplicated per call and emitted only for an active/loading window or a frame
attempt while locked. The boundary test covers idle lock/unlock followed by a
new call, repeated lock notifications, and lock then unlock while `loadFile`
is pending: the canceled loading window must never be shown, even after unlock.
Clear and a new call subsequently recreate the window successfully. These race
checks are deterministic mock-Electron tests, not live-account acceptance.

### Incoming CPU video: offline native entry

The worker now permits `incomingCall` with CPU video **only in offline mode**;
CPU-video incoming with networking remains `-ENOTSUP`. The live incoming
session/agent is not enabled by this change. Incoming setup now also propagates
the original `Peer.initialize()` failure code instead of returning success
solely because `Peer.incomingCall()` accepted the request.

`test-worker-incoming-video.mjs RUNTIME_DIR` passed three original-native
incoming H.264/ringing/stop cycles using a native-generated codec offer and
synthetic identities/endpoints. Each cycle retained video mode and H.264 codec
ID 4, had no native fault, and left no snapshot after stop. `CONFIRMED` remained
rejected without PCM devices. This is initialization/ringing evidence, **not
answered media or incoming network interoperability**. The existing offline
voice incoming regression is run separately to cover its original behavior.
Next required steps are answered incoming CPU media with silent devices,
receive/send loopback, strict incoming signaling mapping and actual user calls.

The same fixture now supports `--pcm`, loading its own silent PulseAudio null
sink and never opening physical devices. Verified on 2026-09-09: three incoming
cycles set original native `CONFIRMED`, submitted 30 synthetic NV21 frames,
and each produced **27 encoded frames / 1,541 encoded bytes** through the native
Peer. Native media-transfer/capture-thread flags were active; recorded/played
PCM counters both advanced. Stop froze the counters and left no PCM children;
the worker exited zero and the fixture unloaded its null sink in `finally`.

```sh
node native/android-zrtc/test-worker-incoming-video.mjs RUNTIME_DIR --pcm
```

This adds answered incoming CPU encode/PCM/teardown evidence, with call state
set by the fixture rather than real answer/ACK signaling. Incoming network video
remains disabled. It does not prove relay reception, remote video decoding on
the callee path or an actual caller/account exchange.

### Incoming relay diagnostic — resolved fixture ordering failure

The worker's existing explicit `--cpu-video-network` capability now also permits
the incoming native entry for isolated relay investigation. The desktop agent's
incoming-video route remains disabled; normal voice defaults are unchanged.
`test-worker-incoming-video.mjs RUNTIME_DIR --loopback` supplies only a bound
localhost relay and silent PCM devices, echoes video RTP as incoming type 14,
and requires at least 20 decoded frames plus exact synthetic I420 pixels.

Initial result: **FAIL**. The Peer encoded approximately 27 frames, but the relay
observes one type-1 initialization request and no video RTP packets; decoded
count stays zero. Callee init is 38 bytes with command **12**, unlike caller
command 11. Synthetic identity fields match user 123, call 789, partner 456.
Updating the exact-fixture responder to command 12 alone did not establish media.
Fixture failures still execute worker/null-sink cleanup. The offline answered
and voice tests remain separate passing evidence, not substitutes for this gate.

Resolved on 2026-09-09: the fixture advanced to RINGING/CONFIRMED before native
relay readiness. Inspection of `CallController.handleZRTPPacket` at 0x3ca053
showed init commands 11/12 share dispatch, but current state changes the server
validation path (the state-5 branch compares the selected server address).
The fixture now waits for the actual `onIncomingCall` callback correlated to
the `incomingCall` request ID before changing call state, matching the existing
IncomingSession readiness contract. It does not force readiness or patch out
the native validation.

The revised localhost test **passes all three cycles**: 27 native encoded frames
/ 1,541 bytes per cycle, at least 20 native decoded frames per cycle, and exact
480×360 I420 snapshot pixel equality. Silent PCM counters advanced and stopped
cleanly; snapshots were absent after stop and worker teardown exited zero.
This verifies native callee-role relay media using a synthetic local peer.
It does not verify desktop 402 answer / 408 ACK signaling or incoming real-account
video, and the desktop incoming-video route is still disabled.

### Incoming video signaling boundary and ringing coordinator

`decodeIncomingVideo` requires explicit experimental opt-in and a verified
native local identity, validates recipient/caller/call ID using the original
voice boundary, requires numeric video enable 1 and a callType-1 H.264 payload-97
extension. Voice decoding remains strict and does not downgrade video. JSON
parse errors are redacted. `incomingVideoConfig` retains existing address,
identity and dynamic-server restrictions, then sets both native video flags.

`IncomingSession` now has strict boolean `allowVideo` (default false). Explicit
`incoming(config,{video:true})` or control context `video:true` uses that validated
mapping only when enabled. The existing request-correlated native readiness,
407 signaling and RINGING sequence is unchanged. It does not answer, start
capture or enter CONFIRMED. The app agent does not yet instantiate this enabled
incoming route; answer signaling and user-choice UI remain integration work.

`test-incoming-video-control.mjs` passes opt-in/identity/media/codec/flag/error
checks. `test-incoming-video-session.mjs` verifies default rejection before
native mutation, configured video flags, readiness → 407 → ringing only, no
capture/answer commands and listener cleanup using boundary stubs. Existing
voice control and real offline incoming coordinator regressions still pass.
This is source-level integration evidence, not live incoming video acceptance.

### Native connection data for answering

Worker operation 16, `callInfo`, now invokes original
`PeerJNI_zrtc_peer_get_call_info` (pinned ELF 0x2c88a0). It requires an initialized
active call attempt and an empty command payload; after stop it returns
`-ENOTCONN`. This is private connection/state data, not a logging API. Consumers
must never dump its raw JSON or session value into signaling diagnostics.

The real callee localhost fixture reads it after correlated native readiness:
`rtpAddress` and `rtcpAddress` exactly match the selected fixture relay and
`sessionId` is a string. The native JSON also exposes state/role/media/camera
status fields; their semantics must be validated before use. This provides
authoritative selected-connection data needed by the desktop 402 answer call,
whose bundled renderer expects callerId, callId, status, codec, extendData,
rtcpAddress, rtpAddress and session. It does not itself send 402, validate a
remote ACK or authorize starting camera/CONFIRMED. Those steps remain open.

`incoming-answer.mjs` now prepares that exact payload from `callInfo`,
`audioCodecs` and `extendData`, retaining the explicitly supplied desktop caller
ID as a decimal string rather than narrowing it to the native uint32 identity.
It validates selected IP/port addresses, a nonempty session, audio payloads and
the requested video extension. Parse failures do not expose private JSON.
Cancellation and ownership are checked before and after every native query.

`IncomingSession.prepareAnswer({callerId,signal})` is available only while
ringing, retains the session's call ID/media choice, and captures its generation
and native attempt. A delayed query from a stopped call cannot continue reading
the replacement call's codecs or alter its state. The application owner must
supply the desktop caller identity associated with the accepted invitation;
this helper is not an identity lookup. Preparation does not send 402, represent
user acceptance, or start media.

Verified with `test-incoming-answer.mjs`, `test-incoming-video-session.mjs` and
the original offline voice coordinator regression. The real
`test-worker-incoming-video.mjs RUNTIME --loopback` also prepares an answer in
each of three callee cycles from native connection data (no session logging),
then separately exercises synthetic media: 27 encoded frames/1541 encoded bytes
per cycle and pixel-verified 480×360 decoded snapshots. This fixture does not
send the prepared answer. Live 402/remote-ACK correlation and desktop incoming
video UI integration remain incomplete.

### Answer signaling evidence and diagnostic privacy

The bundled desktop `handleSendSignal` maps 402 to `sendAnswerCall` and 408
to `sendAnswerACKCall`. Do not treat an API response to 402 as the remote ACK,
or use Android's `RECEIVED_403` enum name as a desktop socket-command mapping.
The incoming control action/payload for the remote ACK still needs verification.

Pinned classes5.dex provides additional answer-send evidence:
`vz.s0` calls `IVoipZalo.voiceRequestAnswer` at 0x06ceb0 and queues its
`s0$j` runnable; that runnable dispatches native `SEND_402` (enum field B)
at 0x062ff0. The response handler at 0x0631aa checks success and matches
the response call ID before queuing `s0$a$b`, which dispatches
`SEND_402_SUCCESS` (field C) at 0x062898. These observations do not prove
the remaining desktop remote-ACK transition or authorize CONFIRMED.

Before wiring native answer data into that renderer, both compact and shared
bundles were changed to remove raw signaling request/response objects from
their send/receive/unsupported-command logs. The ordinary error callback logs
only an integer API error code (or null), not the error/request object. The
actual authenticated API payload and native response are unchanged.
`node scripts/test-signaling-log-privacy.cjs` executes these actual methods in
both bundles with synthetic private values and checks exact log output and
unchanged 402 transport data. This covers these four logging boundaries, not
a whole-app logging audit or the separate end-call-log retry path. Changes
remain source-only pending coordinated deployment and restart approval.

`IncomingSession.answer({callerId,userAccepted:true})` now implements the send
transaction through `awaiting-answer-ack`. It reserves the ringing attempt,
prepares native connection data with generation checks, issues desktop 402,
dispatches `SEND_402`, and dispatches `SEND_402_SUCCESS` only after the desktop
transport resolves successfully. It rejects repeated acceptance and missing
explicit user consent. Stop cancels the outstanding 402 and joins the
transaction before permitting worker reuse. Native/API failure stops the
attempt. Even a synchronous stop from a phase listener cannot leave an answer
transaction running behind a replacement call.

`test-incoming-answer-session.mjs` verifies these boundaries with a fake desktop
API and worker, including a rejection with no error object. This is not a real
402 API exchange. Success returns `callReady:false`; the coordinator still does
not consume the remote ACK, enter CONFIRMED or start capture. No app UI invokes
this answer method yet. The offline native incoming coordinator and existing
video preparation regressions continue to pass.

### Desktop answer ACK structure, verified from original PE

Read-only disassembly of the locally installed Windows Zalo 26.8.20
`plugins/capture/ZaloCall.exe` (SHA-256
`a5c1f798ca38ca890b5f842f9d23662be9b10393a3f8f44f1c9efd30c0c87a07`)
resolves the previously unknown desktop ACK action. No Windows program was
started for this inspection. At VA 0x71e084 the deserializer compares the action
with `answer_ack` (string at 0x120191c), reads `data` at 0x71e0cc, and constructs
a four-byte ACK info object via thunk 0x419ba5 → 0x803210. That constructor reads
only `callId` (string at 0x1236a40) using the numeric/string JSON accessor at
0x7fc1c0. It does not require `uidFrom`. This is static parser evidence, not a
captured live incoming ACK.

`incoming-answer-ack.mjs` now decodes the corresponding authenticated desktop
control envelope, requiring `act_type:voip`, `act:answer_ack`, object data and
a strict uint32 call ID. It deliberately rejects partial numeric strings,
fractions, signs, whitespace and overflow rather than reproducing permissive
string-to-integer conversion. It does not interpret a `recvSignal` 402 response
as the remote ACK.

The coordinator correlates with its current call ID only while sending/waiting
for an answer or after acknowledgement. Wrong-call and pre-acceptance messages
are ignored; duplicates are identified. An ACK arriving before the 402 API
result is remembered but cannot bypass API success or native event success.
After both succeed, the phase becomes `answer-acknowledged`. The input must
come from the existing authenticated renderer transport; callId-only ACKs do
not independently authenticate a peer, and reuse of the same call ID on a
later attempt is not distinguishable from delayed delivery by this payload.

Tests `test-incoming-answer-ack.mjs` and `test-incoming-answer-session.mjs`
cover the grammar, early/late/wrong/duplicate ACK and unchanged failure/stop
handling. This advances the earlier send-only coordinator: no automatic
CONFIRMED or camera action has been added yet, and the app's incoming video
route remains unwired. Native media startup and live acceptance remain open.

### Bounded ACK waiting for the application owner

After `answer()` resolves, the incoming owner can now await
`waitForAnswerAck({timeoutMs:15000,signal})` before calling `startMedia()`.
The timeout is local safety policy (configurable from 1 to 120000 ms), not a
claim about a server protocol deadline. Only one wait may be active. An ACK
already received resolves immediately; API response success alone never does.
The coordinator clears timer/abort listeners after settlement. Timeout or abort
stops the current native attempt; explicit stop invalidates ownership before
rejecting the wait, so old cleanup cannot stop a replacement call.

This wait does not open a camera, does not automatically start media, and must
actually be awaited by the application owner; merely calling `answer()` does
not install a background ACK timeout. The app incoming UI route remains open.
Unit tests cover missing/early/late ACK, duplicate wait, invalid options,
successful-wait abort cleanup and stop/replacement isolation. The coordinated
localhost fixture now exercises this wait before native media startup; three
cycles pass with rebuilt worker, simulated desktop signaling and silent PCM.
