# Experimental outgoing camera integration

Status: code integration, **not a completed two-way video call**. Local Logitech
capture/native encoding/UDP/independent decode passes; real remote negotiation,
camera controls and live acceptance are open. Native inbound decoding and
pixel export pass local fixtures; experimental display wiring is now present
in source, but not deployed or verified in the real Electron window.

## UI and configuration contract

The actual renderer `makeCall` implementation maps one-to-one audio to **1**
and one-to-one video to **3**; group modes are 5/6. It is not video type 2.
`OutgoingSetup` accepts type 3 only with `allowVideo: true`, captures immutable
media/peer intent before asynchronous work, and forwards the validated type in
the authenticated 401 request. Live server acceptance of this video request
still requires verification.

`callerResponse` requires `video: true` plus `experimentalVideo: true` for video.
It retains strict call-ID/native-identity/server validation and then sets both
native `videoCall` and `supportVideoCall`. The existing `desktopVoiceConfig`
contract remains voice-only. Server video capability is never substituted for
the user's requested mode.

## Agent opt-in and lifetime

The development agent's outgoing branch requires all of:

- `ZALO_ZCALL_NATIVE_SETUP=1`
- `ZALO_ZCALL_NATIVE_NETWORK=1`
- `ZALO_ZCALL_NATIVE_MEDIA=1`
- `ZALO_ZCALL_NATIVE_VIDEO=1`
- explicit `ZALO_ZCALL_VIDEO_DEVICE=/dev/video0` (or another V4L2 device)
- the existing validated runtime and PCM device configuration
- the updated main-process host, which supplies private inherited video fd 3

The normal JSON-configured voice launcher strips inherited video opt-ins, so
an unrelated shell environment does not silently enable camera transport.
No running Zalo process was restarted or opted in by this change.

Native server readiness remains required before invitation. After a correlated
answer and the existing JNI/408/CONFIRMED sequence, the agent checks actual
native `videoCall`, `canTransferMedia` and H.264 codec ID before starting capture.
`withCameraSession` binds the camera lifetime to the retained invitation:

- no camera capture while requesting configuration or ringing;
- one start per answered call;
- camera failure cancels the invitation and triggers normal remote cleanup;
- remote/local end cancels capture and awaits its teardown before worker close;
- late answers/cancellation cannot begin a new camera owner.

The answered video branch now uses `runVideoMedia` to join camera capture and
the remote-frame consumer. Main owns a separate local video window connected
by the dedicated media pipe, not the signaling/log channel. Closing the display
pipe cancels the media session. User window close now sends a separate call-cancel
control while retaining the pipe; a clear ACK resets it for the next call.
This source wiring requires the updated host
and helper together; the currently installed host is still the older version.
See [VIDEO-PEER.md](VIDEO-PEER.md) for window restrictions, boundary tests and
remaining live/privacy/control gates. Recovery for another video call after a
user-closed window passes boundary tests but still needs real Electron verification.

The phase `camera-start-requested` means exactly that, not successful capture,
remote reception, or a rendered remote image. The branch intentionally makes no
new claim that `callReady` is true. No incoming-video branch has been added.

## Verification

```sh
node native/qt-call-cap-linux/test-outgoing-setup.js
node native/android-zrtc/test-caller-response.mjs
node native/android-zrtc/test-camera-call-session.mjs
node native/android-zrtc/test-camera-pump.mjs
node native/android-zrtc/test-outgoing-invitation.mjs
node scripts/test-native-launch.mjs
node native/android-zrtc/test-desktop-config.mjs RUNTIME_DIR
```

Tests cover default video rejection, type-3 opt-in, mutable input isolation,
native configuration mapping, pre-answer capture prohibition, camera/invitation
cleanup and retention, remote/local/camera-error endings, and voice regression.
Camera/invitation tests use boundary stubs, not a real remote account. Live
deployment must still verify remote codec negotiation, inbound video handling,
privacy/device controls, hangup and recovery before calling this feature ready.
