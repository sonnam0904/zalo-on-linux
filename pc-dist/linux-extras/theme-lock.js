// Keeps Zalo's own theme on "light" so ZaDark (which styles the light theme) renders correctly.
// Loaded first in <head> by scripts/zadark.mjs. Zalo stores its theme as JSON under the
// localStorage key "za_theme" ({theme, theme_setting, ...}); theme_setting 0 is light.
(function () {
  'use strict';
  var KEY = 'za_theme';
  function coerce(value) {
    var theme;
    try { theme = JSON.parse(value); } catch (e) { theme = null; }
    if (!theme || typeof theme !== 'object') theme = {};
    theme.theme = 'light';
    theme.theme_setting = 0;
    return JSON.stringify(theme);
  }
  try {
    var originalSetItem = Storage.prototype.setItem;
    localStorage.setItem(KEY, coerce(localStorage.getItem(KEY)));
    Storage.prototype.setItem = function (key, value) {
      return originalSetItem.call(this, key, key === KEY ? coerce(value) : value);
    };
  } catch (e) { /* storage unavailable: nothing to lock */ }
  // "Follow system" must never resolve to dark for Zalo's own code. ZaDark's scripts (loaded
  // from ./zadark/) still see the real value so its own "Hệ thống" theme follows the system.
  var originalMatchMedia = window.matchMedia;
  if (typeof originalMatchMedia === 'function') {
    window.matchMedia = function (query) {
      var list = originalMatchMedia.call(window, query);
      if (!/prefers-color-scheme\s*:\s*dark/.test(String(query))) return list;
      var stack = '';
      try { stack = String(new Error().stack); } catch (e) { /* no stack */ }
      if (/\/zadark\/(?:js|libs)\//.test(stack)) return list;
      return new Proxy(list, {
        get: function (target, prop) {
          if (prop === 'matches') return false;
          var value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
  }
})();
