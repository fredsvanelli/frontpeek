// FrontPeek — element inspector.
//
// Ported from the extension's media/inspector.js, essentially verbatim. Modes:
// 'edit' (click reports the source so the toolbar can open it or copy the
// path), 'ai' (click opens a prompt panel; Enter builds a structured prompt)
// and 'css' (click opens a tabbed live style editor whose deltas become the
// prompt). It communicates with the toolbar over `window.postMessage`; when the
// page is unframed `window.parent === window`, so those messages are delivered
// in-page.
//
// Wrapped as installInspector() returning { destroy }. Teardown removes every
// listener and restores the patched History methods so the component can be
// unmounted cleanly (React StrictMode mounts effects twice in dev).

export function installInspector() {
  if (window.__PV_INSTALLED__) return { destroy: function () {} };
  window.__PV_INSTALLED__ = true;

  var teardownListeners = [];
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    teardownListeners.push([target, type, fn, opts]);
  }

  let mode = null; // null | 'edit' | 'ai' | 'css'
  let hovered = null;
  let selected = null;
  let panel = null;
  let ta = null;
  let copyBtn = null;
  let copyLbl = null;
  let pending = null;

  const pageErrors = [];
  function pushError(msg) {
    pageErrors.push(String(msg).slice(0, 300));
    if (pageErrors.length > 5) pageErrors.shift();
  }
  on(window, 'error', (e) => {
    pushError((e.message || e.error) + (e.filename ? ' @ ' + e.filename + ':' + e.lineno : ''));
  });
  on(window, 'unhandledrejection', (e) => {
    const r = e.reason;
    pushError('unhandledrejection: ' + ((r && (r.stack || r.message)) || r));
  });

  function fiberKeyOf(node) {
    const keys = Object.getOwnPropertyNames(node);
    for (const k of keys) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0)
        return k;
    }
    return null;
  }

  function reactDetected() {
    const els = document.querySelectorAll('body, body *');
    const limit = Math.min(els.length, 400);
    for (let i = 0; i < limit; i++) {
      if (fiberKeyOf(els[i])) return true;
    }
    return false;
  }

  const style = document.createElement('style');
  style.textContent =
    '[data-pv-hover]{outline:2px solid #2f81f7 !important;outline-offset:-2px !important;cursor:crosshair !important;}' +
    '[data-pv-selected]{outline:2px solid #8b5cf6 !important;outline-offset:-2px !important;}' +
    'body[data-pv-inspecting] *{cursor:crosshair !important;}' +
    '#__pv-panel{position:fixed;z-index:2147483647;width:490px;max-width:calc(100vw - 16px);' +
    'background:rgba(24,24,27,.96);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
    'border:1px solid rgba(255,255,255,.12);border-radius:12px;' +
    'box-shadow:0 16px 48px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.3);padding:12px;display:none;' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e4e4e7;box-sizing:border-box;cursor:default;" +
    'opacity:1;transition:opacity .25s ease;}' +
    '#__pv-panel.__pv-fading{opacity:0;}' +
    '#__pv-panel *{box-sizing:border-box;cursor:auto;}' +
    '#__pv-panel textarea{display:block;width:100%;background:transparent;border:none;outline:none;resize:none;' +
    'color:#f4f4f5;font-family:inherit;font-size:13px;line-height:20px;padding:0;margin:0;min-height:20px;}' +
    '#__pv-panel textarea::placeholder{color:#71717a;}' +
    '#__pv-panel textarea:disabled{color:#a1a1aa;}' +
    '#__pv-panel .__pv-footer,#__pv-css-panel .__pv-footer{display:flex;align-items:center;justify-content:space-between;margin-top:10px;gap:8px;}' +
    '#__pv-panel .__pv-hint,#__pv-css-panel .__pv-hint{font-size:11px;color:#71717a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#__pv-panel .__pv-copy,#__pv-css-panel .__pv-copy{display:flex;align-items:center;gap:5px;' +
    'background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border:none;' +
    'border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer !important;font-family:inherit;flex-shrink:0;}' +
    '#__pv-panel .__pv-copy:hover:not(:disabled),#__pv-css-panel .__pv-copy:hover:not(:disabled){filter:brightness(1.15);}' +
    '#__pv-panel .__pv-copy:disabled,#__pv-css-panel .__pv-copy:disabled{background:#3f3f46;color:#a1a1aa;cursor:default !important;filter:none;}' +
    '#__pv-css-panel{position:fixed;z-index:2147483647;width:420px;max-width:calc(100vw - 16px);' +
    'background:rgba(24,24,27,.97);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
    'border:1px solid rgba(255,255,255,.12);border-radius:12px;' +
    'box-shadow:0 16px 48px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.3);padding:0 0 12px;display:none;' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e4e4e7;box-sizing:border-box;cursor:default;" +
    'color-scheme:dark;opacity:1;transition:opacity .25s ease;}' +
    '#__pv-css-panel.__pv-fading{opacity:0;}' +
    '#__pv-css-panel *{box-sizing:border-box;cursor:auto;}' +
    '#__pv-css-panel .__pv-css-head{display:flex;align-items:center;gap:8px;padding:10px 14px 0;' +
    'font-size:11px;color:#a1a1aa;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none;}' +
    '#__pv-css-panel .__pv-css-head,#__pv-css-panel .__pv-css-head *{cursor:move !important;}' +
    '#__pv-css-panel .__pv-css-head>span:first-child{flex:1;min-width:0;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#__pv-css-panel .__pv-css-grip{flex-shrink:0;color:#52525b;font-size:12px;letter-spacing:1px;}' +
    '#__pv-css-panel .__pv-css-text{padding:10px 14px 0;}' +
    '#__pv-css-panel .__pv-css-text>span{display:block;font-size:9px;color:#71717a;' +
    'text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px;}' +
    '#__pv-css-panel .__pv-css-text.__pv-changed>span{color:#c4b5fd;font-weight:700;}' +
    '#__pv-css-panel textarea{width:100%;min-height:26px;max-height:120px;resize:vertical;display:block;' +
    'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;' +
    'color:#f4f4f5;font-family:inherit;font-size:11px;line-height:1.4;padding:5px 7px;outline:none;}' +
    '#__pv-css-panel textarea:focus{border-color:#7c3aed;}' +
    '#__pv-css-panel .__pv-css-tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid rgba(255,255,255,.08);}' +
    '#__pv-css-panel .__pv-css-tab{background:transparent;border:none;border-bottom:2px solid transparent;' +
    'color:#a1a1aa;font-family:inherit;font-size:11px;font-weight:600;padding:7px 9px;cursor:pointer !important;}' +
    '#__pv-css-panel .__pv-css-tab:hover{color:#e4e4e7;}' +
    '#__pv-css-panel .__pv-css-tab.active{color:#fff;border-bottom-color:#7c3aed;}' +
    '#__pv-css-panel .__pv-css-body{max-height:300px;overflow-y:auto;padding:10px 14px 0;}' +
    '#__pv-css-panel .__pv-css-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}' +
    '#__pv-css-panel .__pv-css-row>label{width:112px;flex-shrink:0;font-size:11px;color:#a1a1aa;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#__pv-css-panel .__pv-css-row.__pv-changed>label{color:#c4b5fd;font-weight:600;}' +
    '#__pv-css-panel input[type=text],#__pv-css-panel select{flex:1;min-width:0;height:24px;' +
    'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;' +
    'color:#f4f4f5;font-family:inherit;font-size:11px;padding:0 7px;outline:none;}' +
    '#__pv-css-panel input[type=text]:focus,#__pv-css-panel select:focus{border-color:#7c3aed;}' +
    '#__pv-css-panel select{cursor:pointer !important;}' +
    '#__pv-css-panel input[type=color]{width:24px;height:24px;flex-shrink:0;padding:1px;' +
    'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;cursor:pointer !important;}' +
    '#__pv-css-panel .__pv-css-quad{display:flex;gap:4px;flex:1;min-width:0;}' +
    '#__pv-css-panel .__pv-css-cell{flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch;}' +
    '#__pv-css-panel .__pv-css-cell>span{font-size:9px;color:#71717a;text-align:center;line-height:11px;}' +
    '#__pv-css-panel .__pv-css-cell.__pv-changed>span{color:#c4b5fd;font-weight:700;}' +
    '#__pv-css-panel .__pv-css-cell>input{width:100%;text-align:center;padding:0 3px;}' +
    '#__pv-css-panel .__pv-footer{padding:0 14px;margin-top:10px;}' +
    '#__pv-css-panel .__pv-reset{background:rgba(255,255,255,.08);color:#d4d4d8;border:none;' +
    'border-radius:7px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer !important;font-family:inherit;flex-shrink:0;}' +
    '#__pv-css-panel .__pv-reset:hover{background:rgba(255,255,255,.15);}' +
    '#__pv-hier{position:fixed;z-index:2147483647;min-width:300px;max-width:430px;' +
    'background:rgba(24,24,27,.97);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
    'border:1px solid rgba(255,255,255,.12);border-radius:12px;' +
    'box-shadow:0 16px 48px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.3);padding:6px;display:none;' +
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e4e4e7;box-sizing:border-box;cursor:default;}" +
    '#__pv-hier *{box-sizing:border-box;}' +
    '#__pv-hier .__pv-hier-title{padding:4px 8px 6px;font-size:10px;color:#71717a;' +
    'text-transform:uppercase;letter-spacing:.07em;user-select:none;}' +
    '#__pv-hier .__pv-hier-list{max-height:264px;overflow-y:auto;overflow-x:hidden;}' +
    '#__pv-hier .__pv-hier-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;' +
    'background:transparent;border:none;' +
    'border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;' +
    'line-height:1;padding:6px 8px;cursor:pointer !important;}' +
    '#__pv-hier .__pv-hier-row:hover{background:rgba(124,58,237,.28);}' +
    '#__pv-hier .__pv-hier-file{width:96px;flex-shrink:0;color:#71717a;font-size:10px;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#__pv-hier .__pv-hier-tag{flex:1;min-width:0;color:#7dd3fc;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#__pv-hier .__pv-hier-comp .__pv-hier-tag{color:#c4b5fd;}' +
    '#__pv-hier .__pv-hier-more .__pv-hier-tag{color:#a1a1aa;font-weight:600;}' +
    '#__pv-hier .__pv-hier-row:hover .__pv-hier-tag{color:#fff;}' +
    '#__pv-hier .__pv-hier-hint{padding:6px 8px 2px;font-size:11px;color:#71717a;user-select:none;}';
  document.documentElement.appendChild(style);

  function clearHover() {
    if (hovered) {
      hovered.removeAttribute('data-pv-hover');
      hovered = null;
    }
  }

  function setMode(m) {
    if (mode === m) return;
    mode = m;
    closeHierPicker();
    closePanel();
    closeCssPanel();
    if (mode) {
      document.body.setAttribute('data-pv-inspecting', '');
    } else {
      document.body.removeAttribute('data-pv-inspecting');
      clearHover();
    }
  }

  function anyPanelOpen() {
    return (
      (panel && panel.style.display !== 'none') ||
      (cssPanel && cssPanel.style.display !== 'none') ||
      (hierPanel && hierPanel.style.display !== 'none')
    );
  }

  function isOwnUi(el) {
    return !!(
      el &&
      el.closest &&
      el.closest('#__pv-toolbar, #__pv-pop, #__pv-toast, #__pv-panel, #__pv-css-panel, #__pv-hier')
    );
  }

  on(window, 'message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'pv-set-inspect') {
      setMode(msg.enabled ? msg.mode || 'edit' : null);
    } else if (msg.type === 'pv-ai-copied') {
      if (copyBtn) {
        copyBtn.disabled = true;
        copyLbl.textContent = 'Copied!';
      }
      copiedTimer = setTimeout(fadePanelOut, 500);
    } else if (msg.type === 'pv-css-copied') {
      if (cssCopyBtn) {
        cssCopyBtn.disabled = true;
        cssCopyLbl.textContent = 'Copied!';
      }
      cssCopiedTimer = setTimeout(fadeCssPanelOut, 500);
    } else if (msg.type === 'pv-history-back') {
      history.back();
    } else if (msg.type === 'pv-history-forward') {
      history.forward();
    } else if (msg.type === 'pv-sources-resolved') {
      if (msg.token !== hierToken) return; // picker closed/reopened meanwhile
      if (!hierPanel || hierPanel.style.display === 'none') return;
      const indices = msg.indices || [];
      const locs = msg.locs || [];
      for (let i = 0; i < indices.length; i++) {
        const lv = hierLevels[indices[i]];
        if (!lv) continue;
        const loc = locs[i];
        lv.filePath = (loc && loc.file) || null;
        lv.file = lv.filePath ? lv.filePath.split(/[/\\]/).pop() : null;
      }
      renderHierRows();
    }
  });

  on(document, 'mousemove', (e) => {
    if (!mode) return;
    if (anyPanelOpen()) return;
    const target = e.target;
    if (target === hovered || !(target instanceof Element)) return;
    if (isOwnUi(target)) { clearHover(); return; }
    clearHover();
    hovered = target;
    hovered.setAttribute('data-pv-hover', '');
  }, true);

  on(document, 'mousedown', (e) => {
    if (panel && panel.style.display !== 'none' && !panel.contains(e.target)) closePanel();
    if (cssPanel && cssPanel.style.display !== 'none' && !cssPanel.contains(e.target))
      closeCssPanel();
    if (hierPanel && hierPanel.style.display !== 'none' && !hierPanel.contains(e.target))
      closeHierPicker();
  }, true);

  on(document, 'click', (e) => {
    if (!mode) return;
    if (isOwnUi(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const debug = { target: describeEl(e.target), walk: [] };
    let levels = [];
    try {
      levels = buildHierarchy(e.target, debug);
    } catch (err) {
      debug.error = String((err && err.stack) || err);
    }

    if (levels.length > 1) {
      openHierPicker(e.target, levels, debug);
    } else {
      // No React hierarchy to choose from — resolve the click directly.
      dispatchLevel(levels[0] || null, e.target, debug);
    }
  }, true);

  // Resolves the chosen hierarchy level and continues the active tool's flow.
  function dispatchLevel(level, clickedEl, debug) {
    if (level) debug.pickedLevel = level.label;
    let source = null;
    try {
      source = level ? sourceFromFiber(level.fiber, debug) : findSource(clickedEl, debug);
    } catch (err) {
      debug.error = String((err && err.stack) || err);
    }
    if (!source) {
      debug.reactDetected = reactDetected();
      debug.nextData = !!window.__next_f;
      debug.pageErrors = pageErrors.slice();
    }

    const target = (level && domForFiber(level.fiber)) || clickedEl;
    if (mode === 'edit') {
      window.parent.postMessage({ type: 'pv-open-source', source: source, debug: debug }, '*');
      window.parent.postMessage({ type: 'pv-exit-inspect' }, '*');
    } else if (mode === 'css') {
      openCssPanel(target, source);
    } else {
      openPanel(target, source);
    }
  }

  on(document, 'keydown', (e) => {
    if (e.key !== 'Escape' || !mode) return;
    if (hierPanel && hierPanel.style.display !== 'none') {
      closeHierPicker();
      return;
    }
    if (panel && panel.style.display !== 'none') {
      closePanel();
      return;
    }
    if (cssPanel && cssPanel.style.display !== 'none') {
      closeCssPanel();
      return;
    }
    setMode(null);
    window.parent.postMessage({ type: 'pv-exit-inspect' }, '*');
  }, true);

  // -------------------------------------------------------------------------
  // Hierarchy picker — clicking an element may match several intents along the
  // component tree (<Routes> > <Page> > <List> > <p>), so every tool first
  // shows the deepest 4 levels and lets the user pick which one to resolve.
  // "[…]" reveals 2 more ancestors per click until the chain is exhausted.
  // -------------------------------------------------------------------------

  const HIER_INITIAL = 4;
  const HIER_STEP = 2;

  let hierPanel = null;
  let hierListEl = null;
  let hierLevels = [];
  let hierClickedEl = null;
  let hierDebug = null;
  let hierVisible = 0;
  let hierHoverEl = null;
  let hierToken = 0; // ties async file resolutions to the current picker instance

  function clearHierHover() {
    if (hierHoverEl) {
      hierHoverEl.removeAttribute('data-pv-hover');
      hierHoverEl = null;
    }
  }

  function ensureHierPanel() {
    if (hierPanel) return;
    hierPanel = document.createElement('div');
    hierPanel.id = '__pv-hier';

    const title = document.createElement('div');
    title.className = '__pv-hier-title';
    title.textContent = 'Select component';
    hierPanel.appendChild(title);

    hierListEl = document.createElement('div');
    hierListEl.className = '__pv-hier-list';
    hierPanel.appendChild(hierListEl);

    const hint = document.createElement('div');
    hint.className = '__pv-hier-hint';
    hint.textContent = '[Esc] to cancel';
    hierPanel.appendChild(hint);

    document.documentElement.appendChild(hierPanel);
  }

  function openHierPicker(clickedEl, levels, debug) {
    ensureHierPanel();
    closeHierPicker();
    closePanel();
    closeCssPanel();
    clearHover();

    hierLevels = levels;
    hierClickedEl = clickedEl;
    hierDebug = debug;
    hierVisible = Math.min(HIER_INITIAL, levels.length);
    hierToken++;
    renderHierRows();

    hierPanel.style.display = 'block';
    positionHierPanel(clickedEl.getBoundingClientRect());
    requestHierResolve();
  }

  // Asks the host (mount.js) to resolve the source file of each visible level
  // that hasn't been requested yet. Files arrive via 'pv-sources-resolved'.
  function requestHierResolve() {
    const indices = [];
    const sources = [];
    const max = Math.min(hierVisible, hierLevels.length);
    for (let i = 0; i < max; i++) {
      const lv = hierLevels[i];
      if (lv.requested) continue;
      lv.requested = true;
      let src = null;
      try {
        src = sourceFromFiber(lv.fiber, { walk: [] });
      } catch (_) {}
      indices.push(i);
      sources.push(src);
    }
    if (!indices.length) return;
    window.parent.postMessage(
      { type: 'pv-resolve-sources', token: hierToken, indices: indices, sources: sources },
      '*'
    );
  }

  function positionHierPanel(anchorRect) {
    const pw = hierPanel.offsetWidth;
    const ph = hierPanel.offsetHeight;
    const left = Math.min(Math.max(8, anchorRect.left), window.innerWidth - pw - 8);
    let top = anchorRect.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, anchorRect.top - ph - 8);
    hierPanel.style.left = left + 'px';
    hierPanel.style.top = top + 'px';
  }

  function renderHierRows() {
    clearHierHover();
    hierListEl.textContent = '';
    const hasMore = hierVisible < hierLevels.length;

    function makeRow(className, fileName, filePath, indent, tagText) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = className;
      const fileCell = document.createElement('span');
      fileCell.className = '__pv-hier-file';
      fileCell.textContent = fileName || '';
      if (filePath) fileCell.title = filePath;
      const tagCell = document.createElement('span');
      tagCell.className = '__pv-hier-tag';
      tagCell.style.paddingLeft = indent * 14 + 'px';
      tagCell.textContent = tagText;
      row.appendChild(fileCell);
      row.appendChild(tagCell);
      return row;
    }

    if (hasMore) {
      const more = makeRow('__pv-hier-row __pv-hier-more', null, null, 0, '[…]');
      more.title = 'Show ' + HIER_STEP + ' more ancestors';
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        hierVisible = Math.min(hierVisible + HIER_STEP, hierLevels.length);
        const prevTop = hierPanel.getBoundingClientRect().top;
        renderHierRows();
        // Re-clamp: the panel grows downward and may run past the viewport.
        const top = Math.max(8, Math.min(prevTop, window.innerHeight - hierPanel.offsetHeight - 8));
        hierPanel.style.top = top + 'px';
        requestHierResolve();
      });
      hierListEl.appendChild(more);
    }

    // hierLevels is deepest-first; render shallowest-first, indented per depth.
    const visible = hierLevels.slice(0, hierVisible).reverse();
    visible.forEach((level, i) => {
      const indent = Math.min(i + (hasMore ? 1 : 0), 12);
      const row = makeRow(
        '__pv-hier-row' + (/^[a-z]/.test(level.label) ? '' : ' __pv-hier-comp'),
        level.file,
        level.filePath,
        indent,
        '<' + level.label + '>'
      );
      row.addEventListener('mouseenter', () => {
        clearHierHover();
        const dom = domForFiber(level.fiber);
        if (dom) {
          hierHoverEl = dom;
          hierHoverEl.setAttribute('data-pv-hover', '');
        }
      });
      row.addEventListener('mouseleave', clearHierHover);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const clickedEl = hierClickedEl;
        const debug = hierDebug;
        closeHierPicker();
        dispatchLevel(level, clickedEl, debug);
      });
      hierListEl.appendChild(row);
    });
  }

  function closeHierPicker() {
    clearHierHover();
    if (hierPanel) hierPanel.style.display = 'none';
    hierLevels = [];
    hierClickedEl = null;
    hierDebug = null;
    hierVisible = 0;
  }

  // -------------------------------------------------------------------------
  // AI-mode floating panel
  // -------------------------------------------------------------------------

  const TA_MAX = 100;

  function ensurePanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = '__pv-panel';
    panel.innerHTML =
      '<textarea rows="1" placeholder="Describe the change for this element…"></textarea>' +
      '<div class="__pv-footer">' +
      '<span class="__pv-hint">[Enter] to copy · [Shift+Enter] to add new line · [Esc] to close</span>' +
      '<button type="button" class="__pv-copy">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="9 10 4 15 9 20"></polyline><path d="M20 4v7a4 4 0 0 1-4 4H4"></path>' +
      '</svg>' +
      '<span>Copy</span>' +
      '</button>' +
      '</div>';
    document.documentElement.appendChild(panel);

    ta = panel.querySelector('textarea');
    copyBtn = panel.querySelector('.__pv-copy');
    copyLbl = copyBtn.querySelector('span');

    ta.addEventListener('input', () => {
      autoresize();
      resetCopy();
    });

    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        closePanel();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });

    copyBtn.addEventListener('click', send);
  }

  function autoresize() {
    ta.style.height = 'auto';
    const h = Math.min(ta.scrollHeight, TA_MAX);
    ta.style.height = h + 'px';
    ta.style.overflowY = ta.scrollHeight > TA_MAX ? 'auto' : 'hidden';
  }

  function resetCopy() {
    if (!copyBtn) return;
    copyBtn.disabled = false;
    copyLbl.textContent = 'Copy';
  }

  function openPanel(target, source) {
    ensurePanel();
    closePanel();
    clearHover();

    selected = target;
    if (selected instanceof Element) selected.setAttribute('data-pv-selected', '');
    pending = {
      source: source,
      element: describeForPrompt(target),
      url: location.href,
    };

    ta.value = '';
    ta.disabled = false;
    resetCopy();
    autoresize();

    panel.style.display = 'block';
    const r = target.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - pw - 8);
    let top = r.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';

    ta.focus();
  }

  function closePanel() {
    clearPanelTimers();
    if (panel) {
      panel.style.display = 'none';
      panel.classList.remove('__pv-fading');
    }
    if (selected) {
      selected.removeAttribute('data-pv-selected');
      selected = null;
    }
    pending = null;
  }

  function send() {
    if (!pending || !ta) return;
    const text = ta.value.trim();
    if (!text) return;
    window.parent.postMessage(
      {
        type: 'pv-ai-prompt',
        payload: {
          text: text,
          source: pending.source,
          element: pending.element,
          url: pending.url,
        },
      },
      '*'
    );
    ta.disabled = true;
    copyBtn.disabled = true;
    copyLbl.textContent = 'Copying…';
  }

  let copiedTimer = null;
  let fadeTimer = null;

  function clearPanelTimers() {
    clearTimeout(copiedTimer);
    clearTimeout(fadeTimer);
    copiedTimer = fadeTimer = null;
  }

  function fadePanelOut() {
    if (!panel || panel.style.display === 'none') return;
    panel.classList.add('__pv-fading');
    fadeTimer = setTimeout(() => {
      closePanel();
      window.parent.postMessage({ type: 'pv-exit-inspect' }, '*');
    }, 250);
  }

  // -------------------------------------------------------------------------
  // CSS-mode editor panel
  // -------------------------------------------------------------------------

  const CSS_SELECTS = {
    display: ['block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid', 'inline-grid', 'none'],
    position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
    'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'],
    'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
    'justify-content': ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
    'align-items': ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'],
    overflow: ['visible', 'hidden', 'scroll', 'auto'],
    'box-sizing': ['content-box', 'border-box'],
    'text-align': ['left', 'center', 'right', 'justify'],
    'font-weight': ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
    'text-transform': ['none', 'uppercase', 'lowercase', 'capitalize'],
    'font-style': ['normal', 'italic'],
    'text-decoration-line': ['none', 'underline', 'overline', 'line-through'],
    'border-style': ['none', 'solid', 'dashed', 'dotted', 'double'],
  };

  const CSS_TABS = [
    {
      label: 'Layout',
      rows: [
        { p: 'display', t: 'select' },
        { p: 'position', t: 'select' },
        { quad: 'inset', props: ['top', 'right', 'bottom', 'left'] },
        { p: 'z-index', t: 'text' },
        { p: 'flex-direction', t: 'select' },
        { p: 'justify-content', t: 'select' },
        { p: 'align-items', t: 'select' },
        { p: 'flex-wrap', t: 'select' },
        { p: 'gap', t: 'text' },
        { p: 'overflow', t: 'select' },
      ],
    },
    {
      label: 'Size',
      rows: [
        { p: 'width', t: 'text' },
        { p: 'height', t: 'text' },
        { p: 'min-width', t: 'text' },
        { p: 'max-width', t: 'text' },
        { p: 'min-height', t: 'text' },
        { p: 'max-height', t: 'text' },
        { quad: 'margin', props: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'] },
        { quad: 'padding', props: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'] },
        { p: 'box-sizing', t: 'select' },
      ],
    },
    {
      label: 'Text',
      rows: [
        { p: 'font-size', t: 'text' },
        { p: 'font-weight', t: 'select' },
        { p: 'line-height', t: 'text' },
        { p: 'letter-spacing', t: 'text' },
        { p: 'text-align', t: 'select' },
        { p: 'text-transform', t: 'select' },
        { p: 'font-style', t: 'select' },
        { p: 'text-decoration-line', t: 'select' },
        { p: 'font-family', t: 'text' },
      ],
    },
    {
      label: 'Colors',
      rows: [
        { p: 'color', t: 'color' },
        { p: 'background-color', t: 'color' },
        { p: 'opacity', t: 'text' },
      ],
    },
    {
      label: 'Border',
      rows: [
        { p: 'border-width', t: 'text' },
        { p: 'border-style', t: 'select' },
        { p: 'border-color', t: 'color' },
        { p: 'border-radius', t: 'text' },
        { p: 'box-shadow', t: 'text' },
      ],
    },
  ];

  let cssPanel = null;
  let cssHeadEl = null;
  let cssHeadNameEl = null;
  let cssHintEl = null;
  let cssCopyBtn = null;
  let cssCopyLbl = null;
  let cssTarget = null;
  let cssPending = null;
  let cssOrigInline = null;
  let cssOriginal = {};
  let cssChanges = {};
  const cssRows = {};
  let cssTextSection = null;
  let cssTextInput = null;
  let cssOrigText = null; // original textContent; null when the target isn't a text-editable leaf
  let cssTextChanged = false;
  let cssCopiedTimer = null;
  let cssFadeTimer = null;

  // Tags whose visible content isn't a plain editable text node.
  const TEXT_UNEDITABLE = {
    IMG: 1, INPUT: 1, TEXTAREA: 1, SELECT: 1, BR: 1, HR: 1, SVG: 1, CANVAS: 1,
    VIDEO: 1, AUDIO: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, SOURCE: 1, PICTURE: 1,
  };

  // A "final" (leaf) element: no element children and safe to edit as text.
  function isTextEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (TEXT_UNEDITABLE[el.tagName]) return false;
    return el.children.length === 0;
  }

  function makeDraggable(panelEl, handleEl) {
    let dragging = false;
    let dx = 0;
    let dy = 0;
    handleEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      const r = panelEl.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    });
    on(document, 'mousemove', (e) => {
      if (!dragging) return;
      const left = Math.min(Math.max(8 - panelEl.offsetWidth + 60, e.clientX - dx), window.innerWidth - 60);
      const top = Math.min(Math.max(0, e.clientY - dy), window.innerHeight - 32);
      panelEl.style.left = left + 'px';
      panelEl.style.top = top + 'px';
    }, true);
    on(document, 'mouseup', () => (dragging = false), true);
  }

  let hexCtx = null; // lazy 2D canvas context, used to resolve any CSS color
  function cssToHex(v) {
    if (!v) return null;
    v = v.trim();
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return v.slice(0, 7);
    if (/^#[0-9a-f]{3}$/i.test(v))
      return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    const h = (n) => ('0' + Math.min(255, +n).toString(16)).slice(-2);
    const m = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) return '#' + h(m[1]) + h(m[2]) + h(m[3]);
    // Fallback: let the browser resolve named colors, hsl(), hwb(), lab(),
    // lch(), oklab(), oklch(), color(), … by rendering a pixel and reading it
    // back, so the swatch always reflects the value in its input. Reading a
    // pixel handles modern color spaces whose fillStyle serialization is not
    // hex/rgb() (e.g. lab() stays lab(), which the regexes above never match).
    try {
      if (!hexCtx)
        hexCtx = document
          .createElement('canvas')
          .getContext('2d', { willReadFrequently: true });
      // Validity check: an invalid value leaves fillStyle at the sentinel, so
      // two different sentinels disagree. A valid value overrides both.
      hexCtx.fillStyle = '#000';
      hexCtx.fillStyle = v;
      const a = hexCtx.fillStyle;
      hexCtx.fillStyle = '#fff';
      hexCtx.fillStyle = v;
      if (a !== hexCtx.fillStyle) return null; // invalid: sentinels retained
      hexCtx.clearRect(0, 0, 1, 1);
      hexCtx.fillRect(0, 0, 1, 1);
      const d = hexCtx.getImageData(0, 0, 1, 1).data;
      return '#' + h(d[0]) + h(d[1]) + h(d[2]);
    } catch (_) {}
    return null;
  }

  function ensureOption(sel, val) {
    if (!val) return;
    for (let i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === val) return;
    }
    const o = document.createElement('option');
    o.value = val;
    o.textContent = val;
    sel.appendChild(o);
  }

  function buildCssInput(prop, type, cell) {
    let input;
    if (type === 'select') {
      input = document.createElement('select');
      for (const v of CSS_SELECTS[prop]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
    }
    let swatch = null;
    if (type === 'color') {
      swatch = document.createElement('input');
      swatch.type = 'color';
      swatch.addEventListener('input', () => {
        input.value = swatch.value;
        applyCss(prop, swatch.value);
      });
    }
    input.addEventListener('input', () => {
      applyCss(prop, input.value);
      if (swatch) {
        const hex = cssToHex(input.value);
        if (hex) swatch.value = hex;
      }
    });
    cssRows[prop] = { row: cell, input: input, swatch: swatch };
    return { input: input, swatch: swatch };
  }

  function ensureCssPanel() {
    if (cssPanel) return;
    cssPanel = document.createElement('div');
    cssPanel.id = '__pv-css-panel';

    cssHeadEl = document.createElement('div');
    cssHeadEl.className = '__pv-css-head';
    cssHeadEl.title = 'Drag to move';
    cssHeadNameEl = document.createElement('span');
    cssHeadEl.appendChild(cssHeadNameEl);
    const grip = document.createElement('span');
    grip.className = '__pv-css-grip';
    grip.textContent = '⠿';
    cssHeadEl.appendChild(grip);
    makeDraggable(cssPanel, cssHeadEl);
    cssPanel.appendChild(cssHeadEl);

    // Text-content editor — only shown for leaf ("final") elements.
    cssTextSection = document.createElement('div');
    cssTextSection.className = '__pv-css-text';
    cssTextSection.style.display = 'none';
    const textCap = document.createElement('span');
    textCap.textContent = 'Text content';
    cssTextSection.appendChild(textCap);
    cssTextInput = document.createElement('textarea');
    cssTextInput.rows = 1;
    cssTextInput.spellcheck = false;
    cssTextInput.addEventListener('input', () => applyCssText(cssTextInput.value));
    cssTextSection.appendChild(cssTextInput);
    cssPanel.appendChild(cssTextSection);

    const tabsEl = document.createElement('div');
    tabsEl.className = '__pv-css-tabs';
    cssPanel.appendChild(tabsEl);

    const bodyEl = document.createElement('div');
    bodyEl.className = '__pv-css-body';
    cssPanel.appendChild(bodyEl);

    const tabBtns = [];
    const pages = [];
    CSS_TABS.forEach((tab, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = '__pv-css-tab' + (i === 0 ? ' active' : '');
      btn.textContent = tab.label;
      btn.addEventListener('click', () => {
        tabBtns.forEach((b, j) => b.classList.toggle('active', j === i));
        pages.forEach((p, j) => (p.style.display = j === i ? '' : 'none'));
      });
      tabsEl.appendChild(btn);
      tabBtns.push(btn);

      const page = document.createElement('div');
      page.style.display = i === 0 ? '' : 'none';
      for (const def of tab.rows) {
        const row = document.createElement('div');
        row.className = '__pv-css-row';
        const label = document.createElement('label');
        label.textContent = def.quad || def.p;
        row.appendChild(label);

        if (def.quad) {
          const grid = document.createElement('div');
          grid.className = '__pv-css-quad';
          def.props.forEach((prop, k) => {
            const cell = document.createElement('div');
            cell.className = '__pv-css-cell';
            const cap = document.createElement('span');
            cap.textContent = ['T', 'R', 'B', 'L'][k];
            cell.appendChild(cap);
            cell.title = prop;
            cell.appendChild(buildCssInput(prop, 'text', cell).input);
            grid.appendChild(cell);
          });
          row.appendChild(grid);
        } else {
          const built = buildCssInput(def.p, def.t, row);
          if (built.swatch) row.appendChild(built.swatch);
          row.appendChild(built.input);
        }
        page.appendChild(row);
      }
      bodyEl.appendChild(page);
      pages.push(page);
    });

    const footer = document.createElement('div');
    footer.className = '__pv-footer';
    cssHintEl = document.createElement('span');
    cssHintEl.className = '__pv-hint';
    footer.appendChild(cssHintEl);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = '__pv-reset';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', resetCssEdits);
    actions.appendChild(resetBtn);

    cssCopyBtn = document.createElement('button');
    cssCopyBtn.type = 'button';
    cssCopyBtn.className = '__pv-copy';
    cssCopyBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="9 10 4 15 9 20"></polyline><path d="M20 4v7a4 4 0 0 1-4 4H4"></path>' +
      '</svg>' +
      '<span>Copy Prompt</span>';
    cssCopyLbl = cssCopyBtn.querySelector('span');
    cssCopyBtn.addEventListener('click', sendCssPrompt);
    actions.appendChild(cssCopyBtn);
    footer.appendChild(actions);
    cssPanel.appendChild(footer);

    cssPanel.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
    });

    document.documentElement.appendChild(cssPanel);
  }

  function openCssPanel(target, source) {
    if (!(target instanceof Element)) return;
    ensureCssPanel();
    closeCssPanel();
    closePanel();
    clearHover();

    cssTarget = target;
    cssTarget.setAttribute('data-pv-selected', '');
    cssOrigInline = target.getAttribute('style');
    cssPending = {
      source: source,
      element: describeForPrompt(target),
      url: location.href,
    };
    cssOriginal = {};
    cssChanges = {};

    cssHeadNameEl.textContent = describeEl(target);

    cssTextChanged = false;
    if (isTextEditable(target)) {
      cssOrigText = target.textContent || '';
      cssTextInput.value = cssOrigText;
      cssTextSection.classList.remove('__pv-changed');
      cssTextSection.style.display = '';
    } else {
      cssOrigText = null;
      cssTextSection.style.display = 'none';
    }

    const cs = getComputedStyle(target);
    for (const prop in cssRows) {
      const val = (cs.getPropertyValue(prop) || '').trim();
      cssOriginal[prop] = val;
      const r = cssRows[prop];
      if (r.input.tagName === 'SELECT') ensureOption(r.input, val);
      r.input.value = val;
      if (r.swatch) r.swatch.value = cssToHex(val) || '#000000';
      r.row.classList.remove('__pv-changed');
    }
    cssCopyLbl.textContent = 'Copy Prompt';
    updateCssFooter();

    cssPanel.style.display = 'block';
    const rect = target.getBoundingClientRect();
    const pw = cssPanel.offsetWidth;
    const ph = cssPanel.offsetHeight;
    let left = Math.min(Math.max(8, rect.left), window.innerWidth - pw - 8);
    let top = rect.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = rect.top - ph - 8;
    if (top < 8) {
      top = Math.min(Math.max(8, rect.top), window.innerHeight - ph - 8);
      if (rect.right + 8 + pw <= window.innerWidth - 8) left = rect.right + 8;
      else if (rect.left - pw - 8 >= 8) left = rect.left - pw - 8;
      else top = Math.max(8, window.innerHeight - ph - 8);
    }
    cssPanel.style.left = left + 'px';
    cssPanel.style.top = top + 'px';
  }

  function revertCssEdits() {
    if (!cssTarget) return;
    cssTarget.style.cssText = '';
    void cssTarget.getAttribute('style');
    if (cssOrigInline == null) cssTarget.removeAttribute('style');
    else cssTarget.setAttribute('style', cssOrigInline);
    if (cssTextChanged && cssOrigText != null) {
      cssTarget.textContent = cssOrigText;
      cssTextChanged = false;
    }
  }

  function closeCssPanel() {
    clearCssTimers();
    if (cssPanel) {
      cssPanel.style.display = 'none';
      cssPanel.classList.remove('__pv-fading');
    }
    if (cssTarget) {
      revertCssEdits();
      cssTarget.removeAttribute('data-pv-selected');
      cssTarget = null;
    }
    cssPending = null;
    cssChanges = {};
  }

  function resetCssEdits() {
    if (!cssTarget) return;
    revertCssEdits();
    cssChanges = {};
    if (cssOrigText != null) {
      cssTextInput.value = cssOrigText;
      cssTextSection.classList.remove('__pv-changed');
    }
    cssTextChanged = false;
    for (const prop in cssRows) {
      const r = cssRows[prop];
      if (r.input.tagName === 'SELECT') ensureOption(r.input, cssOriginal[prop]);
      r.input.value = cssOriginal[prop] || '';
      if (r.swatch) r.swatch.value = cssToHex(cssOriginal[prop]) || '#000000';
      r.row.classList.remove('__pv-changed');
    }
    cssCopyLbl.textContent = 'Copy Prompt';
    updateCssFooter();
  }

  function applyCss(prop, value) {
    if (!cssTarget) return;
    value = String(value).trim();
    const r = cssRows[prop];
    if (!value || value === cssOriginal[prop]) {
      cssTarget.style.removeProperty(prop);
      delete cssChanges[prop];
      r.row.classList.remove('__pv-changed');
    } else {
      cssTarget.style.setProperty(prop, value, 'important');
      cssChanges[prop] = value;
      r.row.classList.add('__pv-changed');
    }
    cssCopyLbl.textContent = 'Copy Prompt';
    updateCssFooter();
  }

  function applyCssText(value) {
    if (!cssTarget || cssOrigText == null) return;
    cssTarget.textContent = value;
    cssTextChanged = value !== cssOrigText;
    cssTextSection.classList.toggle('__pv-changed', cssTextChanged);
    cssCopyLbl.textContent = 'Copy Prompt';
    updateCssFooter();
  }

  function updateCssFooter() {
    const n = Object.keys(cssChanges).length + (cssTextChanged ? 1 : 0);
    cssHintEl.textContent = n
      ? n + (n === 1 ? ' change' : ' changes') + ' · [Esc] discards'
      : 'Edits preview live';
    cssCopyBtn.disabled = !n;
  }

  function sendCssPrompt() {
    if (!cssPending) return;
    const changes = [];
    for (const prop in cssChanges) {
      changes.push({ prop: prop, from: cssOriginal[prop] || 'unset', to: cssChanges[prop] });
    }
    const textChange = cssTextChanged
      ? { from: cssOrigText, to: cssTextInput.value }
      : null;
    if (!changes.length && !textChange) return;
    window.parent.postMessage(
      {
        type: 'pv-css-prompt',
        payload: {
          changes: changes,
          textChange: textChange,
          source: cssPending.source,
          element: cssPending.element,
          url: cssPending.url,
        },
      },
      '*'
    );
    cssCopyBtn.disabled = true;
    cssCopyLbl.textContent = 'Copying…';
  }

  function clearCssTimers() {
    clearTimeout(cssCopiedTimer);
    clearTimeout(cssFadeTimer);
    cssCopiedTimer = cssFadeTimer = null;
  }

  function fadeCssPanelOut() {
    if (!cssPanel || cssPanel.style.display === 'none') return;
    cssPanel.classList.add('__pv-fading');
    cssFadeTimer = setTimeout(() => {
      closeCssPanel();
      window.parent.postMessage({ type: 'pv-exit-inspect' }, '*');
    }, 250);
  }

  // -------------------------------------------------------------------------
  // Element description for the prompt
  // -------------------------------------------------------------------------

  const PROMPT_ATTRS = [
    'alt', 'href', 'aria-label', 'data-testid', 'placeholder', 'type', 'name', 'role', 'title',
  ];

  function describeForPrompt(el) {
    if (!(el instanceof Element)) return null;
    const attrs = {};
    for (const name of PROMPT_ATTRS) {
      const v = el.getAttribute(name);
      if (v) attrs[name] = v.slice(0, 120);
    }
    const src = el.getAttribute('src');
    if (src) attrs.src = src.split('?')[0].split('/').slice(-2).join('/');
    return {
      tag: el.tagName.toLowerCase(),
      selector: cssPath(el, 5),
      classes: (el.getAttribute('class') || '').trim().slice(0, 200) || null,
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) || null,
      attrs: attrs,
    };
  }

  function cssPath(el, depth) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < depth) {
      let part = n.tagName.toLowerCase();
      if (n.id) {
        parts.unshift(part + '#' + n.id);
        break;
      }
      const cls = (n.getAttribute('class') || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      const parent = n.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(
          parent.children,
          (c) => c.tagName === n.tagName
        );
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(part);
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  function describeEl(el) {
    if (!el || !el.tagName) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.classList && el.classList.length)
      s += '.' + Array.from(el.classList).slice(0, 3).join('.');
    return s;
  }

  // -------------------------------------------------------------------------
  // Source location via React fiber
  // -------------------------------------------------------------------------

  function getFiber(el, debug) {
    let node = el;
    let hops = 0;
    while (node && hops < 50) {
      const k = fiberKeyOf(node);
      if (k && node[k]) {
        debug.fiberFoundOn = describeEl(node);
        debug.ancestorHops = hops;
        return node[k];
      }
      node = node.parentElement;
      hops++;
    }
    debug.fiberFoundOn = null;
    debug.ancestorHops = hops;
    return null;
  }

  // Human label for a fiber the user might want to target; null = skip the
  // level (Fragments, Mode wrappers, providers and other structural noise).
  function fiberLabel(f) {
    const t = f.type;
    if (typeof t === 'string') return t;
    if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
    if (t && typeof t === 'object') {
      // memo/forwardRef: only worth a level when the inner component has a
      // real name — generic wrappers are noise the user can't act on.
      if (typeof t.render === 'function')
        return t.render.displayName || t.render.name || null;
      if (t.type) {
        const inner = t.type;
        return (typeof inner === 'function' && (inner.displayName || inner.name)) || null;
      }
    }
    if (f.tag === 13) return 'Suspense';
    return null;
  }

  // Walks fiber.return from the clicked element's fiber to the root. Returns
  // [{ fiber, label }, …] deepest-first; empty when the page isn't React.
  function buildHierarchy(el, debug) {
    const fiber = getFiber(el, debug);
    if (!fiber) return [];
    const levels = [];
    let f = fiber;
    let guard = 0;
    while (f && guard++ < 500) {
      const label = fiberLabel(f);
      if (label) levels.push({ fiber: f, label: label });
      f = f.return;
    }
    return levels;
  }

  // Nearest DOM element rendered by a fiber (itself when it's a host fiber,
  // otherwise the first host descendant). Tags 5/26/27 are HostComponent /
  // HostHoistable / HostSingleton.
  function domForFiber(fiber) {
    let node = fiber;
    let guard = 0;
    while (node && guard++ < 2000) {
      if (
        (node.tag === 5 || node.tag === 26 || node.tag === 27) &&
        node.stateNode instanceof Element
      )
        return node.stateNode;
      if (node.child) {
        node = node.child;
        continue;
      }
      while (node && node !== fiber && !node.sibling) node = node.return;
      if (!node || node === fiber) return null;
      node = node.sibling;
    }
    return null;
  }

  function stackToString(s) {
    if (!s) return null;
    if (typeof s === 'string') return s;
    if (Array.isArray(s)) {
      const lines = [];
      for (const fr of s) {
        if (!Array.isArray(fr) || fr.length < 4 || !fr[1]) continue;
        lines.push('    at ' + (fr[0] || '<anonymous>') + ' (' + fr[1] + ':' + fr[2] + ':' + fr[3] + ')');
      }
      return lines.length ? 'Error\n' + lines.join('\n') : null;
    }
    if (typeof s.stack === 'string') return s.stack;
    return null;
  }

  function describeNode(f) {
    if (f.tag !== undefined) {
      const t = f.type;
      const typeDesc =
        typeof t === 'function'
          ? 'fn:' + (t.displayName || t.name || 'anon')
          : typeof t === 'string'
            ? t
            : t === null
              ? 'null'
              : typeof t;
      return {
        kind: 'fiber',
        tag: f.tag,
        type: typeDesc,
        hasSource: !!f._debugSource,
        frames: frameCount(nodeStack(f)),
        hasInfo: Array.isArray(f._debugInfo) ? f._debugInfo.length : 0,
        hasOwner: !!f._debugOwner,
      };
    }
    return {
      kind: 'info',
      name: f.name || null,
      frames: frameCount(nodeStack(f)),
      hasOwner: !!(f.owner || f._debugOwner),
    };
  }

  function frameCount(s) {
    if (!s) return 0;
    let n = 0;
    for (const line of s.split('\n')) {
      if (/^\s*at\s.+:\d+:\d+/.test(line) || /@.+:\d+:\d+/.test(line)) n++;
    }
    return n;
  }

  function nodeStack(f) {
    if (f.tag === undefined) {
      return (
        stackToString(f.stack) ||
        stackToString(f.debugStack) ||
        stackToString(f._debugStack)
      );
    }
    return stackToString(f._debugStack) || stackToString(f.debugStack);
  }

  function nodeOwner(f) {
    return f._debugOwner || f.owner || f.return || null;
  }

  function findSource(el, debug) {
    const fiber = getFiber(el, debug);
    if (!fiber) return null;
    return sourceFromFiber(fiber, debug);
  }

  function sourceFromFiber(fiber, debug) {
    let componentName = null;
    let f = fiber;
    let guard = 0;
    while (f && guard++ < 30) {
      if (typeof f.type === 'function') {
        componentName = f.type.displayName || f.type.name || null;
        break;
      }
      if (f.tag === undefined && typeof f.name === 'string') {
        componentName = f.name;
        break;
      }
      f = nodeOwner(f);
    }

    const stacks = [];
    const seen = {};
    function addStack(s) {
      if (!s) return;
      if (seen[s]) return;
      seen[s] = true;
      stacks.push(s);
    }

    const ownerNames = [];
    function addOwnerName(n) {
      if (n && ownerNames.indexOf(n) < 0 && ownerNames.length < 5) ownerNames.push(n);
    }

    f = fiber;
    guard = 0;
    while (f && guard++ < 30 && stacks.length < 8) {
      debug.walk.push(describeNode(f));

      if (typeof f.type === 'function') addOwnerName(f.type.displayName || f.type.name);
      else if (f.tag === undefined && typeof f.name === 'string') addOwnerName(f.name);

      if (f._debugSource && f._debugSource.fileName) {
        return {
          fileName: f._debugSource.fileName,
          lineNumber: f._debugSource.lineNumber || 1,
          columnNumber: f._debugSource.columnNumber || 1,
          componentName: componentName,
        };
      }

      addStack(nodeStack(f));

      if (Array.isArray(f._debugInfo)) {
        for (const info of f._debugInfo) {
          if (!info) continue;
          addOwnerName(typeof info.name === 'string' ? info.name : null);
          addStack(stackToString(info.stack));
          addStack(stackToString(info.debugStack));
        }
      }

      f = nodeOwner(f);
    }

    if (stacks.length || ownerNames.length)
      return { stacks: stacks, componentName: componentName, ownerNames: ownerNames };
    return componentName ? { componentName: componentName } : null;
  }

  // -------------------------------------------------------------------------
  // Route reporting
  // -------------------------------------------------------------------------

  let lastRoute = null;
  function reportRoute() {
    const route = location.pathname + location.search + location.hash;
    if (route === lastRoute) return;
    lastRoute = route;
    try {
      window.parent.postMessage({ type: 'pv-route', route: route }, '*');
    } catch (_) {}
  }

  const patchedHistory = {};
  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    patchedHistory[method] = orig;
    history[method] = function () {
      const ret = orig.apply(this, arguments);
      reportRoute();
      return ret;
    };
  }
  on(window, 'popstate', reportRoute);
  on(window, 'hashchange', reportRoute);

  function announce() {
    try {
      window.parent.postMessage({ type: 'pv-ready' }, '*');
    } catch (_) {}
    reportRoute();
  }
  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', announce);
  } else {
    announce();
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  function destroy() {
    setMode(null);
    clearPanelTimers();
    clearCssTimers();
    teardownListeners.forEach((l) => l[0].removeEventListener(l[1], l[2], l[3]));
    teardownListeners = [];
    // restore the History methods we patched
    for (const method of ['pushState', 'replaceState']) {
      if (patchedHistory[method]) history[method] = patchedHistory[method];
    }
    closeHierPicker();
    [style, panel, cssPanel, hierPanel].forEach((el) => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    panel = cssPanel = hierPanel = null;
    window.__PV_INSTALLED__ = false;
  }

  return { destroy: destroy };
}
