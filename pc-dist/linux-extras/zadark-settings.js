// ZaDark as a real page inside Zalo's Settings dialog, built from Zalo's own markup and classes.
// Nothing here reimplements ZaDark: every control is a proxy for the real input in ZaDark's popup
// (#js-zadark-popup), so ZaDark's own handlers run, and state is mirrored both ways.
//  - gear menu and Settings left list get a "ZaDark" entry; the sidebar ZaDark button stays;
//  - Zalo's own "Giao diện" page keeps its Sáng / Tối / Hệ Thống cards, but clicking them drives
//    ZaDark (capture phase, Zalo's own theme code never runs) and shows ZaDark's theme as selected;
//  - Zalo's dark-mode promotion dialog is hidden. Zalo's own theme stays locked to light.
// Loaded after the ZaDark scripts by scripts/zadark.mjs. No network access.
(function () {
  'use strict';
  if (window.__zaDarkSettingsInstalled) return;
  window.__zaDarkSettingsInstalled = true;

  var ATTR = 'data-zadark-native';
  var THEME_KEY = '@ZaDark:THEME';
  var THEMES = ['light', 'dark', 'auto'];
  var NAV_TITLES = ['Giao diện', 'Interface', 'Appearance', 'Theme'];
  var IMAGES = {
    light: 'assets/light.971f4ed6a350aa2d52743a7cda9f94f1.png',
    dark: 'assets/dark.06d9ce7a4e9445589529b655f61a11d8.png',
    auto: 'assets/system.01a73b355a7f74fef2358233cea385ea.png'
  };
  var TEXT = {
    vi: {
      title: 'ZaDark', theme: 'Cài đặt giao diện', light: 'Sáng', dark: 'Tối', auto: 'Hệ Thống',
      font: 'Phông chữ và cỡ chữ', fontFamily: 'Phông chữ (Google Fonts, bấm Enter để áp dụng)', fontFamilyHint: 'Mặc định',
      fontSize: 'Cỡ chữ của tin nhắn', chatBg: 'Hình nền cuộc trò chuyện', chooseBg: 'Chọn ảnh', removeBg: 'Xoá',
      display: 'Hiển thị', hideLatest: 'Ẩn tin nhắn gần nhất', hideThread: 'Ẩn tin nhắn trong cuộc trò chuyện',
      hideAvatar: 'Ẩn ảnh đại diện cuộc trò chuyện', hideName: 'Ẩn tên cuộc trò chuyện',
      privacy: 'Quyền riêng tư', blockTyping: 'Ẩn trạng thái Đang soạn tin', blockDelivered: 'Ẩn trạng thái Đã nhận',
      blockSeen: 'Ẩn trạng thái Đã xem', other: 'Khác', hotkeys: 'Sử dụng phím tắt',
      note: 'Cần tắt và mở lại Zalo để áp dụng các tuỳ chọn Ẩn trạng thái. Dịch tin nhắn của ZaDark bị tắt để dữ liệu không rời khỏi máy.'
    },
    en: {
      title: 'ZaDark', theme: 'Interface', light: 'Light', dark: 'Dark', auto: 'System',
      font: 'Font and font size', fontFamily: 'Font (Google Fonts, press Enter to apply)', fontFamilyHint: 'Default',
      fontSize: 'Message font size', chatBg: 'Conversation background', chooseBg: 'Choose image', removeBg: 'Remove',
      display: 'Display', hideLatest: 'Hide latest message', hideThread: 'Hide messages in the conversation',
      hideAvatar: 'Hide conversation avatar', hideName: 'Hide conversation name',
      privacy: 'Privacy', blockTyping: 'Hide Typing status', blockDelivered: 'Hide Delivered status',
      blockSeen: 'Hide Seen status', other: 'Other', hotkeys: 'Use hotkeys',
      note: 'Restart Zalo to apply the status options. ZaDark message translation is disabled so no data leaves this computer.'
    }
  };
  var SWITCHES = [
    ['display', [['js-switch-hide-latest-message', 'hideLatest'], ['js-switch-hide-thread-chat-message', 'hideThread'],
      ['js-switch-hide-conv-avatar', 'hideAvatar'], ['js-switch-hide-conv-name', 'hideName']]],
    ['privacy', [['js-switch-block-typing', 'blockTyping'], ['js-switch-block-delivered', 'blockDelivered'],
      ['js-switch-block-seen', 'blockSeen']]],
    ['other', [['js-switch-use-hotkeys', 'hotkeys']]]
  ];

  function $(id) { return document.getElementById(id); }
  function text() {
    var item = document.querySelector('[data-id="div_TabSetting_Setting"]');
    return item && item.textContent.trim() === 'Settings' ? TEXT.en : TEXT.vi;
  }
  function label(el) { return (el && el.textContent || '').trim(); }
  function currentTheme() {
    var value = null;
    try { value = localStorage.getItem(THEME_KEY); } catch (e) { /* storage unavailable */ }
    return THEMES.indexOf(value) >= 0 ? value : 'dark'; // ZaDark's own default
  }
  function realRadio(theme) { return document.querySelector('#js-radio-input-theme input[name="theme"][value="' + theme + '"]'); }
  function realReady() { return !!$('js-zadark-popup'); }

  function injectStyle() {
    if ($('zadark-native-style')) return;
    var style = document.createElement('style');
    style.id = 'zadark-native-style';
    style.textContent =
      '.zl-modal__container:has([class*="theme-promotion"]){display:none!important}' +
      '[' + ATTR + '="page"] .zadark-field{position:relative;min-width:160px;max-width:55%}' +
      '[' + ATTR + '="page"] .zadark-field select{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}' +
      '[' + ATTR + '="page"] .zadark-text{width:100%;box-sizing:border-box;height:32px;padding:0 12px;border-radius:4px;' +
        'border:1px solid var(--layer-border,rgba(0,0,0,.15));background:transparent;color:inherit;font:inherit;outline:none}' +
      '[' + ATTR + '="page"] .zadark-text:focus{border-color:var(--button-primary-background,#0068ff)}' +
      '[' + ATTR + '="page"] .zadark-note{padding:8px 16px 16px;font-size:12px;opacity:.7;line-height:1.4}' +
      '[' + ATTR + '="page"] .zadark-actions{display:flex;gap:8px}' +
      '[' + ATTR + '="page"] .theme-item img{width:105px;max-width:100%;height:auto}' +
      // Zalo Linux: ẩn phần quảng bá trong popup ZaDark (logo + các link Website/
      // Đánh giá/Góp ý/Nhà tài trợ ở header, và dòng "ZaDark by Quaric" ở footer),
      // chỉ giữ lại các tuỳ chọn chức năng.
      '.zadark-popup__header{display:none!important}' +
      '.zadark-popup__footer{display:none!important}' +
      // Header/footer vốn tạo khoảng đệm trên/dưới; ẩn rồi thì bù lại cho .main
      // (vốn chỉ có padding 2 bên) để popup cân đều 16px mọi phía.
      '.zadark-popup__main{padding-top:16px!important;padding-bottom:16px!important}';
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- proxies to ZaDark's real controls ------------------------------------------------
  function setTheme(theme) {
    var input = realRadio(theme);
    if (input) input.click(); // fires ZaDark's own change handler
  }
  function toggleReal(id) { var input = $(id); if (input) input.click(); }
  function setFontSize(value) {
    var select = $('js-select-font-size');
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }
  function applyFontFamily(value) {
    var input = $('js-input-font-family');
    if (!input) return;
    input.value = value;
    var event;
    try { event = new KeyboardEvent('keypress', {bubbles: true, key: 'Enter', keyCode: 13, which: 13, charCode: 13}); }
    catch (e) { return; }
    input.dispatchEvent(event);
  }

  // ---- shared state -> UI -----------------------------------------------------------
  function paintCards(cards) {
    var theme = currentTheme();
    Array.prototype.forEach.call(cards, function (card, index) {
      var selected = THEMES[index] === theme;
      card.classList.toggle('theme-item--selected', selected);
      var radio = card.querySelector('.z-radio');
      if (radio) radio.classList.toggle('z-radio--active', selected);
      var icon = card.querySelector('.z-radio i');
      if (icon) {
        icon.classList.toggle('fa-Radio_24_Round', selected);
        icon.classList.toggle('fa-Uncheck_24_Round', !selected);
      }
    });
  }
  function setToggle(toggle, on) {
    toggle.classList.toggle('z-toggle--active', on);
    var icon = toggle.querySelector('i');
    if (icon) {
      icon.classList.toggle('fa-toggle-checked-24', on);
      icon.classList.toggle('fa-toggle-unchecked-24', !on);
    }
  }
  function refresh() {
    var page = document.querySelector('[' + ATTR + '="page"]');
    if (page) {
      paintCards(page.querySelectorAll('.theme-item'));
      Array.prototype.forEach.call(page.querySelectorAll('[data-real]'), function (el) {
        var real = $(el.getAttribute('data-real'));
        if (!real) return;
        if (el.classList.contains('z-toggle')) setToggle(el, real.checked);
        else if (el.tagName === 'SELECT') {
          if (el.value !== real.value) el.value = real.value;
          var shown = el.parentNode.querySelector('.truncate');
          if (shown && el.selectedOptions[0]) shown.textContent = el.selectedOptions[0].textContent;
        } else if (el.tagName === 'INPUT' && document.activeElement !== el && el.value !== real.value) el.value = real.value;
      });
    }
    var native = document.querySelector('.setting--content-right .theme-item');
    if (native && !native.closest('[' + ATTR + '="page"]'))
      paintCards(native.closest('.setting-section').querySelectorAll('.theme-item'));
  }

  // ---- the ZaDark page ----------------------------------------------------------------
  function toggleRow(id, key, position, t) {
    var row = document.createElement('div');
    row.className = 'flx flx-al-c flx-sp-btw setting-section-content__item ' + position;
    row.innerHTML = '<span></span><div class="z-toggle z-toggle --m" data-real="' + id + '"><div></div><i class="fa fa-toggle-unchecked-24"></i></div>';
    row.querySelector('span').textContent = t[key];
    row.querySelector('.z-toggle').addEventListener('click', function () { toggleReal(id); setTimeout(refresh, 0); });
    return row;
  }
  function section(title) {
    var el = document.createElement('div');
    el.className = 'setting-section';
    el.innerHTML = '<div class="setting-section-label"><div class="z-badge"><span style="line-height: 32px;"></span></div></div>' +
      '<div class="setting-section-content"></div>';
    el.querySelector('span').textContent = title;
    return el;
  }
  function buildPage() {
    var t = text();
    var page = document.createElement('div');
    page.className = 'flx flx-col flx-1';
    page.setAttribute(ATTR, 'page');
    page.style.cssText = 'overflow-y:auto;min-height:0';
    var body = document.createElement('div');
    body.className = 'setting--bottom';
    page.appendChild(body);

    // Giao diện: same cards as Zalo's
    var themeLabel = document.createElement('div');
    themeLabel.className = 'flx flx-al-c setting-section setting-right w100 bs';
    themeLabel.innerHTML = '<div class="setting-section-label"><div class="z-badge"><span style="line-height: 32px;"></span></div></div>';
    themeLabel.querySelector('span').textContent = t.theme;
    var themes = document.createElement('div');
    themes.className = 'setting-section';
    themes.innerHTML = '<div class="setting-section-content single-no-click"><div class="flx flx-al-c"></div></div>';
    var cards = themes.querySelector('.flx');
    THEMES.forEach(function (theme) {
      var card = document.createElement('div');
      card.className = 'setting-section-content__item image-radio theme-item';
      card.innerHTML = '<img class="no-drag-img"><div class="flx flx-center-row setting-section-content__theme__default"><div class="z-radio"><i class="fa fa-Uncheck_24_Round"></i></div><span></span></div>';
      card.querySelector('img').src = IMAGES[theme];
      card.querySelector('span').textContent = t[theme];
      card.addEventListener('click', function () { setTheme(theme); setTimeout(refresh, 0); });
      cards.appendChild(card);
    });
    body.appendChild(themeLabel);
    body.appendChild(themes);

    // Font family / size
    var font = section(t.font);
    var fontContent = font.querySelector('.setting-section-content');
    var familyRow = document.createElement('div');
    familyRow.className = 'flx flx-al-c flx-sp-btw setting-section-content__item first';
    familyRow.innerHTML = '<span></span><div class="zadark-field"><input class="zadark-text" data-real="js-input-font-family" type="text" spellcheck="false"></div>';
    familyRow.querySelector('span').textContent = t.fontFamily;
    var familyInput = familyRow.querySelector('input');
    familyInput.placeholder = t.fontFamilyHint;
    familyInput.addEventListener('keypress', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      applyFontFamily(familyInput.value);
      setTimeout(refresh, 400);
    });
    var sizeRow = document.createElement('div');
    sizeRow.className = 'flx flx-al-c flx-sp-btw setting-section-content__item last';
    sizeRow.innerHTML = '<span></span><div class="zadark-field"><div class="flx flx-al-c z-dropdown-preview --square --l"><div class="truncate flx-1"></div><i class="fa fa-Chevron_Down_24_Line margin-left-24"></i></div><select data-real="js-select-font-size"></select></div>';
    sizeRow.querySelector('span').textContent = t.fontSize;
    var select = sizeRow.querySelector('select'), realSelect = $('js-select-font-size');
    if (realSelect) Array.prototype.forEach.call(realSelect.options, function (option) {
      var copy = document.createElement('option');
      copy.value = option.value; copy.textContent = option.textContent.trim();
      select.appendChild(copy);
    });
    select.addEventListener('change', function () { setFontSize(select.value); setTimeout(refresh, 0); });
    fontContent.appendChild(familyRow);
    fontContent.appendChild(sizeRow);
    body.appendChild(font);

    // Chat background
    var bg = section(t.chatBg);
    var bgRow = document.createElement('div');
    bgRow.className = 'flx flx-al-c flx-sp-btw setting-section-content__item single no-click';
    bgRow.innerHTML = '<span></span><div class="zadark-actions"><div class="z--btn--v2 btn-neutral medium  --rounded"><span></span></div>' +
      '<div class="z--btn--v2 btn-neutral medium  --rounded"><span></span></div></div>';
    var spans = bgRow.querySelectorAll('span');
    spans[0].textContent = t.chatBg; spans[1].textContent = t.chooseBg; spans[2].textContent = t.removeBg;
    var buttons = bgRow.querySelectorAll('.z--btn--v2');
    buttons[0].addEventListener('click', function () { var input = $('js-input-thread-chat-bg'); if (input) input.click(); });
    buttons[1].addEventListener('click', function () { var button = $('js-button-del-thread-chat-bg'); if (button) button.click(); });
    bg.querySelector('.setting-section-content').appendChild(bgRow);
    body.appendChild(bg);

    // Toggles
    SWITCHES.forEach(function (group) {
      var el = section(t[group[0]]);
      var content = el.querySelector('.setting-section-content');
      group[1].forEach(function (pair, index) {
        var position = group[1].length === 1 ? 'single' : index === 0 ? 'first' : index === group[1].length - 1 ? 'last' : '';
        content.appendChild(toggleRow(pair[0], pair[1], position, t));
      });
      body.appendChild(el);
    });
    var note = document.createElement('div');
    note.className = 'zadark-note';
    note.textContent = t.note;
    body.appendChild(note);
    return page;
  }

  // ---- showing / hiding the page inside the Settings dialog ---------------------------
  function rightPane() { return document.querySelector('.zl-modal__dialog .setting--content-right'); }
  function openPage() {
    var pane = rightPane();
    if (!pane || pane.querySelector('[' + ATTR + '="page"]')) return;
    var stack = pane.querySelector('.stack-navigation');
    if (stack) stack.style.display = 'none';
    var page = buildPage();
    pane.appendChild(page);
    var nav = document.querySelector('[' + ATTR + '="nav"]');
    Array.prototype.forEach.call(document.querySelectorAll('.zl-modal__dialog .setting-menu__item'), function (item) {
      item.classList.toggle('selected', item === nav);
    });
    refresh();
  }
  function closePage(clicked) {
    var pane = rightPane();
    if (!pane) return;
    var page = pane.querySelector('[' + ATTR + '="page"]');
    if (!page) return;
    page.remove();
    var stack = pane.querySelector('.stack-navigation');
    if (stack) stack.style.display = '';
    var nav = document.querySelector('[' + ATTR + '="nav"]');
    if (nav) nav.classList.remove('selected');
    // React keeps its own selected state; make sure the clicked item shows it.
    setTimeout(function () { if (clicked && clicked.isConnected) clicked.classList.add('selected'); }, 0);
  }

  // ---- entries ---------------------------------------------------------------------------
  function waitFor(test, done, tries) {
    var result = test();
    if (result) return done(result);
    if (tries > 0) setTimeout(function () { waitFor(test, done, tries - 1); }, 100);
  }
  function openSettingsOnZaDark() {
    var existing = document.querySelector('[' + ATTR + '="nav"]');
    if (existing) return existing.click();
    var settings = document.querySelector('[data-id="div_TabSetting_Setting"]');
    if (settings) settings.click();
    waitFor(function () { return document.querySelector('[' + ATTR + '="nav"]'); }, function (nav) { nav.click(); }, 40);
  }
  function addMenuEntry() {
    var settings = document.querySelector('[data-id="div_TabSetting_Setting"]');
    if (!settings || !settings.parentNode || settings.parentNode.querySelector('[data-id="div_TabSetting_ZaDark"]')) return;
    var entry = settings.cloneNode(true);
    entry.setAttribute('data-id', 'div_TabSetting_ZaDark');
    entry.setAttribute(ATTR, 'menu');
    var icon = entry.querySelector('i');
    if (icon) icon.className = 'zadark-icon zadark-icon--zadark menu-icon left';
    var name = entry.querySelector('span');
    if (name) { name.removeAttribute('data-translate-inner'); name.textContent = text().title; }
    entry.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      openSettingsOnZaDark();
    });
    settings.parentNode.insertBefore(entry, settings.nextSibling);
  }
  function addNavEntry() {
    var items = document.querySelectorAll('.zl-modal__dialog .setting-menu__item');
    if (!items.length) return;
    var list = items[0].parentNode;
    if (list.querySelector('[' + ATTR + '="nav"]')) return;
    var theme = Array.prototype.find.call(items, function (item) { return NAV_TITLES.indexOf(label(item)) >= 0; });
    if (!theme) return;
    var entry = theme.cloneNode(true);
    entry.setAttribute(ATTR, 'nav');
    entry.classList.remove('selected');
    var icon = entry.querySelector('i');
    if (icon) icon.className = 'zadark-icon zadark-icon--zadark setting-menu__icon';
    var name = entry.querySelector('.setting-menu__name span, .setting-menu__name');
    if (name) { name.removeAttribute('data-translate-inner'); name.textContent = text().title; }
    entry.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (!realReady()) return;
      openPage();
    });
    theme.parentNode.insertBefore(entry, theme.nextSibling);
    // Any other item restores Zalo's own page.
    list.addEventListener('click', function (event) {
      var item = event.target.closest && event.target.closest('.setting-menu__item');
      if (item && item !== entry) closePage(item);
    }, true);
  }

  // Zalo's own "Giao diện" cards drive ZaDark instead of Zalo's theme code.
  function onNativeCardClick(event) {
    var card = event.target.closest && event.target.closest('.theme-item');
    if (!card || card.closest('[' + ATTR + '="page"]')) return;
    var group = card.closest('.setting-section');
    if (!group || !realReady()) return;
    var index = Array.prototype.indexOf.call(group.querySelectorAll('.theme-item'), card);
    if (index < 0 || index >= THEMES.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setTheme(THEMES[index]);
    setTimeout(refresh, 0);
  }

  // Never offer Zalo's own dark mode: remember its promotion as already shown.
  function markPromotionShown() {
    try {
      var theme = JSON.parse(localStorage.getItem('za_theme') || '{}') || {};
      if (theme.has_showed_popup_promotion === true) return;
      theme.has_showed_popup_promotion = true;
      localStorage.setItem('za_theme', JSON.stringify(theme));
    } catch (e) { /* storage unavailable */ }
  }

  // ---- Dịch KHÔNG giới hạn qua Google Translate ------------------------------------------
  // ZaDark gọi fetch("https://api.zadark.com/v1/translate") — dịch vụ riêng, giới hạn
  // 20 lượt/ngày và bị CSP của bản Linux chặn. Ta chỉ chặn đúng request đó rồi chuyển sang
  // endpoint Google Translate miễn phí (translate.google.com nằm trong *.google.com nên CSP
  // cho phép). Mọi fetch khác giữ nguyên.
  var LANG_NAMES = {
    en: 'Anh', vi: 'Việt', zh: 'Trung', 'zh-CN': 'Trung', 'zh-TW': 'Trung (Phồn thể)',
    ja: 'Nhật', ko: 'Hàn', fr: 'Pháp', de: 'Đức', es: 'Tây Ban Nha', ru: 'Nga',
    th: 'Thái', id: 'Indonesia', km: 'Khmer', lo: 'Lào', it: 'Ý', pt: 'Bồ Đào Nha'
  };
  function langName(code) { return code ? (LANG_NAMES[code] || code) : ''; }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function patchTranslateToGoogle() {
    if (window.__zadarkGoogleTranslate) return;
    if (typeof window.fetch !== 'function') return;
    window.__zadarkGoogleTranslate = true;
    var originalFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('api.zadark.com/v1/translate') === -1) {
        return originalFetch(input, init);
      }
      var payload = {};
      try { payload = JSON.parse((init && init.body) || '{}'); } catch (e) { /* ignore */ }
      var text = String(payload.text || '').replace(/<br\s*\/?>/gi, '\n');
      var target = payload.target || 'vi';
      var g = 'https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=' +
        encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(text);
      var result = originalFetch(g).then(function (r) { return r.json(); }).then(function (data) {
        var segs = (data && data[0]) || [];
        var out = '';
        for (var i = 0; i < segs.length; i++) { if (segs[i] && segs[i][0]) out += segs[i][0]; }
        return {
          success: true,
          languageName: langName(data && data[2]),
          translation: escapeHtml(out).replace(/\n/g, '<br>')
        };
      }).catch(function (e) {
        return { success: false, message: (e && e.message) || 'Không dịch được' };
      });
      // ZaDark dùng `(await fetch(...)).json()`, nên trả về đối tượng có .json().
      return result.then(function (obj) {
        return { json: function () { return Promise.resolve(obj); } };
      });
    };
  }

  // Tooltip "Bạn có 20 lượt dịch tin nhắn mỗi ngày" không còn đúng (giờ dịch không giới hạn).
  function fixTranslateTooltip() {
    var nodes = document.querySelectorAll('[data-tippy-content*="lượt dịch tin nhắn"]');
    Array.prototype.forEach.call(nodes, function (el) {
      var c = el.getAttribute('data-tippy-content') || '';
      var nc = c.replace(/<p>\s*Bạn có[^<]*lượt dịch tin nhắn mỗi ngày\.?\s*<\/p>/i,
        '<p>Dịch không giới hạn (qua Google Dịch).</p>');
      if (nc !== c) {
        el.setAttribute('data-tippy-content', nc);
        if (el._tippy && typeof el._tippy.setContent === 'function') {
          try { el._tippy.setContent(nc); } catch (e) { /* ignore */ }
        }
      }
    });
  }

  var scheduled = false;
  function scan() {
    scheduled = false;
    addNavEntry();
    fixTranslateTooltip();
    refresh();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 30);
  }
  function start() {
    injectStyle();
    patchTranslateToGoogle();
    fixTranslateTooltip();
    markPromotionShown();
    document.addEventListener('click', onNativeCardClick, true);
    // ZaDark changes state outside our controls too (popup, hotkeys): mirror it.
    document.addEventListener('change', function () { setTimeout(refresh, 0); }, true);
    setInterval(function () { if (document.querySelector('.zl-modal__dialog')) refresh(); }, 700);
    new MutationObserver(schedule).observe(document.body, {childList: true, subtree: true});
    schedule();
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
