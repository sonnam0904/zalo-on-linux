# Passive incoming signaling test

This is a diagnostic Linux launcher, **not a working native voice/video release**.
It uses the installed profile and disables the Wine call proxy for this launch.
Do not run alongside an existing Zalo instance: quit from the tray first.

```bash
bash scripts/test-native-call-schema.sh /absolute/path/to/zalo /absolute/path/to/electron
```

Log in if needed. From a different Zalo account, call this account for about
5–10 seconds, then hang up on the caller's device. Neither an incoming-call
window nor audio is implemented in this diagnostic bridge. Tell
the assistant when done; it can inspect the local schema file without asking
you to upload credentials or raw signaling.

Results: `~/.local/state/zalo-native-test/signaling-schema.jsonl` by default.
Only field/type structure is retained, not scalar values such as session keys,
IDs or server addresses. JSON-valued strings are recursively reduced to schema.
The bridge never starts the native media worker or a microphone in this mode.

The installed helper launcher now honors the opt-in `ZALO_ZCALL_AGENT_PATH`.
Without it, the original bridge is used as before. Original launcher backup:
`/absolute/path/to/zalo/native/qt-call-cap-linux/ZaloCall.before-native-schema-test`.
The ordinary desktop shortcut and updater were not changed.

For CDP automation on loopback only, quit Zalo fully and use:

```bash
ZALO_ZCALL_CDP_PORT=9222 bash scripts/test-native-call-schema.sh \
  /absolute/path/to/zalo /absolute/path/to/electron
```

The optional port is validated (1024..65535). CDP grants access to the logged-in
app; do not expose it via a tunnel. Omit the variable for a non-debug launch.
CDP smoke test on 2026-09-09 clicked the voice button for the user-selected
contact and confirmed request/makeCall reached the helper. No remote ringing
was established: this helper still takes the no-media branch.

Completed 2026-09-09 at 13:28 ICT: request and cancel reached the helper.
Do not repeat this test to diagnose missing ringing; the current helper ignores
incoming control after recording its schema and has no media integration.
The capture now also records schema-only makeCall/endCall/listDevice requests
so outgoing IPC dispatch can be distinguished from UI gating in a later test.
