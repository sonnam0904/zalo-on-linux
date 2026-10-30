(() => {
  // Adapted from the user-supplied Zalo Print Patcher; see PROVENANCE.md.
  const activeClosers = new Set();
  const isLocked = () => !!document.querySelector('#titleBar.locked, .app-lock:not(.state-hidden)');
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };

  // src/detect.js
  var require_detect = __commonJS({
    "src/detect.js"(exports, module) {
      var MIN_SIZE = 80;
      var BOUND = "zpfBound";
      function isMessageImage(img) {
        if (!img || img.tagName !== "IMG") return false;
        if (img.dataset[BOUND]) return false;
        const isZimg = img.classList && img.classList.contains("zimg-el");
        const src = img.currentSrc || img.src || "";
        const okScheme = /^zfile:/i.test(src) || /^file:/i.test(src) || /^blob:/i.test(src) || /^data:image\//i.test(src) || /^https?:/i.test(src);
        if (!isZimg) {
          if (!okScheme) return false;
          if (/\.(svg)(\?|$)/i.test(src)) return false;
          if (/(sticker|emoji|reaction|avatar|thumb_icon|icon\/)/i.test(src)) return false;
        }
        if (img.closest && img.closest('.message-quote-fragment, .quoteMessage, [class*="quote" i]')) return false;
        const r = img.getBoundingClientRect();
        const w = r.width || img.width || img.naturalWidth || 0;
        const h = r.height || img.height || img.naturalHeight || 0;
        if (w < MIN_SIZE || h < MIN_SIZE) return false;
        return true;
      }
      function bestSrc2(img) {
        if (img.srcset) {
          let best = null, bestW = 0;
          img.srcset.split(",").forEach((part) => {
            const seg = part.trim().split(/\s+/);
            const w = seg[1] ? parseInt(seg[1], 10) : 0;
            if (seg[0] && w >= bestW) {
              bestW = w;
              best = seg[0];
            }
          });
          if (best) return best;
        }
        return img.currentSrc || img.src;
      }
      module.exports = { isMessageImage, bestSrc: bestSrc2, MIN_SIZE, BOUND };
    }
  });

  // src/print-layout.js
  var require_print_layout = __commonJS({
    "src/print-layout.js"(exports, module) {
      var PAPER = { A4: { w: 210, h: 297 }, Letter: { w: 215.9, h: 279.4 } };
      var MARGIN_PRESETS = { none: 0, narrow: 6, normal: 10, wide: 20 };
      function computePageBox(sizeKey, orient, boxW, boxH) {
        const p = PAPER[sizeKey] || PAPER.A4;
        let mmW = p.w, mmH = p.h;
        if (orient === "landscape") {
          mmW = p.h;
          mmH = p.w;
        }
        const ratio = mmW / mmH;
        let w, h;
        if (boxW / boxH > ratio) {
          h = boxH;
          w = h * ratio;
        } else {
          w = boxW;
          h = w / ratio;
        }
        return { w: Math.round(w), h: Math.round(h) };
      }
      module.exports = { PAPER, MARGIN_PRESETS, computePageBox };
    }
  });

  // src/modal.js
  var require_modal = __commonJS({
    "src/modal.js"(exports, module) {
      function buildModal(title, wide, onClose) {
        const backdrop = document.createElement("div");
        backdrop.className = "zpf-modal-backdrop";
        const modal = document.createElement("div");
        modal.className = "zpf-modal" + (wide ? " zpf-modal-wide" : "");
        const header = document.createElement("div");
        header.className = "zpf-modal-header";
        header.textContent = title;
        const body = document.createElement("div");
        body.className = "zpf-modal-body";
        const footer = document.createElement("div");
        footer.className = "zpf-modal-footer";
        modal.appendChild(header);
        modal.appendChild(body);
        modal.appendChild(footer);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        let closed = false;
        activeClosers.add(close);
        function close() {
          if (closed) return;
          closed = true;
          activeClosers.delete(close);
          document.removeEventListener("keydown", onKey);
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (typeof onClose === "function") {
            try {
              onClose();
            } catch (e) {
            }
          }
        }
        function onKey(e) {
          if (e.key === "Escape" && [...activeClosers].at(-1) === close) close();
        }
        backdrop.addEventListener("click", (e) => {
          if (e.target === backdrop) close();
        });
        document.addEventListener("keydown", onKey);
        return { backdrop, modal, header, body, footer, close };
      }
      function mkBtn(label, kind) {
        const b = document.createElement("button");
        b.className = "zpf-btn zpf-btn-" + (kind || "secondary");
        b.type = "button";
        b.textContent = label;
        return b;
      }
      module.exports = { buildModal, mkBtn };
    }
  });

  // src/print.js
  var require_print = __commonJS({
    "src/print.js"(exports, module) {
      var { PAPER, MARGIN_PRESETS, computePageBox } = require_print_layout();
      var { buildModal, mkBtn } = require_modal();
      function openPreview2(src) {
        if (!src || isLocked()) return;
        let cleanup = null;
        const m = buildModal("Xem tr\u01B0\u1EDBc & In", true, () => {
          if (cleanup) cleanup();
        });
        const opts = { size: "A4", orient: "portrait", fit: "contain", marginMm: 10, border: false };
        const tb = document.createElement("div");
        tb.className = "zpf-toolbar zpf-print-toolbar";
        m.modal.insertBefore(tb, m.body);
        function field(labelText, controlEl) {
          const f = document.createElement("div");
          f.className = "zpf-pfield";
          const l = document.createElement("span");
          l.className = "zpf-plabel";
          l.textContent = labelText;
          f.appendChild(l);
          f.appendChild(controlEl);
          return f;
        }
        function seg(labels, onPick, activeIdx) {
          const g = document.createElement("div");
          g.className = "zpf-segmented";
          const btns = labels.map((lb, i) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "zpf-seg" + (i === activeIdx ? " active" : "");
            b.textContent = lb;
            b.onclick = () => {
              btns.forEach((x) => x.classList.remove("active"));
              b.classList.add("active");
              onPick(i);
              render();
            };
            g.appendChild(b);
            return b;
          });
          return g;
        }
        const sizeSel = document.createElement("select");
        sizeSel.className = "zpf-select";
        Object.keys(PAPER).forEach((s) => {
          const o = document.createElement("option");
          o.value = o.textContent = s;
          sizeSel.appendChild(o);
        });
        sizeSel.onchange = () => {
          opts.size = sizeSel.value;
          render();
        };
        tb.appendChild(field("Kh\u1ED5 gi\u1EA5y", sizeSel));
        tb.appendChild(field("H\u01B0\u1EDBng", seg(["D\u1ECDc", "Ngang"], (i) => {
          opts.orient = i ? "landscape" : "portrait";
        }, 0)));
        tb.appendChild(field("C\xE1ch v\u1EEBa", seg(["V\u1EEBa trang", "L\u1EA5p \u0111\u1EA7y"], (i) => {
          opts.fit = i ? "cover" : "contain";
        }, 0)));
        const marginSel = document.createElement("select");
        marginSel.className = "zpf-select";
        [["none", "Kh\xF4ng l\u1EC1"], ["narrow", "H\u1EB9p"], ["normal", "V\u1EEBa"], ["wide", "R\u1ED9ng"], ["custom", "Tu\u1EF3 ch\u1EC9nh\u2026"]].forEach((o) => {
          const op = document.createElement("option");
          op.value = o[0];
          op.textContent = o[1];
          marginSel.appendChild(op);
        });
        marginSel.value = "normal";
        const marginNum = document.createElement("input");
        marginNum.type = "number";
        marginNum.min = "0";
        marginNum.max = "40";
        marginNum.value = "10";
        marginNum.className = "zpf-num";
        marginNum.style.display = "none";
        marginSel.onchange = () => {
          if (marginSel.value === "custom") {
            marginNum.style.display = "";
            opts.marginMm = parseInt(marginNum.value, 10) || 0;
          } else {
            marginNum.style.display = "none";
            opts.marginMm = MARGIN_PRESETS[marginSel.value];
          }
          render();
        };
        marginNum.oninput = () => {
          opts.marginMm = Math.max(0, Math.min(40, parseInt(marginNum.value, 10) || 0));
          render();
        };
        const marginWrap = document.createElement("div");
        marginWrap.className = "zpf-margin-wrap";
        marginWrap.appendChild(marginSel);
        marginWrap.appendChild(marginNum);
        tb.appendChild(field("L\u1EC1", marginWrap));
        const borderBtn = document.createElement("button");
        borderBtn.type = "button";
        borderBtn.className = "zpf-toggle";
        borderBtn.textContent = "Vi\u1EC1n \u1EA3nh";
        borderBtn.onclick = () => {
          opts.border = !opts.border;
          borderBtn.classList.toggle("active", opts.border);
          render();
        };
        tb.appendChild(field("Kh\xE1c", borderBtn));
        m.body.classList.add("zpf-preview-body");
        const page = document.createElement("div");
        page.className = "zpf-page";
        const inner = document.createElement("div");
        inner.className = "zpf-page-inner";
        const pimg = document.createElement("img");
        pimg.className = "zpf-page-img";
        pimg.alt = "preview";
        inner.appendChild(pimg);
        page.appendChild(inner);
        m.body.appendChild(page);
        function render() {
          const box = computePageBox(opts.size, opts.orient, (m.body.clientWidth || 700) - 48, (m.body.clientHeight || 460) - 48);
          page.style.width = box.w + "px";
          page.style.height = box.h + "px";
          const p = PAPER[opts.size];
          const pageWidthMm = opts.orient === "portrait" ? p.w : p.h;
          inner.style.padding = (opts.marginMm / pageWidthMm * box.w) + "px";
          pimg.style.objectFit = opts.fit;
          pimg.style.border = opts.border ? "1px solid #333" : "none";
        }
        const cancel = mkBtn("\u0110\xF3ng", "secondary");
        const print = mkBtn("In", "primary");
        print.disabled = true;
        m.footer.appendChild(cancel);
        m.footer.appendChild(print);
        cancel.onclick = m.close;
        print.onclick = () => doPrint(src, opts);
        pimg.onload = () => {
          print.disabled = false;
          render();
        };
        pimg.onerror = () => {
          m.header.textContent = "Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c \u1EA3nh";
        };
        pimg.src = src;
        const onResize = () => render();
        window.addEventListener("resize", onResize);
        cleanup = () => window.removeEventListener("resize", onResize);
        cancel.onclick = m.close;
        requestAnimationFrame(render);
      }
      function doPrint(src, opts) {
        if (isLocked() || !src) return;
        opts = opts || { size: "A4", orient: "portrait", fit: "contain", marginMm: 10, border: false };
        if (!Object.hasOwn(PAPER, opts.size) || !['portrait', 'landscape'].includes(opts.orient) ||
            !['contain', 'cover'].includes(opts.fit) || !Number.isFinite(opts.marginMm) ||
            opts.marginMm < 0 || opts.marginMm > 40 || typeof opts.border !== 'boolean')
          throw new TypeError('Invalid print settings');
        const iframe = document.createElement("iframe");
        iframe.className = "zpf-print-frame";
        iframe.setAttribute("aria-hidden", "true");
        document.body.appendChild(iframe);
        const fitCss = opts.fit === "cover" ? "width:100%;height:100%;object-fit:cover;" : "max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;";
        const borderCss = opts.border ? "border:1px solid #000;box-sizing:border-box;" : "";
        const doc = iframe.contentWindow.document;
        doc.open();
        doc.write(
          '<!doctype html><html><head><meta charset="utf-8"><style>@page{size:' + opts.size + " " + opts.orient + ";margin:" + opts.marginMm + "mm;}html,body{margin:0;padding:0;height:100%;}body{display:flex;align-items:center;justify-content:center;}img{" + fitCss + borderCss + 'display:block;}</style></head><body><img id="zpf-img"></body></html>'
        );
        doc.close();
        const im = doc.getElementById("zpf-img");
        let finished = false;
        const loadTimeout = setTimeout(cleanup, 30000);
        function cleanup() {
          if (finished) return;
          finished = true;
          clearTimeout(loadTimeout);
          activeClosers.delete(cleanup);
          iframe.contentWindow.removeEventListener('afterprint', cleanup);
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }
        activeClosers.add(cleanup);
        iframe.contentWindow.addEventListener('afterprint', cleanup, {once: true});
        function fire() {
          clearTimeout(loadTimeout);
          if (finished || isLocked()) { cleanup(); return; }
          try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
          } catch (e) {
            cleanup();
            console.error('Zalo Linux: print dialog failed');
          }
        }
        im.onload = fire;
        im.onerror = cleanup;
        im.src = src;
      }
      module.exports = { openPreview: openPreview2, doPrint };
    }
  });

  // src/icons.js
  var require_icons = __commonJS({
    "src/icons.js"(exports, module) {
      var MAP = {
        print: "fi-print",
        edit: "fi-edit",
        cursor: "fi-cursor",
        pen: "fi-pen",
        text: "fi-text",
        arrow: "fi-arrow",
        rect: "fi-rect",
        undo: "fi-undo",
        redo: "fi-redo",
        delete: "fi-delete",
        clear: "fi-clear",
        copy: "fi-copy",
        close: "fi-close"
      };
      function icon2(name) {
        // Self-contained icons: the Windows patcher's icon font is not assumed.
        const paths = {
          print: 'M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6z',
          edit: 'm4 16 12-12 4 4L8 20H4zM13 7l4 4',
          cursor: 'M5 3v17l5-5 4 6 3-2-4-6h7z',
          pen: 'm4 16 12-12 4 4L8 20H4zM13 7l4 4',
          text: 'M4 5h16M12 5v15M8 20h8',
          arrow: 'M4 20 20 4M9 4h11v11',
          rect: 'M4 4h16v16H4z',
          undo: 'M8 5 3 10l5 5M3 10h11a6 6 0 0 1 0 12',
          redo: 'm16 5 5 5-5 5M21 10H10a6 6 0 0 0 0 12',
          delete: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
          clear: 'm4 14 9-11 8 7-9 11H9zM7 11l9 7M3 21h19',
          copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
          close: 'm5 5 14 14M19 5 5 19'
        };
        return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (paths[name] || paths.edit) + '"/></svg>';
      }
      module.exports = { icon: icon2 };
    }
  });

  // src/editor.js
  var require_editor = __commonJS({
    "src/editor.js"(exports, module) {
      var { buildModal, mkBtn } = require_modal();
      var { icon: icon2 } = require_icons();
      var { openPreview: openPreview2 } = require_print();
      var fabric = window.fabric;
      function buildOverlayChrome(onClose) {
        const backdrop = document.createElement("div");
        backdrop.className = "zpf-veditor-backdrop";
        const modal = document.createElement("div");
        modal.className = "zpf-veditor";
        const header = document.createElement("div");
        header.className = "zpf-veditor-header";
        const body = document.createElement("div");
        body.className = "zpf-modal-body zpf-veditor-body";
        const footer = document.createElement("div");
        footer.className = "zpf-modal-footer zpf-veditor-footer";
        modal.appendChild(header);
        modal.appendChild(body);
        modal.appendChild(footer);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        let closed = false;
        activeClosers.add(close);
        function close() {
          if (closed) return;
          closed = true;
          activeClosers.delete(close);
          document.removeEventListener("keydown", onKey);
          if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
          if (typeof onClose === "function") {
            try {
              onClose();
            } catch (e) {
            }
          }
        }
        function onKey(e) {
          if (e.key === "Escape" && [...activeClosers].at(-1) === close) close();
        }
        document.addEventListener("keydown", onKey);
        return { backdrop, modal, header, body, footer, close };
      }
      function openEditor2(src, opts) {
        if (!src || isLocked()) return;
        if (!fabric?.Canvas) throw new Error('Image editor dependency unavailable');
        opts = opts || {};
        let cleanupFn = null, closed = false;
        const imageUrls = new Set();
        const onClose = () => {
          closed = true;
          for (const url of imageUrls) URL.revokeObjectURL(url);
          imageUrls.clear();
          if (cleanupFn) cleanupFn();
        };
        const m = opts.overlay ? buildOverlayChrome(onClose) : buildModal("S\u1EEDa \u1EA3nh", true, onClose);
        if (opts.overlay && m.header) {
          m.header.textContent = "Ph\xEDm t\u1EAFt:  V ch\u1ECDn \xB7 B b\xFAt \xB7 T ch\u1EEF \xB7 A m\u0169i t\xEAn \xB7 R khung \xB7 [ ] c\u1EE1 n\xE9t \xB7 Ctrl+Z ho\xE0n t\xE1c \xB7 Delete xo\xE1";
        }
        const state = { tool: "select", color: "#ff2d2d", size: 4, fontSize: 28, drawStart: null, temp: null };
        const undoStack = [], redoStack = [];
        const tb = document.createElement("div");
        tb.className = "zpf-toolbar";
        m.modal.insertBefore(tb, m.body);
        const tools = [
          ["select", "Ch\u1ECDn / di chuy\u1EC3n (V)", "cursor"],
          ["pen", "B\xFAt v\u1EBD (B)", "pen"],
          ["text", "Ch\u1EEF (T)", "text"],
          ["arrow", "M\u0169i t\xEAn (A)", "arrow"],
          ["rect", "Khung (R)", "rect"]
        ];
        const toolBtns = {};
        const tgroup = document.createElement("div");
        tgroup.className = "zpf-tool-group";
        tools.forEach(([id, title, ic]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "zpf-tool";
          b.title = title;
          b.innerHTML = icon2(ic);
          b.onclick = () => setTool(id);
          toolBtns[id] = b;
          tgroup.appendChild(b);
        });
        tb.appendChild(tgroup);
        const colors = ["#ff2d2d", "#ffcc00", "#22c55e", "#2d7dff", "#000000", "#ffffff"];
        const cgroup = document.createElement("div");
        cgroup.className = "zpf-color-group";
        const colorBtns = {};
        colors.forEach((c) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "zpf-color";
          b.style.background = c;
          b.title = c;
          b.onclick = () => {
            state.color = c;
            Object.keys(colorBtns).forEach((k) => colorBtns[k].classList.toggle("active", k === c));
            applyColorToSelection();
            if (brush()) brush().color = c;
          };
          colorBtns[c] = b;
          cgroup.appendChild(b);
        });
        cgroup.firstChild.classList.add("active");
        tb.appendChild(cgroup);
        const sizeWrap = document.createElement("label");
        sizeWrap.className = "zpf-size";
        sizeWrap.title = "C\u1EE1 n\xE9t / ch\u1EEF ([ v\xE0 ])";
        const sizeInput = document.createElement("input");
        sizeInput.type = "range";
        sizeInput.min = "2";
        sizeInput.max = "40";
        sizeInput.value = "4";
        sizeInput.oninput = () => {
          setSize(parseInt(sizeInput.value, 10));
        };
        sizeWrap.appendChild(sizeInput);
        tb.appendChild(sizeWrap);
        function setSize(v) {
          v = Math.max(2, Math.min(40, v));
          state.size = v;
          sizeInput.value = String(v);
          if (brush()) brush().width = v;
        }
        const fsWrap = document.createElement("label");
        fsWrap.className = "zpf-fontsize";
        fsWrap.title = "C\u1EE1 ch\u1EEF";
        fsWrap.innerHTML = '<span class="zpf-fs-ico">A</span>';
        const fsInput = document.createElement("input");
        fsInput.type = "number";
        fsInput.min = "8";
        fsInput.max = "200";
        fsInput.step = "2";
        fsInput.value = String(state.fontSize);
        fsInput.className = "zpf-num";
        fsInput.oninput = () => {
          const raw = fsInput.value.trim();
          if (raw === "") return;
          const v = parseInt(raw, 10);
          if (isNaN(v)) return;
          state.fontSize = Math.max(8, Math.min(200, v));
          applyFontSizeToSelection();
        };
        fsInput.onblur = () => {
          setFontSize(parseInt(fsInput.value, 10));
        };
        fsInput.onkeydown = (e) => {
          e.stopPropagation();
          if (e.key === "Enter") fsInput.blur();
        };
        fsWrap.appendChild(fsInput);
        tb.appendChild(fsWrap);
        function setFontSize(v) {
          if (isNaN(v)) v = state.fontSize;
          v = Math.max(8, Math.min(200, v));
          state.fontSize = v;
          fsInput.value = String(v);
          applyFontSizeToSelection();
        }
        const ugroup = document.createElement("div");
        ugroup.className = "zpf-tool-group";
        const undoBtn = miniBtn("Ho\xE0n t\xE1c (Ctrl+Z)", "undo", doUndo);
        const redoBtn = miniBtn("L\xE0m l\u1EA1i (Ctrl+Y)", "redo", doRedo);
        const delBtn = miniBtn("Xo\xE1 \u0111\xE3 ch\u1ECDn (Delete)", "delete", deleteSelected);
        const clearBtn = miniBtn("Xo\xE1 h\u1EBFt", "clear", clearAll);
        [undoBtn, redoBtn, delBtn, clearBtn].forEach((b) => ugroup.appendChild(b));
        tb.appendChild(ugroup);
        function miniBtn(title, ic, fn) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "zpf-tool";
          b.title = title;
          b.innerHTML = icon2(ic);
          b.onclick = fn;
          return b;
        }
        const stage = document.createElement("div");
        stage.className = "zpf-stage";
        m.body.appendChild(stage);
        const canvasEl = document.createElement("canvas");
        stage.appendChild(canvasEl);
        const canvas = new fabric.Canvas(canvasEl, { preserveObjectStacking: true, selection: true });
        const copyStatus = document.createElement("span");
        copyStatus.className = "zpf-copy-status";
        const closeBtn = mkBtn("\u0110\xF3ng", "secondary");
        const printBtn = mkBtn("In \u1EA3nh \u0111\xE3 v\u1EBD", "secondary");
        const copyBtn = mkBtn("Copy \u1EA3nh", "primary");
        copyBtn.disabled = true;
        m.footer.appendChild(copyStatus);
        m.footer.appendChild(closeBtn);
        m.footer.appendChild(printBtn);
        m.footer.appendChild(copyBtn);
        closeBtn.onclick = () => {
          m.close();
        };
        let bgImage = null, natW = 0, natH = 0;
        function onImageReady(img) {
          if (closed || !img || !img.width || !img.height) return;
          natW = img.width;
          natH = img.height;
          const maxW = stage.clientWidth || 900, maxH = stage.clientHeight || 520;
          const scale = Math.min(maxW / natW, maxH / natH, 1);
          canvas.setWidth(natW * scale);
          canvas.setHeight(natH * scale);
          img.set({ selectable: false, evented: false, left: 0, top: 0, scaleX: scale, scaleY: scale });
          canvas.add(img);
          canvas.sendToBack(img);
          bgImage = img;
          canvas.renderAll();
          copyBtn.disabled = false;
          pushHistory();
        }
        function loadEditorImage(src2) {
          fetch(src2).then((r) => {
            if (!r.ok) throw new Error("fetch");
            return r.blob();
          }).then((b) => {
            if (closed) return;
            const url = URL.createObjectURL(b);
            imageUrls.add(url);
            fabric.Image.fromURL(url, (img) => {
              onImageReady(img);
            }, { crossOrigin: "anonymous" });
          }).catch(() => {
            if (closed) return;
            fabric.Image.fromURL(src2, (img) => {
              if (img) onImageReady(img);
              else m.header.textContent = "Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c \u1EA3nh";
            }, { crossOrigin: "anonymous" });
          });
        }
        loadEditorImage(src);
        function brush() {
          return canvas.freeDrawingBrush;
        }
        function setTool(id) {
          state.tool = id;
          Object.keys(toolBtns).forEach((k) => toolBtns[k].classList.toggle("active", k === id));
          canvas.isDrawingMode = id === "pen";
          canvas.selection = id === "select";
          if (id === "pen") {
            brush().color = state.color;
            brush().width = state.size;
          }
          canvas.forEachObject((o) => {
            if (o !== bgImage) {
              o.selectable = id === "select";
              o.evented = id === "select";
            }
          });
          canvas.defaultCursor = id === "select" ? "default" : "crosshair";
          canvas.renderAll();
        }
        setTool("select");
        function syncControlsFromSelection() {
          const a = canvas.getActiveObject();
          if (a && isTextObj(a)) {
            state.fontSize = Math.round(a.fontSize || state.fontSize);
            fsInput.value = String(state.fontSize);
          }
        }
        canvas.on("selection:created", syncControlsFromSelection);
        canvas.on("selection:updated", syncControlsFromSelection);
        function isTextObj(o) {
          return o && (o.type === "textbox" || o.type === "i-text" || o.type === "text");
        }
        function applyColorToSelection() {
          const selected = canvas.getActiveObjects().filter(o => o !== bgImage);
          selected.forEach((o) => {
            if (isTextObj(o)) o.set("fill", state.color);
            else if (o.type === "group") o.getObjects().forEach((c) => {
              if (c.type === "triangle") c.set("fill", state.color);
              else c.set("stroke", state.color);
            });
            else if (o.type === "triangle") o.set("fill", state.color);
            else o.set("stroke", state.color);
          });
          canvas.renderAll();
          if (selected.length) pushHistory();
        }
        function applyFontSizeToSelection() {
          const selected = canvas.getActiveObjects().filter(isTextObj);
          selected.forEach(o => o.set("fontSize", state.fontSize));
          canvas.renderAll();
          if (selected.length) pushHistory();
        }
        canvas.on("mouse:down", (e) => {
          if (state.tool === "text" || state.tool === "rect" || state.tool === "arrow") {
            const p = canvas.getPointer(e.e);
            state.drawStart = p;
            if (state.tool === "arrow") {
              state.temp = new fabric.Line([p.x, p.y, p.x, p.y], { stroke: state.color, strokeWidth: state.size });
            } else if (state.tool === "rect") {
              state.temp = new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: "transparent", stroke: state.color, strokeWidth: state.size });
            } else {
              state.temp = new fabric.Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: "rgba(0,104,255,0.06)", stroke: state.color, strokeWidth: 1, strokeDashArray: [5, 4] });
            }
            state.temp.selectable = false;
            state.temp.evented = false;
            canvas.add(state.temp);
          }
        });
        canvas.on("mouse:move", (e) => {
          if (!state.drawStart || !state.temp) return;
          const p = canvas.getPointer(e.e);
          if (state.tool === "arrow") {
            state.temp.set({ x2: p.x, y2: p.y });
          } else {
            state.temp.set({ width: Math.abs(p.x - state.drawStart.x), height: Math.abs(p.y - state.drawStart.y), left: Math.min(p.x, state.drawStart.x), top: Math.min(p.y, state.drawStart.y) });
          }
          canvas.renderAll();
        });
        canvas.on("mouse:up", () => {
          if (state.drawStart && state.temp) {
            if (state.tool === "text") {
              const boxW = state.temp.width || 0;
              const left = state.temp.left, top = state.temp.top;
              canvas.remove(state.temp);
              const width = boxW < 20 ? 240 : boxW;
              const tbox = new fabric.Textbox("Nh\u1EADp ch\u1EEF", {
                left,
                top,
                width,
                fill: state.color,
                fontSize: state.fontSize,
                fontFamily: "Arial"
              });
              canvas.add(tbox);
              canvas.setActiveObject(tbox);
              tbox.enterEditing();
              tbox.selectAll();
              setTool("select");
              pushHistory();
            } else if (state.tool === "rect") {
              const w = state.temp.width || 0, h = state.temp.height || 0;
              if (w < 3 && h < 3) {
                canvas.remove(state.temp);
                state.drawStart = null;
                state.temp = null;
                return;
              }
              state.temp.selectable = true;
              state.temp.evented = true;
              canvas.renderAll();
              pushHistory();
            } else if (state.tool === "arrow") {
              const dx = state.temp.x2 - state.temp.x1, dy = state.temp.y2 - state.temp.y1;
              if (Math.sqrt(dx * dx + dy * dy) < 3) {
                canvas.remove(state.temp);
                state.drawStart = null;
                state.temp = null;
                return;
              }
              finalizeArrow(state.temp);
              canvas.renderAll();
              pushHistory();
            }
          }
          state.drawStart = null;
          state.temp = null;
        });
        canvas.on("path:created", () => pushHistory());
        canvas.on("object:modified", () => pushHistory());
        canvas.on("text:editing:exited", () => pushHistory());
        function finalizeArrow(line) {
          const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
          const ang = Math.atan2(dy, dx) * 180 / Math.PI;
          const head = new fabric.Triangle({ left: line.x2, top: line.y2, originX: "center", originY: "center", angle: ang + 90, width: state.size * 4 + 6, height: state.size * 4 + 6, fill: state.color });
          canvas.remove(line);
          const l2 = new fabric.Line([line.x1, line.y1, line.x2, line.y2], { stroke: state.color, strokeWidth: state.size });
          const grp = new fabric.Group([l2, head], { selectable: true });
          canvas.add(grp);
        }
        function snapshot() {
          return JSON.stringify(canvas.toJSON());
        }
        function pushHistory() {
          if (closed || !bgImage) return;
          const next = snapshot();
          if (undoStack[undoStack.length - 1] === next) return;
          undoStack.push(next);
          if (undoStack.length > 50) undoStack.shift();
          redoStack.length = 0;
        }
        function restore(json) {
          canvas.loadFromJSON(json, () => {
            bgImage = canvas.getObjects().find((o) => o.type === "image") || null;
            if (bgImage) {
              bgImage.selectable = false;
              bgImage.evented = false;
            }
            setTool(state.tool);
            canvas.renderAll();
          });
        }
        function doUndo() {
          if (undoStack.length <= 1) return;
          redoStack.push(undoStack.pop());
          restore(undoStack[undoStack.length - 1]);
        }
        function doRedo() {
          if (!redoStack.length) return;
          const j = redoStack.pop();
          undoStack.push(j);
          restore(j);
        }
        function deleteSelected() {
          const objs = canvas.getActiveObjects().filter((o) => o !== bgImage);
          if (!objs.length) return;
          objs.forEach((o) => canvas.remove(o));
          canvas.discardActiveObject();
          canvas.renderAll();
          pushHistory();
        }
        function clearAll() {
          canvas.getObjects().slice().forEach((o) => {
            if (o !== bgImage) canvas.remove(o);
          });
          canvas.renderAll();
          pushHistory();
        }
        function isEditingText() {
          const a = canvas.getActiveObject();
          return a && a.isEditing;
        }
        function isTypingTarget(e) {
          const t = e.target;
          if (!t) return false;
          const tag = (t.tagName || "").toLowerCase();
          return tag === "input" || tag === "textarea" || t.isContentEditable;
        }
        const TOOL_KEYS = { v: "select", b: "pen", t: "text", a: "arrow", r: "rect" };
        function pasteIntoText(obj) {
          if (!navigator.clipboard || !navigator.clipboard.readText) return;
          navigator.clipboard.readText().then((txt) => {
            if (!txt) return;
            const s = obj.selectionStart || 0, en = obj.selectionEnd || 0;
            if (obj.isEditing && typeof obj.insertChars === "function") {
              obj.insertChars(txt, null, s, en);
            } else {
              const full = obj.text || "";
              obj.set("text", full.slice(0, s) + txt + full.slice(en));
              obj.selectionStart = obj.selectionEnd = s + txt.length;
              if (obj.hiddenTextarea) obj.hiddenTextarea.value = obj.text;
            }
            obj.dirty = true;
            canvas.requestRenderAll();
          }).catch(() => {
          });
        }
        function copyFromText(obj) {
          if (!navigator.clipboard || !navigator.clipboard.writeText) return;
          let txt = "";
          if (obj.isEditing && obj.selectionStart !== obj.selectionEnd) txt = (obj.text || "").slice(obj.selectionStart, obj.selectionEnd);
          else txt = obj.text || "";
          if (txt) navigator.clipboard.writeText(txt).catch(() => {
          });
        }
        const onKey = (e) => {
          const ctrl0 = e.ctrlKey || e.metaKey;
          const active = canvas.getActiveObject();
          if (ctrl0 && (e.key === "v" || e.key === "V") && active && isTextObj(active)) {
            e.preventDefault();
            e.stopPropagation();
            pasteIntoText(active);
            return;
          }
          if (ctrl0 && (e.key === "c" || e.key === "C") && active && isTextObj(active)) {
            e.preventDefault();
            e.stopPropagation();
            copyFromText(active);
            return;
          }
          if (isEditingText() || isTypingTarget(e)) return;
          const ctrl = e.ctrlKey || e.metaKey;
          if (ctrl && (e.key === "z" || e.key === "Z")) {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) doRedo();
            else doUndo();
            return;
          }
          if (ctrl && (e.key === "y" || e.key === "Y")) {
            e.preventDefault();
            e.stopPropagation();
            doRedo();
            return;
          }
          if (ctrl) return;
          if (e.key === "Delete" || e.key === "Backspace") {
            e.stopPropagation();
            deleteSelected();
            return;
          }
          if (e.key === "[") {
            e.preventDefault();
            setSize(state.size - 2);
            return;
          }
          if (e.key === "]") {
            e.preventDefault();
            setSize(state.size + 2);
            return;
          }
          const k = (e.key || "").toLowerCase();
          if (TOOL_KEYS[k]) {
            e.preventDefault();
            e.stopPropagation();
            setTool(TOOL_KEYS[k]);
          }
        };
        document.addEventListener("keydown", onKey, true);
        function exportDataUrl() {
          const scale = natW ? natW / canvas.getWidth() : 1;
          canvas.discardActiveObject();
          canvas.renderAll();
          return canvas.toDataURL({ format: "png", multiplier: scale });
        }
        copyBtn.onclick = () => {
          copyStatus.textContent = "\u0110ang copy...";
          let dataUrl, blob;
          try {
            dataUrl = exportDataUrl();
            blob = dataUrlToBlob(dataUrl);
          } catch (e) {
            copyStatus.textContent = "Kh\xF4ng xu\u1EA5t \u0111\u01B0\u1EE3c \u1EA3nh n\xE0y (b\u1ECB ch\u1EB7n b\u1EA3o m\u1EADt).";
            return;
          }
          copyBlob(blob, dataUrl).then(() => {
            copyStatus.textContent = "\u2713 \u0110\xE3 copy \u2014 Ctrl+V v\xE0o khung chat \u0111\u1EC3 g\u1EEDi";
          }).catch((err) => {
            copyStatus.textContent = "Copy th\u1EA5t b\u1EA1i: " + (err && err.name || "");
          });
        };
        printBtn.onclick = () => {
          let dataUrl;
          try {
            dataUrl = exportDataUrl();
          } catch (e) {
            copyStatus.textContent = "Kh\xF4ng xu\u1EA5t \u0111\u01B0\u1EE3c \u1EA3nh n\xE0y \u0111\u1EC3 in (b\u1ECB ch\u1EB7n b\u1EA3o m\u1EADt).";
            return;
          }
          openPreview2(dataUrl);
        };
        cleanupFn = () => {
          document.removeEventListener("keydown", onKey, true);
          canvas.dispose();
        };
        closeBtn.onclick = m.close;
      }
      function dataUrlToBlob(dataUrl) {
        const parts = dataUrl.split(",");
        const mime = (parts[0].match(/:(.*?);/) || [])[1] || "image/png";
        const bin = atob(parts[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
      }
      function copyBlob(blob, dataUrl) {
        if (navigator.clipboard && window.ClipboardItem) return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        return new Promise((res, rej) => {
          try {
            const zen = window.$zelectronNative;
            if (zen && zen.writeImageToClipboard) {
              zen.writeImageToClipboard(dataUrl);
              res();
            } else rej(new Error("no clipboard"));
          } catch (e) {
            rej(e);
          }
        });
      }
      module.exports = { openEditor: openEditor2 };
    }
  });

  // src/index.js
  var { bestSrc } = require_detect();
  var { openPreview } = require_print();
  var { openEditor } = require_editor();
  var { icon } = require_icons();
  if (!window.__ZALO_PRINT_FEATURE__) {
    let currentImageEl = function() {
      if (isLocked()) return null;
      const imgs = [].slice.call(document.querySelectorAll("img.zimg-el"));
      let best = null, area = 0;
      imgs.forEach(function(i) {
        const r = i.getBoundingClientRect();
        const a = r.width * r.height;
        if (a > area) {
          area = a;
          best = i;
        }
      });
      return best;
    }, currentImageSrc = function() {
      const el = currentImageEl();
      return el ? bestSrc(el) : null;
    }, mkViewerBtn = function(title, iconName, onClick) {
      const b = document.createElement("button");
      b.type = 'button';
      b.className = "z--btn--v2 btn-tertiary-neutral medium btn --rounded icon-only zpf-vbtn";
      b.setAttribute("title", title);
      b.setAttribute("aria-label", title);
      b.setAttribute("role", "button");
      b.innerHTML = icon(iconName);
      b.addEventListener("click", function(e) {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    }, injectButtons = function() {
      const cont = document.querySelector(TOOLBAR_SEL);
      if (!cont) return;
      const group = cont.querySelector("action-group, .action-group") || cont;
      if (group.querySelector(".zpf-vbtn")) return;
      const drawBtn = mkViewerBtn("V\u1EBD / ch\xFA th\xEDch", "edit", function() {
        const s = currentImageSrc();
        if (s) openEditor(s, { overlay: true });
      });
      const printBtn = mkViewerBtn("In \u1EA3nh (Ctrl+P)", "print", function() {
        const s = currentImageSrc();
        if (s) openPreview(s);
      });
      group.appendChild(drawBtn);
      group.appendChild(printBtn);
    }, start = function() {
      injectButtons();
      let pending = false;
      new MutationObserver(function() {
        if (isLocked()) for (const close of [...activeClosers]) close();
        if (pending) return;
        pending = true;
        requestAnimationFrame(function() {
          pending = false;
          injectButtons();
        });
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      document.addEventListener("keydown", function(e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "P")) {
          const s = currentImageSrc();
          if (!s || activeClosers.size) return;
          e.preventDefault();
          e.stopPropagation();
          if (s) openPreview(s);
        }
      }, true);
    };
    currentImageEl2 = currentImageEl, currentImageSrc2 = currentImageSrc, mkViewerBtn2 = mkViewerBtn, injectButtons2 = injectButtons, start2 = start;
    window.__ZALO_PRINT_FEATURE__ = true;
    const TOOLBAR_SEL = ".media-viewer__footer__child.image-action, .media-viewer .image-action, .media-viewer__footer action-group";
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
  var currentImageEl2;
  var currentImageSrc2;
  var mkViewerBtn2;
  var injectButtons2;
  var start2;
})();
