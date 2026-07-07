// Clipboard + a small transient toast, both dependency-free and safe to call
// from the page context the toolbar lives in.

// navigator.clipboard needs a secure context (https or localhost). Fall back to
// the legacy execCommand path so the copy still works on plain-http dev hosts
// that aren't localhost.
export async function write(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

export function copyPath(loc) {
  const path = loc && loc.file
    ? loc.file + (loc.line ? ':' + loc.line + (loc.column ? ':' + loc.column : '') : '')
    : loc && loc.componentName
      ? loc.componentName
      : '';
  return write(path).then((ok) => ({ ok, path }));
}

// A one-shot popover anchored to the toolbar (or screen-centered as a
// fallback). Reuses the toolbar's dark glass styling for visual consistency.
let toastEl = null;
let toastTimer = null;

export function showToast(text, anchorEl) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = '__pv-toast';
    toastEl.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;display:none;' +
      'padding:8px 12px;background:#1e1e1eF7;border:1px solid #ffffff26;border-radius:9px;' +
      'box-shadow:0 12px 34px #000a;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;" +
      'color:#e4e4e7;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .18s ease;';
    document.body.appendChild(toastEl);
  }
  clearTimeout(toastTimer);
  toastEl.textContent = text;
  toastEl.style.display = 'block';
  toastEl.style.visibility = 'hidden';

  // Measure, then anchor above the toolbar; center on screen if no anchor.
  const tw = toastEl.offsetWidth;
  const th = toastEl.offsetHeight;
  let left, top;
  if (anchorEl && anchorEl.getBoundingClientRect) {
    const r = anchorEl.getBoundingClientRect();
    left = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
    top = r.top - th - 8 >= 8 ? r.top - th - 8 : r.bottom + 8;
  } else {
    left = (window.innerWidth - tw) / 2;
    top = window.innerHeight - th - 24;
  }
  toastEl.style.left = Math.round(left) + 'px';
  toastEl.style.top = Math.round(top) + 'px';
  toastEl.style.visibility = 'visible';
  // next frame so the opacity transition runs
  requestAnimationFrame(() => { if (toastEl) toastEl.style.opacity = '1'; });

  toastTimer = setTimeout(() => {
    if (!toastEl) return;
    toastEl.style.opacity = '0';
    toastTimer = setTimeout(() => { if (toastEl) toastEl.style.display = 'none'; }, 200);
  }, 1600);
}

export function destroyToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
  toastEl = null;
}
