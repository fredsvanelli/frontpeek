// FrontPeek — cross-origin tunnel patch.
//
// The preview page runs behind the local proxy, so its origin is
// http://127.0.0.1:<proxy-port> instead of the real dev server origin.
// Direct fetch/XHR calls to third-party APIs (Okta, Auth0, any backend that
// validates CORS against an allowlist) therefore fail: those services trust
// the dev server origin, not the proxy's random port.
//
// Fix: reroute every cross-origin fetch/XHR/sendBeacon through the proxy's
// /__pv/tunnel endpoint. The request becomes same-origin in the browser (no
// CORS at all) and the extension re-issues it server-side with the real dev
// server Origin — third-party services see exactly what a normal browser at
// the dev server URL would send. Works out-of-the-box, no allowlist changes.
//
// __PV_TARGET_ORIGIN__ is replaced by the extension when serving this file.
(() => {
  if (window.__pvTunnelInstalled) return;
  window.__pvTunnelInstalled = true;

  const TARGET_ORIGIN = '__PV_TARGET_ORIGIN__';
  const PROXY_ORIGIN = location.origin;
  const TUNNEL = PROXY_ORIGIN + '/__pv/tunnel?u=';

  function mapUrl(raw) {
    let abs;
    try {
      abs = new URL(raw, document.baseURI);
    } catch {
      return raw;
    }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return raw;
    if (abs.origin === PROXY_ORIGIN) return raw;
    // Absolute URLs pointing at the dev server itself go through the main
    // proxy path (same rewriting the page's relative URLs already get).
    if (abs.origin === TARGET_ORIGIN) {
      return PROXY_ORIGIN + abs.pathname + abs.search + abs.hash;
    }
    return TUNNEL + encodeURIComponent(abs.href);
  }

  // Cookies written from JS (document.cookie — used by @supabase/ssr's
  // browser client, js-cookie, etc.) default to SameSite=Lax, which Chromium
  // rejects here: the preview iframe is cross-site relative to the webview's
  // vscode-webview:// top-level origin. Rewrite every JS cookie write to
  // SameSite=None; Secure (accepted over http on localhost — trustworthy
  // origin) so client-side sessions survive inside the preview. The proxy
  // applies the same rewrite to server Set-Cookie headers.
  try {
    const cookieDesc =
      Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
      Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
    if (cookieDesc && cookieDesc.set) {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get() {
          return cookieDesc.get.call(document);
        },
        set(v) {
          let out = String(v);
          try {
            out =
              out
                .split(';')
                .filter((p) => {
                  const k = p.trim().toLowerCase();
                  return !k.startsWith('samesite') && k !== 'secure';
                })
                .join(';') + '; SameSite=None; Secure';
          } catch {}
          cookieDesc.set.call(document, out);
        },
      });
    }
  } catch {}

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' || input instanceof URL) {
        const mapped = mapUrl(String(input));
        if (mapped !== String(input)) input = mapped;
      } else if (input && typeof input.url === 'string') {
        const mapped = mapUrl(input.url);
        if (mapped !== input.url) input = new Request(mapped, input);
      }
    } catch {}
    return origFetch.call(this, input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      url = mapUrl(String(url));
    } catch {}
    return rest.length
      ? origOpen.call(this, method, url, ...rest)
      : origOpen.call(this, method, url);
  };

  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      try {
        url = mapUrl(String(url));
      } catch {}
      return origBeacon(url, data);
    };
  }

  // Diagnostics only: iframe/window navigations to third-party origins can NOT
  // be tunneled (they are not fetch/XHR), and OAuth SPA flows rely on them
  // (hidden authorize iframe + postMessage bound to the app's real origin).
  // Log a clear hint so it is obvious why such a login stalls, and what fixes
  // it (a stable, whitelisted preview origin — see frontPeek.proxyPort).
  function isThirdParty(raw) {
    try {
      const abs = new URL(raw, document.baseURI);
      return (
        (abs.protocol === 'http:' || abs.protocol === 'https:') &&
        abs.origin !== PROXY_ORIGIN &&
        abs.origin !== TARGET_ORIGIN
      );
    } catch {
      return false;
    }
  }
  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    if (desc && desc.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set(v) {
          if (isThirdParty(v)) {
            console.warn(
              '[FrontPeek] cross-origin iframe navigation NOT tunneled. ' +
                'OAuth/SSO logins bind to the real app origin and will not ' +
                'complete at ' +
                PROXY_ORIGIN +
                '. Fix: set a fixed "frontPeek.proxyPort" and add ' +
                PROXY_ORIGIN +
                ' to the identity provider trusted origins / redirect URIs. ' +
                'Blocked: ' +
                v
            );
          }
          return desc.set.call(this, v);
        },
      });
    }
  } catch {}
})();
