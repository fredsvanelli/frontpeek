// FrontPeek — inspector script injected by the proxy into the Next.js page.
// Modes: 'edit' (click opens the source in the editor) and 'ai' (click opens
// a floating prompt panel; Enter builds a structured prompt that the
// extension copies to the clipboard).
(function () {
  if (window.__PV_INSTALLED__) return;
  window.__PV_INSTALLED__ = true;

  let mode = null; // null | 'edit' | 'ai'
  let hovered = null;
  let selected = null;
  let panel = null;
  let ta = null;
  let copyBtn = null;
  let copyLbl = null;
  let pending = null; // context of the AI-mode click

  // Keep the last few JS errors for diagnostics (if React fails to hydrate,
  // the reason shows up here).
  const pageErrors = [];
  function pushError(msg) {
    pageErrors.push(String(msg).slice(0, 300));
    if (pageErrors.length > 5) pageErrors.shift();
  }
  window.addEventListener('error', (e) => {
    pushError((e.message || e.error) + (e.filename ? ' @ ' + e.filename + ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    pushError('unhandledrejection: ' + ((r && (r.stack || r.message)) || r));
  });

  // DOM-node -> fiber key across React versions: React 17+ tags nodes with
  // __reactFiber$<random>, React 16 with __reactInternalInstance$<random>.
  function fiberKeyOf(node) {
    const keys = Object.getOwnPropertyNames(node);
    for (const k of keys) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0)
        return k;
    }
    return null;
  }

  // Checks whether React mounted anywhere on the page
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
    '#__pv-panel .__pv-footer{display:flex;align-items:center;justify-content:space-between;margin-top:10px;gap:8px;}' +
    '#__pv-panel .__pv-hint{font-size:11px;color:#71717a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '#__pv-panel .__pv-copy{display:flex;align-items:center;gap:5px;' +
    'background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border:none;' +
    'border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer !important;font-family:inherit;flex-shrink:0;}' +
    '#__pv-panel .__pv-copy:hover:not(:disabled){filter:brightness(1.15);}' +
    '#__pv-panel .__pv-copy:disabled{background:#3f3f46;color:#a1a1aa;cursor:default !important;filter:none;}';
  document.documentElement.appendChild(style);

  function clearHover() {
    if (hovered) {
      hovered.removeAttribute('data-pv-hover');
      hovered = null;
    }
  }

  function setMode(m) {
    mode = m;
    if (mode) {
      document.body.setAttribute('data-pv-inspecting', '');
    } else {
      document.body.removeAttribute('data-pv-inspecting');
      clearHover();
      closePanel();
    }
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'pv-set-inspect') {
      setMode(msg.enabled ? msg.mode || 'edit' : null);
    } else if (msg.type === 'pv-ai-copied') {
      if (copyBtn) {
        copyBtn.disabled = true;
        copyLbl.textContent = 'Copied!';
      }
      // show "Copied!" briefly, then fade the panel out
      copiedTimer = setTimeout(fadePanelOut, 500);
    }
  });

  document.addEventListener(
    'mousemove',
    (e) => {
      if (!mode) return;
      // with the panel open, freeze hover (keep only the selected outline)
      if (panel && panel.style.display !== 'none') return;
      const target = e.target;
      if (target === hovered || !(target instanceof Element)) return;
      clearHover();
      hovered = target;
      hovered.setAttribute('data-pv-hover', '');
    },
    true
  );

  // Close the panel when clicking outside of it
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!panel || panel.style.display === 'none') return;
      if (panel.contains(e.target)) return;
      closePanel();
    },
    true
  );

  document.addEventListener(
    'click',
    (e) => {
      if (!mode) return;
      if (panel && panel.contains(e.target)) return; // panel interactions
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const debug = { target: describeEl(e.target), walk: [] };
      let source = null;
      try {
        source = findSource(e.target, debug);
      } catch (err) {
        debug.error = String((err && err.stack) || err);
      }
      if (!source) {
        debug.reactDetected = reactDetected();
        debug.nextData = !!window.__next_f;
        debug.pageErrors = pageErrors.slice();
      }

      if (mode === 'edit') {
        window.parent.postMessage({ type: 'pv-open-source', source: source, debug: debug }, '*');
      } else {
        openPanel(e.target, source);
      }
    },
    true
  );

  // Esc deselects the active tool; with the prompt panel open, the first Esc
  // only closes the panel.
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !mode) return;
      if (panel && panel.style.display !== 'none') {
        closePanel();
        return;
      }
      setMode(null);
      window.parent.postMessage({ type: 'pv-exit-inspect' }, '*');
    },
    true
  );

  // -------------------------------------------------------------------------
  // AI-mode floating panel
  // -------------------------------------------------------------------------

  const TA_MAX = 100; // 5 lines of 20px

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
      // Shift+Enter: native behavior (line break)
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

    // position near the element, preferring below it
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

  // "Copied!" is shown for 500ms, then the panel fades out and closes.
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
    fadeTimer = setTimeout(closePanel, 250); // matches the CSS transition
  }

  // -------------------------------------------------------------------------
  // Element description for the prompt
  // -------------------------------------------------------------------------

  const PROMPT_ATTRS = [
    'alt',
    'href',
    'aria-label',
    'data-testid',
    'placeholder',
    'type',
    'name',
    'role',
    'title',
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

  // Looks for the fiber key on the element (see fiberKeyOf) and, if missing
  // (nodes created via dangerouslySetInnerHTML, third-party widgets etc.),
  // walks up the ancestors until it finds a React-managed node.
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

  function stackToString(s) {
    if (!s) return null;
    if (typeof s === 'string') return s;
    if (typeof s.stack === 'string') return s.stack;
    return null;
  }

  function describeNode(f) {
    if (f.tag !== undefined) {
      // an actual fiber
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
        hasStack: !!(f._debugStack || f.debugStack),
        hasInfo: Array.isArray(f._debugInfo) ? f._debugInfo.length : 0,
        hasOwner: !!f._debugOwner,
      };
    }
    // ReactComponentInfo (server component)
    return {
      kind: 'info',
      name: f.name || null,
      hasStack: !!(f.debugStack || f.stack),
      hasOwner: !!(f.owner || f._debugOwner),
    };
  }

  function nodeStack(f) {
    // fiber: _debugStack; RSC info: debugStack (Error) or stack (string)
    return (
      stackToString(f._debugStack) ||
      stackToString(f.debugStack) ||
      (f.tag === undefined ? stackToString(f.stack) : null)
    );
  }

  function nodeOwner(f) {
    return f._debugOwner || f.owner || f.return || null;
  }

  function findSource(el, debug) {
    const fiber = getFiber(el, debug);
    if (!fiber) return null;

    // Name of the component that owns the element. Either a fiber (client
    // component, type is a function/class) or a ReactComponentInfo (server
    // component, only has .name).
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

    // Location: _debugSource (React <= 18) gives file/line directly;
    // _debugStack (React 19) is a stack of compiled frames the extension
    // resolves via source maps. The clicked element's stack may point inside
    // a library (e.g. next/image's <img>), so collect the stacks of the
    // ENTIRE owner chain — the extension tries them one by one until one
    // resolves to a project file. _debugInfo carries info about the Server
    // Components traversed.
    const stacks = [];
    const seen = {};
    function addStack(s) {
      if (!s) return;
      const key = s.slice(0, 200);
      if (seen[key]) return;
      seen[key] = true;
      stacks.push(s);
    }

    f = fiber;
    guard = 0;
    while (f && guard++ < 30 && stacks.length < 8) {
      debug.walk.push(describeNode(f));

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
          if (info) addStack(stackToString(info.debugStack) || stackToString(info.stack));
        }
      }

      f = nodeOwner(f);
    }

    if (stacks.length) return { stacks: stacks, componentName: componentName };
    return componentName ? { componentName: componentName } : null;
  }

  // -------------------------------------------------------------------------
  // Route reporting — the webview iframe is cross-origin, so the toolbar's
  // address bar can only learn the current route from in-page messages.
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

  // Client-side navigations (Next.js router) go through the History API.
  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    history[method] = function () {
      const ret = orig.apply(this, arguments);
      reportRoute();
      return ret;
    };
  }
  window.addEventListener('popstate', reportRoute);
  window.addEventListener('hashchange', reportRoute);

  // Tell the webview the page loaded (to resync the inspect mode)
  function announce() {
    try {
      window.parent.postMessage({ type: 'pv-ready' }, '*');
    } catch (_) {}
    reportRoute();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce);
  } else {
    announce();
  }
})();
