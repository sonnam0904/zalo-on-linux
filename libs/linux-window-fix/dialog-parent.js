// Linux window fix — keep native file dialogs above the main window.
//
// Problem: on Linux, Zalo's save/open file dialogs appear *behind* the main
// window. Zalo calls them as
//   dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), options)
// but the chat content runs inside a BrowserView, so fromWebContents() can hand
// back the wrong window (a hidden/background BrowserWindow) or null. Either way
// the GTK dialog ends up transient-for a window that is not the one on screen,
// so the window manager stacks it behind the visible app window.
//
// Fix: wrap the four file-dialog methods in the main process and *always* parent
// the dialog to the window that is actually on screen (focused, else the largest
// visible window), raising/focusing it first so the modal dialog comes to front.
// Pure main-process shim; the proprietary Zalo bundles are never modified.
//
// This file is this project's own code, not part of the Zalo payload.
// Set ZALO_DIALOG_FIX_DEBUG=1 to log what each dialog call received and chose.

'use strict';

let applied = false;

module.exports = function applyDialogParentFix() {
  if (applied) return;
  applied = true;

  let electron;
  try {
    electron = require('electron');
  } catch (e) {
    return; // not in an Electron main process; nothing to do
  }

  const dialog = electron.dialog;
  const BrowserWindow = electron.BrowserWindow;
  if (!dialog || !BrowserWindow) return;

  const debug = process.env.ZALO_DIALOG_FIX_DEBUG === '1';
  const log = (...a) => { if (debug) console.log('[dialog-fix]', ...a); };

  const area = (w) => {
    try { const b = w.getBounds(); return b.width * b.height; } catch (e) { return 0; }
  };

  // The window that is actually on screen right now: focused first, otherwise the
  // largest visible, non-minimized window (the main chat window in practice).
  function visibleParent() {
    try {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed() && focused.isVisible()) return focused;
      const visible = BrowserWindow.getAllWindows()
        .filter((w) => w && !w.isDestroyed() && w.isVisible() && !w.isMinimized())
        .sort((a, b) => area(b) - area(a));
      return visible[0] || null;
    } catch (e) {
      return null;
    }
  }

  function describe(w) {
    try {
      if (!(w instanceof BrowserWindow)) return String(w);
      if (w.isDestroyed()) return 'win#destroyed';
      return 'win#' + w.id + '(visible=' + w.isVisible() + ',min=' + w.isMinimized() +
        ',focused=' + w.isFocused() + ')';
    } catch (e) { return 'win#?'; }
  }

  ['showSaveDialog', 'showSaveDialogSync', 'showOpenDialog', 'showOpenDialogSync'].forEach(
    (name) => {
      const original = dialog[name];
      if (typeof original !== 'function') return;

      dialog[name] = function patchedDialog() {
        const args = Array.prototype.slice.call(arguments);

        // Call forms: fn(options) | fn(browserWindow, options) (win may be null).
        let passed;
        let options;
        if (args.length >= 2 || args[0] instanceof BrowserWindow) {
          passed = args[0];
          options = args[1];
        } else {
          passed = null;
          options = args[0];
        }

        // Always prefer the window on screen; the parent Zalo passes is often a
        // hidden/background window, which is exactly what makes the dialog hide.
        const parent = visibleParent() ||
          (passed instanceof BrowserWindow && !passed.isDestroyed() ? passed : null);

        log(name, 'passed=' + describe(passed), '-> parent=' + describe(parent));

        if (parent instanceof BrowserWindow) {
          // Make sure the chosen parent is the active window so the modal dialog
          // is placed in front of it rather than behind the stack.
          try { if (parent.isMinimized()) parent.restore(); } catch (e) { /* ignore */ }
          try { parent.show(); } catch (e) { /* ignore */ }
          try { parent.focus(); } catch (e) { /* ignore */ }
          return original.call(this, parent, options);
        }
        // No usable window — fall back to the original single-arg form.
        return original.call(this, options);
      };
    }
  );

  log('file-dialog parent fix installed');
};
