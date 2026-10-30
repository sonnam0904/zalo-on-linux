# ZaDark (Zalo dark mode)

- Upstream: https://github.com/ncdai/zadark (also published as quaric/zadark), MPL-2.0, see `LICENSE` in this folder.
- Version 26.2.1, commit `4f4f791` (2026-07-24).
- Built with `NODE_ENV=production npx gulp distPC` from that commit; the files here are the contents of `build/pc/assets` (the unused `fonts/bk` folder was left out).
- Applied by `scripts/zadark.mjs apply`; `scripts/zadark.mjs remove` restores the original entry points. Tested by `scripts/test-zadark.mjs`.
- Changes from the upstream PC installer: Linux markers (`data-zadark-os="Linux"`, `zadark-linux`), no Content-Security-Policy changes, and no app.asar rewriting. api.zadark.com (message translation) and Google Fonts therefore stay blocked.
- Files covered by MPL-2.0: everything in this folder. Modified upstream files must stay MPL-2.0.
- Zalo's own bundle removes `<link>`/`<script>` tags whose path starts with `zadark` (function `p` in `lazy/default-login-main-startup-shared-worker-znotification.*.js`, built from characters so it is hard to grep). The tags added by `scripts/zadark.mjs` use `./zadark/...` so they do not match that filter; the Zalo bundle itself is not modified. Zalo can change that filter at any time, and may treat ZaDark as unsupported: using it is at your own risk.
- Native entries (not part of upstream ZaDark): `pc-dist/linux-extras/theme-lock.js` keeps Zalo's own theme on light and makes "follow system" resolve to light, and the `updateThemeSetting` bundle patch applied by `scripts/zadark.mjs` forces any theme choice to light; `pc-dist/linux-extras/zadark-settings.js` adds "ZaDark" to the gear menu and to the Settings dialog (after "Giao dien"), replaces Zalo's Sang/Toi/He Thong picker with a row that opens ZaDark, and hides Zalo's dark-mode promotion dialog. All three entry points just click the ZaDark sidebar button, which stays. These two files are this project's own code, not MPL-covered upstream files.
