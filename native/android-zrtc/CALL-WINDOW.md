# Unified call window — implementation checkpoint

Latest runtime deployment: source checkpoint `6ac64ba` was restarted on
2026-09-10 after strict device preflight passed. New main/helper PIDs
1547523/1548043 and inherited control/video/preview pipes were verified.
See `INTEGRATION-STATUS.md` for rollout evidence and retained backups. Older
source-only annotations below describe their original checkpoint; those changes
are now loaded through the fresh helper/main. Live two-account acceptance is
still pending, especially incoming-first identity bootstrap.

The user supplied three Zalo desktop reference images: centered avatar/ringing,
incoming answer/end, and active video with a bottom control row. The new
`call-window.cjs` owns one isolated Electron window per call; its `dialog` method
matches the existing call owner's consent/dialing/active interface. Stage changes
and mute acknowledgements update the existing window, not separate GTK dialogs.
The production main/helper integration now uses inherited fd 4 for bounded
control messages, fd 3 for remote binary video frames and fd 5 for local preview. `desktop-call-window.cjs`
joins both pipes to this same window. Incoming and outgoing voice/video inject
the new dialog adapter, and clear it after worker shutdown. Lock and pipe closure
dispose the host. **Deployed and restarted with approval on 2026-09-10 at
source checkpoint `3f34275`.** Main PID 1155420 and helper PID 1155938 were
verified alive, with control/video/preview fds 4/3/5 and the new native runtime
`~/zalo-native-recovery/mute-evidence-20260910/runtime`. Installed main SHA-256
matches source: `17bf42b421d1d8366e4fc72e9b80984b9a009701c40b7ab4c1fcff5d8cbdadc4`.
This is deployment evidence, not live two-account acceptance.

## Verified on 2026-09-10

- Outgoing setup now invokes the existing generic error dialog after a failed
  configuration/native consumer has unwound and the preparation dialog has
  joined. `test-outgoing-setup.js` covers configuration/native failure, failed
  notification delivery, explicit cancel and cancel during cleanup. Only
  signal/video/bounded display name are passed to presentation, never raw
  signaling errors. Canceled setup suppresses the notification. This latest
  wiring is source-tested, not a new installed/live-call verification.

- Latest source checkpoint `233db7e` was exercised in isolated Electron 22 via
  agent-browser on loopback CDP 9234. The new
  `test-call-window-electron.cjs --preparation-only` composes the real outgoing
  setup and control pipe with a deliberately pending synthetic 401 response.
  The visible Vietnamese preparing status/name and enabled Hủy button were
  inspected; clicking Hủy canceled setup, sent no invitation, started no worker,
  cleared the window and exited 0. Screenshot retained under home:
  `~/zalo-native-recovery/call-preparation-qa.png`.
- A separate run of the full Electron fixture passed Answer → mute → unmute →
  camera off → camera on → End. DOM checks confirmed local preview hidden on
  camera-off and restored on camera-on, while remote canvas stayed visible.
  Both fixture processes exited 0 and browser sessions were closed. No account,
  physical device, live signaling or installed app restart was involved.

- `node native/android-zrtc/test-call-window.cjs`: reuse across stages and mute
  acknowledgements, stable duration origin, consent, close during an ACK gap,
  sender/revision/action validation, cleanup, sandbox permissions.
- `node native/android-zrtc/test-call-ui-pipe.cjs`: real duplex protocol and
  composed host (mock Electron) verify pre-frame dialing, shared video display,
  controls, cancellation ACK, reuse after clear, lock and disconnect teardown.
- `node scripts/test-call-control.mjs`: now includes 25 lifecycle suites.
- `test-outgoing-preparation.cjs`: outgoing voice/video begins with the
  cancellable `preparing` stage before configuration completes, retained during
  native startup. Cancel aborts configuration/negotiation; handoff joins the
  dialog cancellation ACK before dialing starts. Tests cover config/native/UI
  failure and parent cancellation. The composed pipe test checks preparing →
  dialing → active reuse with no duration before connection. This is source-only;
  both helper and window protocol must be deployed together before live QA.
- `test-incoming-preflight.mjs`: identity/name preparation failures show one
  generic error without raw signaling data, preserve the original failure even
  when UI delivery fails, and suppress UI/owner entry after cancellation before
  or during either await. This source change has not been live deployed/tested.
- `test-incoming-desktop.mjs`: validation failures (invalid/oversized media
  intent, missing native identity/caller, missing camera/display and video opt-in)
  now use the driver's existing generic error boundary before starting a worker.
  Tests verify listener cleanup before notification, cancellation suppression,
  no worker/owner entry, and retention of the original failure if UI delivery
  also fails. These checks do not verify physical-device availability or live calls.
