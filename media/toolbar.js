// FrontPeek — injectable floating toolbar
// ---------------------------------------------------------------------------
// This runs *inside the real app*, at its real origin, in the user's real
// browser — NOT inside a VS Code webview iframe. It replaces the old webview
// toolbar shell (getWebviewHtml in extension.js): it appends a draggable
// floating toolbar to the page <body> and bridges the inspector to the VS Code
// extension over a plain HTTP/SSE channel (no iframe, no proxy, no tunnel).
//
// It reuses media/inspector.js verbatim. The inspector already talks to its
// host via `window.parent.postMessage(...)` and `window.addEventListener(
// 'message', ...)`. When the page is not framed, `window.parent === window`,
// so those messages are delivered to same-window listeners — this toolbar is
// one of them. So the inspector needs no changes: we listen for the messages
// it emits and forward the extension-bound ones over the bridge, and we post
// control messages back to `window` for the inspector to pick up.
//
// Transport: browser-native. EventSource (SSE) for extension -> page (copy
// acks), fetch POST for page -> extension (open-source / ai-prompt /
// css-prompt). No WebSocket framing, no dependencies — same spirit as the
// dependency-free extension host.
(function () {
  if (window.__frontpeekToolbar) return; // idempotent: survive HMR re-injection
  window.__frontpeekToolbar = true;

  // The extension serves this file concatenated after a one-line config that
  // sets the bridge origin. Fall back to the script tag's own origin.
  var BRIDGE =
    window.__FRONTPEEK_BRIDGE__ ||
    (function () {
      var s = document.currentScript;
      try {
        return s ? new URL(s.src).origin : null;
      } catch (_) {
        return null;
      }
    })();

  var mode = null; // null | 'edit' | 'ai' | 'css'

  // -- styles ---------------------------------------------------------------
  // Scoped under #__pv-toolbar and reset with `all:initial` on the root so the
  // host app's CSS can't bleed in (and vice-versa).
  var css =
    '#__pv-toolbar{all:initial;position:fixed;z-index:2147483646;top:0;left:0;' +
    'display:flex;align-items:center;gap:4px;padding:6px;' +
    'background:#1e1e1eF2;border:1px solid #ffffff1f;border-radius:12px;' +
    'box-shadow:0 8px 30px #0009,0 1px 0 #ffffff14 inset;' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
    'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);user-select:none;' +
    'transition:transform .34s cubic-bezier(.34,1.26,.4,1),opacity .2s ease;}' +
    '#__pv-toolbar.__pv-hidden{cursor:pointer;}' +
    '#__pv-toolbar.__pv-hidden *{pointer-events:none;}' +
    '#__pv-toolbar *{box-sizing:border-box;}' +
    '#__pv-toolbar .__pv-grip{display:flex;align-items:center;justify-content:center;' +
    'width:22px;height:30px;color:#6b6b6b;cursor:move;flex-shrink:0;letter-spacing:2px;font-size:11px;}' +
    '#__pv-toolbar button{display:flex;align-items:center;gap:5px;height:30px;padding:0 10px;' +
    'background:transparent;border:1px solid transparent;border-radius:7px;color:#d4d4d8;' +
    'cursor:pointer;font-size:12px;font-family:inherit;line-height:1;}' +
    '#__pv-toolbar button:hover{background:#ffffff14;}' +
    '#__pv-toolbar button.active{color:#fff;}' +
    '#__pv-toolbar #__pv-edit.active{background:#2f81f7;border-color:#2f81f7;}' +
    '#__pv-toolbar #__pv-css.active{background:linear-gradient(135deg,#0ea5e9,#2563eb);}' +
    '#__pv-toolbar #__pv-ai.active{background:linear-gradient(135deg,#7c3aed,#4f46e5);}' +
    '#__pv-toolbar .__pv-dot{width:7px;height:7px;border-radius:50%;background:#f87171;flex-shrink:0;' +
    'margin:0 4px;transition:background .2s;}' +
    '#__pv-toolbar .__pv-dot.__pv-live{background:#4ade80;}' +
    '#__pv-toolbar .__pv-cogsep{width:1px;height:20px;background:#ffffff1f;margin:0 3px;flex-shrink:0;}' +
    '#__pv-toolbar #__pv-cog{padding:0 8px;}' +
    '#__pv-toolbar #__pv-cog.__pv-on{background:#ffffff14;color:#fff;}' +
    '#__pv-pop{all:initial;display:none;position:fixed;z-index:2147483647;width:206px;padding:6px;' +
    'background:#1e1e1eF7;border:1px solid #ffffff1f;border-radius:10px;box-shadow:0 12px 34px #000a;' +
    'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}" +
    '#__pv-pop *{box-sizing:border-box;}' +
    '#__pv-pop .__pv-item{display:flex;align-items:center;gap:9px;width:100%;height:32px;padding:0 9px;' +
    'background:transparent;border:none;border-radius:6px;color:#d4d4d8;font-size:12px;cursor:pointer;' +
    'font-family:inherit;text-align:left;}' +
    '#__pv-pop .__pv-item:hover{background:#ffffff14;color:#fff;}' +
    '#__pv-pop .__pv-item svg{flex-shrink:0;opacity:.85;}' +
    '#__pv-pop .__pv-div{height:1px;background:#ffffff14;margin:5px 3px;}' +
    '#__pv-pop .__pv-poslabel{display:block;padding:3px 9px 2px;color:#8b8b8b;font-size:10px;' +
    'text-transform:uppercase;letter-spacing:.07em;}' +
    '#__pv-pop select{width:calc(100% - 6px);height:30px;margin:0 3px 3px;padding:0 8px;' +
    'background:#2a2a2a;color:#e4e4e7;border:1px solid #ffffff26;border-radius:6px;' +
    'font-size:12px;font-family:inherit;cursor:pointer;}';

  var styleEl = document.createElement('style');
  styleEl.textContent = css;

  // -- toolbar element ------------------------------------------------------
  var bar = document.createElement('div');
  bar.id = '__pv-toolbar';
  bar.innerHTML =
    '<span class="__pv-grip" title="Drag">⋮⋮</span>' +
    '<span class="__pv-dot" title="Disconnected from the FrontPeek extension"></span>' +
    '<button id="__pv-edit" title="Code: click an element to open its source">' +
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3.5 1.5 8l4 4.5M10.5 3.5l4 4.5-4 4.5"/></svg>' +
    '<span>Code</span></button>' +
    '<button id="__pv-css" title="Edit: tweak an element\'s styles live and copy the change as a prompt">' +
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 4h6.3M11.7 4H14M2 8h2.3M7.7 8H14M2 12h8.3M13.7 12H14"/><circle cx="10" cy="4" r="1.7"/><circle cx="6" cy="8" r="1.7"/><circle cx="12" cy="12" r="1.7"/></svg>' +
    '<span>Edit</span></button>' +
    '<button id="__pv-ai" title="Prompt: click an element and describe the change">' +
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13 6.2 8.8 2 7l4.2-1.8L8 1z"/><path d="M13 10l.9 2.1L16 13l-2.1.9L13 16l-.9-2.1L10 13l2.1-.9L13 10z"/></svg>' +
    '<span>Prompt</span></button>' +
    '<span class="__pv-cogsep"></span>' +
    '<button id="__pv-cog" title="FrontPeek settings" aria-label="Settings">' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
    '</button>';

  function mount() {
    if (!document.body) return document.addEventListener('DOMContentLoaded', mount);
    document.documentElement.appendChild(styleEl);
    document.body.appendChild(bar);
    restoreUI(); // apply persisted position/hidden state once in the DOM
  }

  var editBtn = bar.querySelector('#__pv-edit');
  var cssBtn = bar.querySelector('#__pv-css');
  var aiBtn = bar.querySelector('#__pv-ai');
  var dotEl = bar.querySelector('.__pv-dot');
  var cogBtn = bar.querySelector('#__pv-cog');

  // -- mode toggling --------------------------------------------------------
  // The toolbar is authoritative over `mode`; it tells the inspector via the
  // same `pv-set-inspect` message the old webview shell used.
  function applyMode(m) {
    mode = mode === m ? null : m;
    editBtn.classList.toggle('active', mode === 'edit');
    cssBtn.classList.toggle('active', mode === 'css');
    aiBtn.classList.toggle('active', mode === 'ai');
    // The inspector lives in this same window; posting to `window` delivers to
    // its `message` listener (see media/inspector.js).
    window.postMessage({ type: 'pv-set-inspect', enabled: !!mode, mode: mode }, '*');
  }
  editBtn.addEventListener('click', function () { applyMode('edit'); });
  cssBtn.addEventListener('click', function () { applyMode('css'); });
  aiBtn.addEventListener('click', function () { applyMode('ai'); });

  // -- settings: position, hide, config popover -----------------------------
  var POS_LABELS = [
    ['top-left', 'Top-left'], ['top-center', 'Top-center'], ['top-right', 'Top-right'],
    ['bottom-left', 'Bottom-left'], ['bottom-middle', 'Bottom-middle'], ['bottom-right', 'Bottom-right'],
  ];
  var VALID_POS = {};
  POS_LABELS.forEach(function (o) { VALID_POS[o[0]] = true; });
  var MARGIN = 16;
  var STORE = 'frontpeek:ui';
  var state = { position: 'bottom-middle', hidden: false };
  try {
    var raw = localStorage.getItem(STORE);
    if (raw) {
      var saved = JSON.parse(raw);
      if (saved && VALID_POS[saved.position]) state.position = saved.position;
      state.hidden = !!(saved && saved.hidden);
    }
  } catch (_) {}
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {}
  }

  // Positioning is done entirely with `transform: translate(x,y)` (the bar is
  // pinned at top:0/left:0). Animating a single transform — instead of swapping
  // top/bottom/left/right, which can't transition to/from `auto` — lets the bar
  // glide smoothly between ANY positions, including bottom<->top and hide.
  function moveTo(x, y) {
    bar.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }
  function coordsFor(pos) {
    var w = bar.offsetWidth, h = bar.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    var x = pos.indexOf('left') >= 0 ? MARGIN
          : pos.indexOf('right') >= 0 ? (vw - w - MARGIN)
          : (vw - w) / 2;                      // top-center / bottom-middle
    var y = pos.indexOf('top') >= 0 ? MARGIN : (vh - h - MARGIN);
    return { x: x, y: y };
  }
  function applyPosition(pos) {
    var c = coordsFor(pos);
    moveTo(c.x, c.y);
  }
  // Hidden: dock bottom-right, slid down so only `peek` px show above the edge.
  function dockHidden(peek) {
    moveTo(window.innerWidth - bar.offsetWidth - MARGIN, window.innerHeight - peek);
  }

  function setHidden(h) {
    state.hidden = h;
    save();
    if (h) {
      closePopover();
      bar.classList.add('__pv-hidden');
      dockHidden(5);
    } else {
      bar.classList.remove('__pv-hidden');
      applyPosition(state.position);
    }
  }
  // Hovering the sliver nudges it up a few px; clicking it restores the bar.
  bar.addEventListener('mouseenter', function () { if (state.hidden) dockHidden(12); });
  bar.addEventListener('mouseleave', function () { if (state.hidden) dockHidden(5); });
  bar.addEventListener('click', function (e) {
    if (!state.hidden) return;
    e.preventDefault(); e.stopPropagation();
    setHidden(false);
  }, true);
  // Corner anchoring uses absolute pixels, so re-apply on resize (no animation).
  window.addEventListener('resize', function () {
    bar.style.transition = 'none';
    if (state.hidden) dockHidden(5); else applyPosition(state.position);
    void bar.offsetWidth;
    bar.style.transition = '';
  });

  // -- config popover --
  var pop = null, popOpen = false;
  function ensurePopover() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.id = '__pv-pop';
    var opts = POS_LABELS.map(function (o) {
      return '<option value="' + o[0] + '">' + o[1] + '</option>';
    }).join('');
    pop.innerHTML =
      '<button class="__pv-item" data-act="hide">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>' +
      '<span>Hide</span></button>' +
      '<button class="__pv-item" data-act="close">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
      '<span>Close</span></button>' +
      '<div class="__pv-div"></div>' +
      '<span class="__pv-poslabel">Position</span>' +
      '<select>' + opts + '</select>';
    document.body.appendChild(pop);
    var sel = pop.querySelector('select');
    sel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    sel.addEventListener('change', function () {
      state.position = sel.value; save(); applyPosition(state.position); closePopover();
    });
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('.__pv-item');
      if (!b) return;
      if (b.getAttribute('data-act') === 'hide') setHidden(true);
      else if (b.getAttribute('data-act') === 'close') destroy();
    });
    return pop;
  }
  function openPopover() {
    ensurePopover();
    pop.querySelector('select').value = state.position;
    pop.style.display = 'block';
    pop.style.visibility = 'hidden'; // measure before placing
    var r = cogBtn.getBoundingClientRect();
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.right - pw));
    var top = (r.top - ph - 8 >= 8) ? (r.top - ph - 8) : (r.bottom + 8);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = 'visible';
    popOpen = true;
    cogBtn.classList.add('__pv-on');
  }
  function closePopover() {
    if (pop) pop.style.display = 'none';
    popOpen = false;
    cogBtn.classList.remove('__pv-on');
  }
  function destroy() {
    closePopover();
    [pop, bar, styleEl].forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  cogBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (popOpen) closePopover(); else openPopover();
  });
  document.addEventListener('mousedown', function (e) {
    if (popOpen && pop && !pop.contains(e.target) && !cogBtn.contains(e.target)) closePopover();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && popOpen) closePopover();
  });

  // Apply persisted state without animating from the CSS default on first paint.
  function restoreUI() {
    bar.style.transition = 'none';
    if (state.hidden) { bar.classList.add('__pv-hidden'); dockHidden(5); }
    else applyPosition(state.position);
    void bar.offsetWidth; // force reflow so the next change animates
    bar.style.transition = '';
  }

  // -- bridge: page -> extension (fetch POST) -------------------------------
  function send(msg) {
    if (!BRIDGE) return;
    try {
      // text/plain keeps this a CORS "simple request" — no preflight.
      fetch(BRIDGE + '/msg', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify(Object.assign({ origin: location.origin }, msg)),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  // -- inspector -> toolbar (same-window messages) --------------------------
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'pv-open-source':
        send({ type: 'open-source', source: msg.source, debug: msg.debug });
        break;
      case 'pv-ai-prompt':
        send({ type: 'ai-prompt', payload: msg.payload, debug: msg.debug });
        break;
      case 'pv-css-prompt':
        send({ type: 'css-prompt', payload: msg.payload, debug: msg.debug });
        break;
      case 'pv-exit-inspect':
        // a tool's action completed, or Esc pressed in the page — deselect.
        if (mode) applyMode(mode);
        break;
      // pv-set-inspect / pv-ai-copied / pv-css-copied are ours or the
      // extension's; the inspector handles them, we ignore them here.
    }
  });

  // -- bridge: extension -> page (SSE) --------------------------------------
  // Copy acks (pv-ai-copied / pv-css-copied) are re-posted to `window` so the
  // inspector's own listener shows "Copied!" and fades its panel.
  function connect() {
    if (!BRIDGE || typeof EventSource === 'undefined') return;
    var es = new EventSource(BRIDGE + '/events');
    es.onopen = function () { dotEl.classList.add('__pv-live'); dotEl.title = 'Connected to FrontPeek'; };
    es.onerror = function () { dotEl.classList.remove('__pv-live'); dotEl.title = 'Reconnecting to FrontPeek…'; };
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg && msg.type) window.postMessage(msg, '*');
    };
  }
  connect();

  // -- drag -----------------------------------------------------------------
  (function makeDraggable() {
    var grip = bar.querySelector('.__pv-grip');
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    grip.addEventListener('mousedown', function (e) {
      dragging = true;
      var r = bar.getBoundingClientRect();
      // free drag: drop the transition so the bar tracks the cursor without lag,
      // and pin the transform to the bar's current visual position.
      bar.style.transition = 'none';
      moveTo(r.left, r.top);
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var nx = Math.max(0, Math.min(window.innerWidth - bar.offsetWidth, ox + e.clientX - sx));
      var ny = Math.max(0, Math.min(window.innerHeight - bar.offsetHeight, oy + e.clientY - sy));
      moveTo(nx, ny);
    }, true);
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      bar.style.transition = ''; // re-enable animation for later position changes
    }, true);
  })();

  mount();
})();
