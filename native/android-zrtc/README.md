# ZRTC Android x86_64 running on the Linux host

Experimental, offline proof. **This does not enable Zalo calls yet.**

On 2026-09-09, the unmodified `libzrtc.so` from Zalo Android 21.12.01 was
loaded and executed on the host Linux kernel using the Android Bionic loader.
No Wine, emulator, Android container, root, mounted image, or Android system
services are used. The executable uses Bionic rather than glibc. It is a
separate native process, not a Node addon to load inside Electron.

## Verified

- `dlopen(..., RTLD_NOW)` resolves the dependency graph and runs constructors.
- The APK's Opus codec encodes/decodes 50 frames of synthetic 440 Hz audio:
  48,000 decoded samples, 6,552 encoded bytes, non-silent PCM. This verifies
  codec execution, not microphone/speaker I/O or subjective audio quality.
- `srtp_init` and `srtp_shutdown` both return 0. No SRTP network exchange is tested.
- Native `CallConfig` and `Peer` construct and destruct successfully.
- A newly constructed Peer reports voice/video call state false.
- `extract-jni.mjs` recovers all 173 registrations in `JNI_OnLoad`, including
  Java class names, method names, signatures and ELF function addresses.
  It reads ELF segments/RELA records; it does not run `JNI_OnLoad` or fake a JVM.

## Why the old attempt stalled

Matching x86_64 instructions is only one part of loading the library. Android
imports Bionic's `LIBC` symbol versions and uses its pthread/stdio/TLS ABI.
Renaming glibc libraries or satisfying names with indiscriminate stubs would
not establish ABI compatibility. Here a Bionic-linked executable is started
by the real `linker64`, keeping the original ABI across the entire process.
The installed SDK system image already contains the matching runtime, so no
Android OS has to be booted.

