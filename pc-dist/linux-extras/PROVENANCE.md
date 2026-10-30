# Viewer asset provenance

`viewer.js` and `viewer.css` were extracted, without executing the Windows
program, from the user-supplied `Zalo-Print-Patcher.exe.zip`.
This document records asset handling and third-party dependencies, not a
separate viewer-author credit.

Input executable SHA-256:
`e98728e5f0c9819c4233db61880ae4be845ec8de99b2443b0746713160c670bb`

Extraction identified literal JavaScript and UTF-16LE CSS strings in the
packaged executable. No V8 bytecode, Windows patch routine or EXE is run by the
Linux app. No asset is downloaded at application startup.

`fabric-5.3.0.js` is the bundled Fabric.js dependency, reporting version 5.3.0.
It retains its embedded contents. The upstream v5.3.0 notice is included in
`FABRIC-LICENSE.txt`, retrieved from
https://github.com/fabricjs/fabric.js/blob/v5.3.0/LICENSE.
Version text alone is not verification of the complete upstream distribution.

Linux adaptations in `viewer.js`: print content survives until `afterprint`,
bounded image-load timeout, print setting validation, passcode-lock guards and
overlay cleanup, idempotent modal closure, owned blob URL cleanup, keyboard
toolbar buttons and scoped Ctrl+P handling. `loader.js` is new integration code
that loads these assets only when the image toolbar appears.

Further Linux fixes include self-contained SVG icons, explicit toolbar padding
to avoid inherited-style icon collapse, page-width-based print-preview margins,
and history entries for selection recoloring, font-size and object/text edits.
An isolated real-Chromium fixture verifies rectangle and recolor undo/redo,
annotated preview and lock cleanup; it does not prove OS printing or clipboard.

No blanket license is applied to the original Zalo client or its dependencies.
Retain third-party notices when packaging the viewer.