- Real Electron 22 fixture `test-call-window-electron.cjs`, operated through
  agent-browser on loopback CDP port 9234: Answer → mute → unmute → End passed.
  This fixture now exercises both control and binary video pipes, with a
  synthetic 4×4 I420 frame. Camera off/on and mute/unmute controls pass through
  the same window and protocol. It uses synthetic control acknowledgements and no
  account/network/live media. The same window remains visible after answering.
- Visual screenshots inspected, stored under the persistent recovery directory:
  `~/zalo-native-recovery/call-window-incoming.png` and `call-window-muted.png`.
  The integrated synthetic video screenshot is `call-window-video-pipes.png`.
- Camera controller: `test-managed-camera.mjs` checks joined off, off before
  first-frame readiness, resume ACK, stable timestamp origin across restart,
  capture failures, UI ACK ordering and continued remote-video ownership.
  A subsequent regression test reproduced false camera-off success when preview
  cleanup throws after capture cancellation. The controller now ignores only
  the expected `AbortError`, propagates other cleanup failures and rejects the
  off acknowledgement. This source fix does not imply a running helper reloaded it.
- `node native/android-zrtc/test-managed-camera-device.mjs /dev/video0` passed
  on the user's Logitech USB camera: three off/on cycles, no additional frames
  reaching the mock worker after off ACK, and new frames on resume. Frames were
  discarded in memory, not saved or transmitted. This is real V4L2/FFmpeg
  acquisition with mock native ACK, **not remote two-account video acceptance**.
- Local preview now consumes the same NV21 frames acknowledged by the native
  worker. A 160×120 I420 downscale travels on its own bounded binary pipe; no
  second camera capture is opened. The renderer allows one pending remote frame
  and one pending local frame, with separate acknowledgements. Preview memory
  is zeroed after painting and its canvas cleared/hidden when capture stops.
- Electron/CDP fixture verified `previewHidden: true`, `remoteHidden: false`
  after camera off, and visible preview after camera on. Synthetic screenshot:
  `~/zalo-native-recovery/call-window-local-preview.png`. The real USB device
  test also passed with preview conversion and clear-before-off assertions.

## Contact presentation checkpoint

Outgoing requests already contain `partner[0].name`, populated by the desktop
renderer from `getMiniInfo(...).dName`. The setup owner now snapshots a bounded
plain-text display name per call and carries it only on the local control pipe.
It is not used for signaling identity or added to the 401 API payload, argv,
logs, profiles or files. The renderer uses `textContent`, not markup. Control
and directional override characters are stripped; names are limited to 80
Unicode code points. Missing names fall back to the generic call label.

The control decoder now preserves multibyte UTF-8 split across pipe chunks.
Tests cover Vietnamese/emoji split one byte at a time, snapshot immutability,
and no previous name retained in a subsequent unnamed call. These changes are
source-only pending helper reload; live contact-name presentation is not yet
verified. Incoming names now use the existing renderer `getAliasName` request,
with a unique UUID echoed by both renderer bundles. The helper checks both the
UUID and desktop caller ID before accepting a result, and falls back after
750 ms or cancellation. A delayed response cannot name a new same-contact call.
Tests execute the actual responder blocks from both bundles with a mock contact
store. This needs matching renderer/helper deployment; avatars remain incomplete.

## Remaining before live acceptance

- Test actual two-account signaling/media on the deployed matching main/helper.
- Check local preview and video latency in actual two-account calls after deployment.
- Avatars with bounded, non-logging, account-scoped transport; verify incoming
  and outgoing names on the real window after renderer/helper reload.
- Camera off/on is now wired to joined capture shutdown/restart. Validate it
  during a real video call, including remote presentation: the peer may retain
  the last image until camera-state signaling is implemented/verified. No new
  camera frames are submitted while off; audio and remote video remain owned
  by the existing call. Preview is mirrored locally only, not in transmitted frames.
- Validate reported microphone failure with real audio, not fixture text changes.
- Incoming red button remains **Bỏ qua** (local ignore), not verified remote reject.
- First-incoming identity bootstrap binds the bounded native recipient in the
  authenticated renderer control to the current desktop account ticket. A
  cached native identity must match, and account switches/cancellation still
  invalidate the attempt. It deliberately sends no parallel 401: live testing
  showed that the old probe competed with and disconnected a cold incoming
  call. Deploy and validate fresh-login incoming voice/video before release
  claims.

Visual direction follows the supplied references: dark charcoal, centered avatar,
restrained system typography, red end and green answer. OS window decorations are
retained. No external fonts/assets, network permissions, renderer Node access or
profile reads are required. Generic identity is an explicit placeholder pending
the authenticated contact bridge, not a guessed contact.