The loader's direct-execution mode is documented in
[AOSP linker_main.cpp](https://android.googlesource.com/platform/bionic/+/HEAD/linker/linker_main.cpp).
The audio probe uses the documented [Opus C API](https://opus-codec.org/docs/html_api/opus_8h.html).

## Explicit limitations

### Desktop integration preflight (2026-09-09)

`run-call-check.sh` accepts the same four arguments as `run-probe.sh`. It
first runs the successful load/codec/lifecycle checks, then exercises the
next boundary in a separate process with socket creation and sends denied
by a seccomp filter. This diagnostic uses an empty offline configuration,
not an account session; a refusal is not evidence of server incompatibility.

Observed result:

```
BOUNDARY: Peer::initialize returned -10
BOUNDARY: entering native Peer::makeCall; network denied; empty offline config
BOUNDARY: makeCall returned 0 (not a connected call)
NOT_READY: native loading works; call initialization does not
```

The process exits 78. Disassembly explains the initialization boundary:
`Peer::initialize` at `0x2d0750` starts with error -10, requires Android
initialization (`Peer+0x7f4`), a context-related pointer (`Peer+0x850`), and
`webrtc::JVM::GetInstance()` before `_initAudioDevice` / `_initAudioRtpRtcp`.
`Peer::setAndroidContext` at `0x2d02d0` sets the first flag from the result of
`_androidInit(JNIEnv*, jobject)`. Calling it with null JNI pointers is not
a valid replacement for the missing Android platform layer.

The installed desktop has two separate surfaces: the legacy `MainApp` wrapper
and the call-v2 socket helper. Its startup defaults to a Wine proxy; the repo's
call-v2 helper ends calls without a media backend. Neither can be made callable
merely by replacing its loader. No production launcher or installed call
implementation was changed by this preflight.

`platform-probe.c` supplies Android logging to stderr and **probe-only**
platform placeholders. In this build the resolved dependency closure does
not import GLES or libandroid functions. OpenSLES interface IDs are placeholders;
`slCreateEngine` prints UNIMPLEMENTED and exits 78 if reached. There is no audio
device implementation in that OpenSLES shim and it must not be shipped as a working call
backend. The supplied codec and zrtc binaries are unmodified.

The basic loader probe does not invoke `JNI_OnLoad`. The incremental
`run-call-check.sh --compat-audio` diagnostic now invokes the real `JNI_OnLoad`,
registers native methods, supplies a native JNI metadata/context adapter and
reaches the audio device's Init methods. It calls `Peer::stop(true)` before
destruction, fixing the observed destroyed-mutex crash. Unsupported JNI methods
fail explicitly; this is not a JVM or a complete Android compatibility layer.
Video/EGL and call callbacks remain incomplete. The diagnostic still returns
78: `Peer::initialize` returns -10 and offline `makeCall` returns false.

`pcm-host.c` implements real 48 kHz mono s16le recording/playback through the
Pulse simple API (also works with PipeWire's Pulse server). `pcm-bridge.c`
connects a Bionic parent to that separate glibc helper, strips Android `LD_*`
settings from the child, waits for stream readiness, and reaps helpers on close.
Helpers are killed automatically if their parent dies. The isolated null-sink
tests pass both directly and through Bionic (440 Hz amplitude 12000).
The separate `--engine` test now also executes real ZRTC record/playout callbacks
for three start/stop cycles. It caught and fixes two ABI/lifecycle issues:
`initRecording` takes rate/channels/source, and native stop clears the cached
buffer pointer, requiring recaching on every init. This does not prove a
connected call or non-silent RTP media.

To complete calling, implement native audio/video adapters and the Java-facing
callback/configuration boundary, then connect the engine to the desktop's
authenticated signaling flow. The 2022 engine's compatibility with today's
service remains untested. Only an accepted call with bidirectional media can
validate that last step. No account login or calls are performed by this probe.

## Reproduce

Requires Linux x86_64, Android NDK (tested r27), 7-Zip (tested 26.00), unzip,
Node (for the static JNI table extractor), and the user's APKM/system image.
Do not use the NDK sysroot's libc.so as a runtime: it is a link-time stub.

```bash
bash native/android-zrtc/prepare-runtime.sh \
  /path/to/SDK/system-images/android-36/google_apis/x86_64/system.img \
  '/path/to/Zalo-21.12.01.apkm' /path/to/new-runtime-directory

bash native/android-zrtc/run-probe.sh \
  /path/to/SDK/ndk/27.0.12077973 \
  /path/to/new-runtime-directory/bionic \
  /path/to/new-runtime-directory/apk/lib/x86_64 \
  /path/to/probe-results

node native/android-zrtc/extract-jni.mjs \
  /path/to/new-runtime-directory/apk/lib/x86_64/libzrtc.so
```

Extraction temporarily requires about 5.3 GiB; large intermediates are removed
after extraction. The runner writes `probe.log`, compiles with warnings as
errors, applies a 20-second timeout and preserves failure exit codes. It
rejects an unrecognized libzrtc build before invoking version-specific exports.
The loader warning about absent `/linkerconfig/ld.config.txt` is expected on
the host: this probe supplies its library search path explicitly.

Pinned libzrtc SHA-256:
`c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe`

No APK or Android runtime binaries are included in this source directory.

## Audio transport checks

Use a running local Pulse/PipeWire server. Tests create and remove their own
null sink; they do not record the physical microphone or play physical speakers.
With `ndk_dir` and `runtime_dir` set to the paths above:

```bash
cc -Wall -Wextra -Werror -O2 native/android-zrtc/pcm-host.c \
  -o "$runtime_dir/results/pcm-host" -ldl
"$ndk_dir/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android21-clang" \
  -Wall -Wextra -Werror native/android-zrtc/pcm-bridge-probe.c \
  native/android-zrtc/pcm-bridge.c -o "$runtime_dir/results/pcm-bridge-probe" -lm
node native/android-zrtc/test-pcm.mjs "$runtime_dir/results/pcm-host"
node native/android-zrtc/test-pcm.mjs "$runtime_dir/results/pcm-host" --bridge \
  "$runtime_dir/bionic/linker64" "$runtime_dir/results/pcm-bridge-probe" \
  "$runtime_dir/bionic"
bash native/android-zrtc/run-call-check.sh "$ndk_dir" "$runtime_dir/bionic" \
  "$runtime_dir/apk/lib/x86_64" "$runtime_dir/results" --compat-audio
```

The last command intentionally returns 78, not success, until call readiness is
implemented. Its log should contain `native stop returned`, no FORTIFY failure,
and normal AudioRecord/AudioTrack/AudioManager teardown.

After the runner has built `call-boundary`, exercise the real engine callbacks:

```bash
node native/android-zrtc/test-pcm.mjs "$runtime_dir/results/pcm-host" --engine \
  "$runtime_dir/bionic/linker64" "$runtime_dir/results/call-boundary" \
  "$runtime_dir/bionic" "$runtime_dir/apk/lib/x86_64" "$runtime_dir/results/platform"
```

This harness accepts the expected offline exit 78 only when the engine PCM pass
marker and clean stop marker exist and no FORTIFY failure is reported. Its native
child allows AF_UNIX sockets for Pulse but rejects Internet socket creation.
No authenticated session or user account is loaded by this test.

## Typed native callbacks

`call-events.c` describes the 17 event signatures recovered from the actual
`JniCallCallback` constructor. `zrtc_linux_call_callback` accepts a synchronous
sink and an explicit network-type integer from its owner. Event strings are
borrowed until the sink returns; copy them before enqueueing IPC and do not log
session payloads. Unknown methods and signature mismatches fail closed.

```bash
bash native/android-zrtc/run-call-check.sh "$ndk_dir" "$runtime_dir/bionic" \
  "$runtime_dir/apk/lib/x86_64" "$runtime_dir/results" --compat-callbacks
```

The callback probe constructs the real native C++ adapter and invokes all 17
wrappers with typed synthetic data (including quotes, newline and backslash),
checks the network query roundtrip, then sends 10,000 string callbacks to test
JNI reference reclamation. Its network integer is deliberately a fixture, not
a claim about the host's network type. The overall diagnostic still exits 78
because call initialization is not complete. Passing callbacks does not prove
authenticated signaling, which is not yet wired to the desktop.

## Linux voice initialization adaptation

`voice-platform.c` is an optional, version-specific in-memory adaptation. The
Android engine checks for a non-null EGL reference before checking audio-only
mode. Linux voice needs no EGL. The adaptation retains the original EGL check
for every mode except native audio-only (1), then resumes the original
initializer: audio devices, RTP/RTCP, workers and statistics are not skipped.
Native `_initZrtcConfig` selects mode and performs initialization; this code does
not write the mode/initialized fields or return fabricated success.

The hash-verifying runner accepts `--compat-voice`. The adaptation additionally
checks the exact 14 original instruction bytes and refuses a mismatch or repeat
installation. It changes only process memory, using separate write/execute
protections; the APK library on disk remains byte-identical. Apply before workers
start and keep the module loaded for the process lifetime. This is pinned-x86_64
compatibility work, not a portable source rebuild of ZRTC.

```bash
bash native/android-zrtc/run-call-check.sh "$ndk_dir" "$runtime_dir/bionic" \
  "$runtime_dir/apk/lib/x86_64" "$runtime_dir/results" --compat-voice
node native/android-zrtc/test-pcm.mjs "$runtime_dir/results/pcm-host" --voice \
  "$runtime_dir/bionic/linker64" "$runtime_dir/results/call-boundary" \
  "$runtime_dir/bionic" "$runtime_dir/apk/lib/x86_64" "$runtime_dir/results/platform"
```

Observed: non-audio mode still returns -10 without EGL; native voice initialization
returns 0; three PCM cycles and teardown pass. The overall offline runner still
returns 78 because empty-config makeCall fails, and no call is connected. Tests
deny Internet sockets, so initialization success does not validate network I/O.
Video remains unimplemented; it is not silently routed to the voice path.

## Persistent worker (offline development stage)

```bash
bash native/android-zrtc/build-worker.sh "$ndk_dir" "$runtime_dir/bionic" \
  "$runtime_dir/apk/lib/x86_64" "$runtime_dir/results"
node native/android-zrtc/test-worker.mjs "$runtime_dir"
node native/android-zrtc/test-worker-wire.mjs "$runtime_dir"
```

`worker-client.mjs` provides `NativeWorker.start(runtimeDir)`,
`request(operation, config)` and `close()`. It checks the library hash, isolates
Bionic loader paths, bounds queued requests and response data, and kills the
worker on timeout/protocol failure. Native diagnostic output is drained without
exposing possible session payloads to application logs. Actual control uses
stdin and a dedicated fd 3 output stream, not mixed stdout logs.

Protocol version 1 requests: a little-endian uint32 payload length (8 bytes to
1 MiB), uint32 request ID, uint32 opcode, then optional payload. Opcodes:
1 initialize, 2 end-call/stop, 3 status, 4 shutdown, 5 configure, 6 makeCall.
Configure replaces the
native CallConfig using validated TLVs: uint32 field ID, uint32 byte length,
value. Fields 0–4 are uint32 `userId, partnerId, protocol, callId, clientVersion`;
5–7 are NUL-free strings `session, settings, zrtcConfig`. Duplicate/unknown fields
and truncated values are rejected before mutation. Configure while initialized
returns EBUSY. Initialization applies the real native CallConfig, then uses the
native voice initializer. IDs/settings in tests are synthetic.

Replies on fd 3 are newline-delimited JSON with matching ID, native/error code,
initialized/configured state and explicit `offline:true, callReady:false`.
Readiness has protocol version 1. Socket creation/connect is denied in this
worker build. It cannot be selected as a working call backend. Incoming/accept,
authenticated desktop signaling and real media integration remain incomplete;
existing installed Zalo is unchanged.

Tests cover five native init/stop cycles in one process, queued request IDs,
native config setters, EOF teardown, byte-fragmented/coalesced frames, malformed
lengths, invalid opcodes, invalid/duplicate fields, and client validation.

### Outgoing call and callback IPC

`request('makeCall', {servers: nonemptyJsonString})` sends opcode 6 followed by
the raw, NUL-free server-list string. It requires stored configuration and an
idle engine (do not call `initialize` first; native makeCall initializes itself).
The worker invokes real native makeCall with an actual JniCallCallback object.
Code 0 means the engine accepted an attempt, **not that a call connected**.
`offline:true, callReady:false` remains in every response.

Native callback events arrive on `worker.on('callEvent', handler)` as
`{type:'event', requestId, event, args}`. Integer/boolean/string values are
serialized under an output lock, with JSON string escaping; callbacks may arrive
before the command reply. Payloads (especially logs/session callbacks) can be
sensitive: consume them for signaling, not unconditional logging.

`stop`/`shutdown`/EOF call native `endCall(true)` before `Peer::stop(true)` when
an attempt exists. This is necessary: stopping workers alone leaves the call
controller active and prevents subsequent makeCall attempts. The callback object
is constructed per attempt. Adopted callbacks are destroyed by native teardown;
early-rejected adapters need explicit cleanup. The worker retains a local JNI
ref until end/stop and checks the constructor's single global ref to distinguish
these cases, avoiding double destruction and leaks. Simultaneous calls and
configuration changes are rejected.

```bash
node native/android-zrtc/test-worker-call.mjs "$runtime_dir"
```

This test sends three synthetic empty-server-list attempts, observes actual
`onMakeCall`/`onCallLog` events with correct correlation, and tests busy guards,
end/stop and retry. No server connection is possible in this worker build.

### Native signaling event codes

`protocol-enums.mjs` contains the 19 call-event ordinals and four network types
from the user's APK `classes2.dex` (SHA-256 recorded in the source). These were
recovered from the enum constructors, not guessed from desktop/socket numbers.
The native receiveCallEvent implementation independently special-cases 1 and 16
as start-call paths. Network type 0 is UNKNOWN, used by the offline worker.

`request('callEvent', {event:'SEND_401_SUCCESS'})` sends opcode 7 with a uint32
enum value. The worker bounds it to 0–18, requires an existing attempt, then
invokes the real JNI receiveCallEvent wrapper. Unknown names/codes are rejected.
Tests cover SEND_401 and its completion acknowledgment, plus rejection without
a call. This does not simulate successful server delivery; the test event is a
fixture. Production signaling must emit acknowledgments only after real success.

Do not confuse these with `setCallState` media states or socket commands 401,
402, etc. For example RECEIVED_402 is enum ordinal 9, SEND_402 is 12, and
START_INCOMING_CALL is 16. The full incoming/answer workflow remains unverified.

### Incoming boundary and codec query

`request('incomingCall', {rtpAddress, rtcpAddress, relayServer, audioCodec,
extendData})` sends opcode 8 with five uint32-length-prefixed, NUL-free strings.
The first three go to native incomingCall; the last two configure native
MediaCodecInfo through its JNI setters. All fields are required, though they may
be empty. Native address validation and codec negotiation are retained.
Rejection returns -EIO and cleans up before another attempt. Native strings use
the pinned NDK ABI/allocator, covering short and heap-backed representations.

`request('audioCodecs')` (opcode 9, initialized engine required) returns native
codec JSON in `response.data`. Querying before CallConfig is applied produces
`[]`; configuring then initializing with empty settings exposes
`[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]`.
The name includes rate/channels: plain `opus` does not match this offer.
This schema is confirmed by native AudioCodecItem parsing and the getter,
not a fabricated capability list.

```bash
node native/android-zrtc/test-worker-incoming.mjs "$runtime_dir"
```

The test exercises 10 successful offline incoming negotiations with that offer,
60 invalid-address/missing-codec failures, then 30 outgoing retries, including
callback cleanup and metadata reuse. Authenticated signaling, answer states
and real media still need integration: negotiation is not a connected call.

Diagnostic initialization had a separate lifecycle bug: `_initCallConfig`
sets isInCall while controller state remains 6; endCall requests state 6 and
therefore does nothing. After stopping a diagnostically configured peer, the
worker now destroys and recreates it through native JNI lifecycle/context APIs.
Configuration is retained separately, with no controller-memory override.
The test queries codecs through this path before making incoming attempts.
Numeric native incoming-stage diagnostics contain no session/address payloads.

### Media state input

`request('callState', {state:'RINGING'})` uses opcode 10 and the native
`zrtc_peer_set_call_state` JNI setter. This is separate from `callEvent`:
classes5.dex `i00.j0.V` sends SEND_407_SUCCESS then media state 3; the
establish-call path logs CONFIRMED and sends state 5. Source hash and native
entry-point evidence are recorded in `protocol-enums.mjs`.

Ten incoming tests now produce actual `onCallState(3)` callbacks, retaining
the incoming request ID. No event is synthesized. Unknown state names/socket
command numbers reject before dispatch, with native framing checks as well.
A successful response only means the void setter was dispatched.

EARLY=4 and CONFIRMED=5 are recognized but currently return -ENOTSUP: the
offline worker has no PCM host connection. An actual EARLY probe emitted
PRE_START_DEVICE (audio event 13), failed because ZRTC_PCM_HOST was absent,
then hit the unsupported OpenSLES fallback (exit 78). This is the next platform
integration gap, not evidence of a connected call. The existing standalone
Pulse/PCM tests have not yet been integrated into this worker.

Update: local PCM integration is now available as an explicit option:

```js
const worker = await NativeWorker.start(runtime, {pcm:{source, sink}});
```

Both device names must be supplied (no implicit physical microphone). This
enables `--local-pcm` and the existing glibc PCM helper, built by build-worker.sh.
The default worker still denies device sockets and rejects EARLY/CONFIRMED.
Local mode permits Unix sockets for Pulse; IP socket creation remains denied,
and startup verifies both IPv4/IPv6 return EPERM. Ready reports `localPcm` and
still reports `offline:true,callReady:false`.

`node native/android-zrtc/test-worker-pcm.mjs RUNTIME_DIR` creates its own
null sink and tests 3 incoming → RINGING → EARLY → CONFIRMED → stop cycles.
Real record/playout counters advance during each cycle, freeze after stop,
all helper children are reaped, and the worker exits 0. This is local PCM,
not non-silent RTP delivery or an authenticated connected call.

EARLY capture exposed a teardown race: AudioRecordJni continued delivering into
AudioDevice's destroyed EventTimeWatcher. The worker now explicitly stops the
real JNI recording/playout objects before native endCall/stop. An opt-in
`ZRTC_DEBUG_BACKTRACE=1` diagnostic prints module-relative abort stack offsets;
it is for debugging only (unwinding/stdio in a signal handler is not a hardened
production crash reporter). Ordinary native logs are not forwarded; only fixed
fault category names are emitted via `nativeFault`.

### Decoded desktop configuration adapter

`startDesktopVoice(worker, config, {role:'caller'|'callee', video:false})`
in `desktop-config.mjs` maps the existing `vcmac.js:setConfigData` contract:
fromId/toId → native userId/partnerId, sessId → session, settings/zrtc_config
→ JSON config strings, caller servers → makeCall, callee rtpIP/rtcpIP and
audioConfig/extendData → incomingCall. Supply already-decoded CallConfig;
this is not a parser for arbitrary `recvSignal` responses.

`test-desktop-config.mjs RUNTIME_DIR` executes the actual legacy wrapper with
a native-binding spy to compare argument mapping, then starts 5 genuine offline
native attempts with clean teardown. Parallel configuration attempts reject so
one call cannot overwrite another's IDs before makeCall. IDs outside uint32
reject instead of truncating. Explicit voice selection and zrtc_config are
required; video and enabled dynamic server switching reject until integrated.
Live response/config extraction and the desktop call-session coordinator remain
unfinished; no installed application entry point uses this adapter yet.

Device startup validation: the Node client now queries Pulse's exact device
names before starting a local-PCM worker and before EARLY/CONFIRMED. Missing
devices reject (or return ENODEV after local cleanup). This adds a runtime
dependency on `pactl` for local-PCM mode. Async checks are bounded and invalidated
on stop/configure. `test-worker-device-failure.mjs RUNTIME_DIR` removes a private
null sink after launch and verifies 3 failed starts produce zero frames and no
helper children. Normal 3-cycle PCM tests still pass.

OpenSLES now returns FEATURE_UNSUPPORTED rather than terminating; JNI stream
opening/transfer failures are counted, and synchronous startup failures become
ENODEV at the worker boundary. A real-server invalid-name experiment did not
fail as expected, so checking names is necessary but not sufficient: atomic
device pinning/check-open races and active stream device-loss recovery remain.
# Incoming control integration boundary (2026-09-09)

`incoming-control.mjs` accepts the live desktop envelope shape observed in the
passive test. `IncomingSession.control(message, {nativeLocalId, clientVersion})`
connects a validated voice request to the existing native incoming coordinator.
This is **not yet selected by the installed zcall-agent**.

The caller must provide a separately verified native local uint32 identity;
the decoder checks it against uidTo. It never converts local.id or uidN into a
native identity. It checks callId against params.id, requires video.enable to
be exactly zero, parses bounded JSON, and rejects malformed/unsupported input
before native mutation. Errors do not include JSON parser excerpts or secrets.
The proposed desktop mapping uses uidFrom as the caller, params session/server
configuration and the outer codec offer. APK d00.r.r0 at classes5.dex 0x043744
corroborates the params field names; **schema capture alone does not prove live
identity values or end-to-end media semantics**. Those remain integration gates.

Cancellation matches both caller and call ID. Duplicate requests do not start
another worker operation; stale cancellation cannot terminate the current call.
Tests exercise actual offline worker initialization/codec negotiation and three
cancel/retry cycles, without injecting readiness or sending 407:

```sh
node native/android-zrtc/test-incoming-control.mjs ~/.cache/zrtc-native-21.12.01
```

Online transport, verified identity supply, incoming UI, answer, outgoing call,
physical devices and video remain unfinished. Do not request another user call
test just to repeat the already confirmed control-delivery check.

### Native dynamic-ZRTP configuration flag

Worker configure TLV field 8 is the strict boolean `enableChangeZrtp` (four-byte
0/1 wire representation). It calls the original registered JNI setter
`zrtc_call_config_set_enable_change_ZRTP`, signature `(JZ)V`, address 0x2c9b30.
The pinned binary setter writes CallConfig byte +0x2d; replies read that native
byte back for verification. No native memory mutation or success override is
used outside the original setter. The JS boundary rejects non-booleans and the
C boundary rejects malformed or non-0/1 values before changing configuration.

`test-worker-config-flags.mjs` verifies four alternating real initialization/
stop cycles plus default reset. This ports configuration, **not online server
switching**. Mappers permit it only under explicit `offlineConfiguration:true`;
the normal online integration gate remains closed. The desktop setup agent
uses this only with its offline worker and now calls native initialize after
configure before reporting `configured-offline`.

### Explicit native networking

`NativeWorker.start(runtime,{network:true})` selects `--signaling-network`.
Default remains offline. Handshake and response `offline` values reflect the
actual mode, and the client verifies the requested capability on startup.
Network mode allows IPv4/IPv6 sockets and anonymous socketpairs (required by
libevent signal wakeups). Named Unix sockets remain denied unless local PCM is
separately enabled. Architecture and x32 checks remain active. Startup checks
exercise actual IP socket creation, socketpair creation, and Unix socket denial.
This is not an endpoint allowlist: callers must pass only authenticated/validated
server configuration. The installed setup agent does not select network mode yet.

`test-worker-network.mjs` runs the real engine against a synthetic loopback UDP
server. It received two packets (76 bytes), then verified stop and clean exit.
This proves transmission, not a valid server reply or media negotiation. The
APK callback at classes5.dex 0x07950c (`vz.p1.onInitZrtpWithServer`) queues 416;
`onMakeCall` alone does not. Online integration must wait for the former.

Live follow-up, 2026-09-09 14:07:33 ICT: `ZALO_ZCALL_NATIVE_NETWORK=1` in the
setup agent selected network mode. A CDP click in the user-selected contact's
conversation requested authenticated 401 config and called original native
makeCall. `outgoing-negotiation.mjs` received onInitZrtpWithServer with the
matching native request ID after about 0.51 seconds, then codec and extendData
queries succeeded. No readiness callback was injected. Probe then closed the
worker and did NOT emit 416 or claim ringing/accepted media.

The negotiation owner handles early callbacks, correlation, timeout and abort;
onCallChangeZRTP explicitly fails the attempt until server-change recovery is
implemented. `abortOnServerChange:true` is therefore a caller responsibility,
not a declaration of full switching support. Synthetic tests cover these gates.
Native worker opcode 11 exposes the original get_extend_data JNI getter.

Live follow-up, 2026-09-09 14:12 ICT: outgoing-invitation.mjs now holds the
worker through authenticated 416 and a correlated peer answer. The user
confirmed receiving and answering the invitation, but the peer remained at
“joining call”. The current observer sends 409 cleanup after observing answer;
408 acknowledgement, peer codec application and live PCM are NOT integrated.
API ACKs and the answer control do not establish media success.

Worker opcode 12 (`updateCallerInfo`) now accepts length-prefixed audioCodec
and extendData strings and calls the original media setters/update JNI function.
`test-worker-answer.mjs` verifies three real offline update/stop cycles and
disconnected-state rejection. Wire tests reject oversized string lengths,
embedded NULs and trailing bytes before mutation. This boundary is not yet
used by the currently running installed answer handler. Current device discovery sees only
an HDMI monitor source, not a physical microphone.

The repository agent now supports explicit `ZALO_ZCALL_NATIVE_MEDIA=1` with
`ZALO_ZCALL_PCM_SOURCE` and `ZALO_ZCALL_PCM_SINK` device names, in addition to
network/setup opt-ins. Worker preflight rejects missing devices before inviting.
The integrated answer path validates status 0 and correlated peer/call IDs,
applies negotiated codecs, sends 408, and dispatches CONFIRMED. Invitation
ownership then remains until local/remote stop or native failure, not until
answer observation. `media-started` is a dispatch milestone, not proof of
bidirectional remote audio. This path is not yet live-tested.

Source audit: pinned classes5.dex `i00.j0.v0` at 0x04cdb2 branches response 0
to `w0` (0x04d0a8); this applies MediaCodecInfo via `a9.b.o0`, then calls
`j0.u(true)` (0x04e3c8), sending the acknowledgement through `c1.d2` before
setting native media state 5. The current coordinator waits for the desktop
408 ACK before dispatching media. Tests: `test-outgoing-answer.mjs` and
`test-outgoing-invitation.mjs` (synthetic signaling; no remote media claim).

`test-outgoing-answer-pcm.mjs` now exercises that answer coordinator with real
native outgoing calls, original codec update and CONFIRMED audio on a private
null sink. Three cycles produced advancing capture/playback counters, stable
counters after stop, no child PCM helpers and clean exit. Only the 408 API is
mocked; this does not establish remote audio or microphone availability.
Invitation race tests additionally cover remote end before the answer task,
remote end during ACK, native runtime fault and worker exit while awaiting ACK.

## Video coding progress (not an end-to-end video call)

`test-video-codec.sh NDK_DIR RUNTIME_DIR` compiles an isolated, network-denied
probe for the pinned ELF. It constructs the original `WebRtcVideoCoding` owner
(allocation 0xf00 verified at Peer::_init 0x2d6c05) and uses its software
`initialize()` overload (0x397ba0), without Java/EGL texture initialization.
Native logs identify x264/H.264 baseline encoding. It connects the CPU
VideoSource adapter to original `deliverFrame` with 60 synthetic NV21 inputs.

Three cycles each produced 57 original encoded-image callbacks totaling
10,542 bytes. Callback slot 4 is verified by SendData at 0x39a41a; buffer and
length offsets 0x28/0x30 match its PayloadRouter arguments. Unknown callback
slots fail the diagnostic rather than pretending support. Raw frames and
encoded payloads are neither saved nor sent. `GetEncodeStats` returned 0/0,
so the diagnostic instead requires actual nonempty encoded callbacks.

This proves local CPU video encoding on the tested runtime, not valid remote
decoding, video RTP transport, negotiation, Peer video initialization, capture
ownership during a call, or a remote video window. The existing voice engine
and installed running app are not modified by this diagnostic.

An independent roundtrip check is available with:

```sh
node native/android-zrtc/test-video-roundtrip.mjs NDK_DIR RUNTIME_DIR
```

The probe's optional `--encoded-fd3` writes synthetic encoded bytes to an
anonymous pipe, separate from diagnostics. FFmpeg independently decodes that
stream to frame hashes; no image or encoded media file is retained. Three
cycles with a moving spatial pattern produced 171 decoded 480x360 frames and
57 distinct hashes. The test requires decoded count to equal the original
encoded callback count, at least 150 total frames and at least 40 distinct
decoded images. FFmpeg frame cadence must use `passthrough`; its default
output synchronization dropped frames in the initial diagnostic. The earlier
flat luminance-ramp fixture decoded but yielded only 12 distinct hashes; the
moving spatial pattern avoids using tiny uniform luminance changes as the
sole assertion of image variation. This checks real decodability and changing
content, not pixel-perfect fidelity, RTP delivery or remote video calling.

Live voice success — 2026-09-09 14:32 ICT: launched the installed app with the
repository agent, network/setup/media opt-ins and an explicitly selected
Bluetooth source/sink. Hardware addresses are intentionally omitted. The headset was switched from A2DP to
`headset-head-unit` for duplex audio. Device validation now permits the colon
present in actual Bluetooth source names (still checked against pactl devices).
CDP clicked the voice button for the user-selected test contact. Live
401 → native readiness → 416 → answer → codec update → 408 ACK → media-started
completed at 14:32:43 ICT. The worker remained alive with uncorked native PCM
capture and playback streams. The user explicitly confirmed hearing audio in
both directions. This establishes this user-assisted voice scenario, not video,
camera support, incoming-call UI, or fresh-install/default-launch completeness.
