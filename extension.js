const vscode = require('vscode');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const fs = require('fs');

// Browser-facing host for the proxy. We use `localhost` (not `127.0.0.1`) so
// that cookies scoped to the `localhost` host — which browsers key by host and
// NOT by port — are shared between the dev server (localhost:<devport>) and the
// preview (localhost:<proxyport>). This lets cookie-session logins carry into
// the preview. The server still binds to the 127.0.0.1 loopback address; the
// browser resolves `localhost` to it (falling back from ::1 if needed).
const PROXY_HOST = 'localhost';
const proxyOriginFor = (port) => `http://${PROXY_HOST}:${port}`;

let previewView = null;
let proxyServer = null;
let output = null;
let currentTargetOrigin = null;
let currentProxyPort = null;
let currentInitialPath = '/';

// The Next.js-only source-resolution endpoints 404 on plain React dev servers
// (Vite, CRA, webpack-dev-server). Remember the 404 per connect so every
// click doesn't re-probe them before falling back to source maps.
let nextEndpointMissing = { batch: false, legacy: false, sourceMap: false };

function log(msg) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function activate(context) {
  output = vscode.window.createOutputChannel('FrontPeek');
  context.subscriptions.push(output);

  // Preview lives in the secondary (right) sidebar — see
  // contributes.viewsContainers.secondarySidebar in package.json.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'frontPeek.preview',
      {
        resolveWebviewView(view) {
          previewView = view;
          view.webview.options = { enableScripts: true };
          view.webview.html = currentProxyPort
            ? getWebviewHtml(currentProxyPort, currentTargetOrigin, currentInitialPath)
            : getPlaceholderHtml();
          view.webview.onDidReceiveMessage(
            (msg) => handleWebviewMessage(context, msg),
            undefined,
            context.subscriptions
          );
          view.onDidDispose(() => {
            if (previewView === view) previewView = null;
          });
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Activity bar (left) entry: a pure redirect — clicking the icon reveals
  // the preview in the secondary sidebar and closes the left one, since the
  // activity bar can only host view containers, not commands.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('frontPeek.launcher', {
      resolveWebviewView(view) {
        view.webview.html = getRedirectHtml();
        const redirect = () => {
          if (!view.visible) return;
          vscode.commands.executeCommand('frontPeek.preview.focus');
          vscode.commands.executeCommand('workbench.action.closeSidebar');
        };
        view.onDidChangeVisibility(redirect, undefined, context.subscriptions);
        redirect();
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('frontPeek.open', () => openPreview(context))
  );
}

function handleWebviewMessage(context, msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'connect') {
    openPreview(context, msg.url).catch((err) => {
      log(`ERROR in openPreview: ${err.stack || err.message}`);
      vscode.window.showErrorMessage(`FrontPeek: ${err.message}`);
    });
  } else if (msg.type === 'open-source') {
    if (msg.debug) log(`Inspector diagnostics: ${JSON.stringify(msg.debug)}`);
    openSource(msg.source).catch((err) => {
      log(`ERROR in openSource: ${err.stack || err.message}`);
      vscode.window.showErrorMessage(`FrontPeek: ${err.message}`);
    });
  } else if (msg.type === 'ai-prompt') {
    if (msg.debug) log(`Inspector diagnostics: ${JSON.stringify(msg.debug)}`);
    handleAiPrompt(msg.payload).catch((err) => {
      log(`ERROR in handleAiPrompt: ${err.stack || err.message}`);
      vscode.window.showErrorMessage(`FrontPeek: ${err.message}`);
    });
  }
}

async function openPreview(context, presetUrl) {
  const target =
    presetUrl ||
    (await vscode.window.showInputBox({
      prompt: 'Dev server URL (Next.js, Vite, CRA, …)',
      value: 'http://localhost:3000',
      ignoreFocusOut: true,
    }));
  if (!target) return;

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    vscode.window.showErrorMessage(`FrontPeek: invalid URL: ${target}`);
    return;
  }

  try {
    const proxyPort = await startProxy(context, targetUrl);
    currentTargetOrigin = targetUrl.origin;
    currentProxyPort = proxyPort;
    currentInitialPath = targetUrl.pathname + targetUrl.search;
    log(`Proxy started on ${PROXY_HOST}:${proxyPort} -> ${targetUrl.origin}`);
  } catch (err) {
    vscode.window.showErrorMessage(`FrontPeek: failed to start proxy: ${err.message}`);
    return;
  }

  // Reveals the view in the right sidebar; if this is its first open,
  // resolveWebviewView renders the iframe from currentProxyPort.
  await vscode.commands.executeCommand('frontPeek.preview.focus');
  if (previewView)
    previewView.webview.html = getWebviewHtml(currentProxyPort, currentTargetOrigin, currentInitialPath);
}

// Hop-by-hop headers must not be forwarded: Node decodes the upstream body
// (e.g. chunked), so forwarding transfer-encoding would make the browser try
// to decode it again and corrupt the response (broken JS chunks => React
// never loads).
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function stripHopByHop(headers) {
  const out = { ...headers };
  for (const k of HOP_BY_HOP) delete out[k];
  return out;
}

// The preview iframe is cross-site from the browser's point of view (the
// webview's top-level origin is vscode-webview://...), so Chromium silently
// drops Set-Cookie headers carrying SameSite=Lax/Strict — the default of
// virtually every cookie-session library (@supabase/ssr, next-auth,
// iron-session). The login POST succeeds upstream but the session cookie
// never sticks, and the next request bounces back to the login page.
// Rewrite to SameSite=None; Secure — Chromium accepts Secure cookies from
// http://localhost because loopback is a trustworthy origin. Domain is
// stripped too: the browser talks to localhost:<proxyport>, so a Domain
// pinned to another dev host would get the cookie rejected outright.
function rewriteSetCookieForWebview(headers) {
  const sc = headers['set-cookie'];
  if (!sc) return;
  headers['set-cookie'] = (Array.isArray(sc) ? sc : [sc]).map((line) => {
    const parts = String(line)
      .split(';')
      .filter((p) => {
        const k = p.trim().toLowerCase();
        return !k.startsWith('samesite') && k !== 'secure' && !k.startsWith('domain');
      });
    return parts.join(';') + '; SameSite=None; Secure';
  });
}

// ---------------------------------------------------------------------------
// Cross-origin tunnel: cookie jar
//
// Tunneled requests (see /__pv/tunnel below) are re-issued server-side, so
// the browser never sees the third party's Set-Cookie headers — it couldn't
// store them anyway (a 127.0.0.1 response can't set cookies for another
// domain). The extension keeps them here and plays the browser's role:
// store on response, attach on matching requests (domain + path + expiry).
// ---------------------------------------------------------------------------

let tunnelCookies = new Map(); // "domain|path|name" -> cookie

// RFC 6265 default path: the request path up to (not including) the last '/'.
function cookieDefaultPath(pathname) {
  if (!pathname || pathname[0] !== '/') return '/';
  const i = pathname.lastIndexOf('/');
  return i > 0 ? pathname.slice(0, i) : '/';
}

function jarStore(dest, setCookieHeaders) {
  if (!setCookieHeaders) return;
  for (const line of setCookieHeaders) {
    const parts = String(line).split(';');
    const eq = parts[0].indexOf('=');
    if (eq < 1) continue;
    const cookie = {
      name: parts[0].slice(0, eq).trim(),
      value: parts[0].slice(eq + 1).trim(),
      domain: dest.hostname.toLowerCase(),
      hostOnly: true,
      path: cookieDefaultPath(dest.pathname),
      expires: null, // session cookie
    };
    for (const attr of parts.slice(1)) {
      const sep = attr.indexOf('=');
      const key = (sep === -1 ? attr : attr.slice(0, sep)).trim().toLowerCase();
      const val = sep === -1 ? '' : attr.slice(sep + 1).trim();
      if (key === 'domain' && val) {
        cookie.domain = val.replace(/^\./, '').toLowerCase();
        cookie.hostOnly = false;
      } else if (key === 'path' && val.startsWith('/')) {
        cookie.path = val;
      } else if (key === 'max-age') {
        const s = parseInt(val, 10);
        if (!isNaN(s)) cookie.expires = Date.now() + s * 1000;
      } else if (key === 'expires' && cookie.expires === null) {
        // Max-Age wins over Expires, hence the null guard
        const t = Date.parse(val);
        if (!isNaN(t)) cookie.expires = t;
      }
    }
    const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
    if (cookie.expires !== null && cookie.expires <= Date.now()) {
      tunnelCookies.delete(key); // expired == deletion request
    } else {
      tunnelCookies.set(key, cookie);
    }
  }
}

function jarGet(dest) {
  const host = dest.hostname.toLowerCase();
  const reqPath = dest.pathname || '/';
  const now = Date.now();
  const matches = [];
  for (const [key, c] of tunnelCookies) {
    if (c.expires !== null && c.expires <= now) {
      tunnelCookies.delete(key);
      continue;
    }
    const domainOk = c.hostOnly
      ? host === c.domain
      : host === c.domain || host.endsWith('.' + c.domain);
    if (!domainOk) continue;
    const pathOk =
      reqPath === c.path ||
      (reqPath.startsWith(c.path) &&
        (c.path.endsWith('/') || reqPath[c.path.length] === '/'));
    if (!pathOk) continue;
    matches.push(c);
  }
  matches.sort((a, b) => b.path.length - a.path.length);
  return matches.length ? matches.map((c) => `${c.name}=${c.value}`).join('; ') : null;
}

// Next 15.2+/16 blocks cross-origin access to dev resources (/_next/*, HMR)
// with "Blocked cross-origin request to Next.js dev resource". Since the page
// runs behind our proxy, the browser sends Origin/Referer of
// 127.0.0.1:<proxy-port>; rewrite them to the real dev server origin.
function rewriteBrowserOrigin(headers, targetUrl) {
  const out = { ...headers };
  if (out.origin) out.origin = targetUrl.origin;
  if (out.referer) {
    try {
      const u = new URL(out.referer);
      out.referer = targetUrl.origin + u.pathname + u.search;
    } catch {
      delete out.referer;
    }
  }
  return out;
}

/**
 * /__pv/tunnel?u=<absolute url> — server-side relay for the page's
 * cross-origin fetch/XHR calls (rerouted here by media/tunnel.js).
 *
 * Services like Okta enforce CORS against an allowlist of trusted origins;
 * the proxy's 127.0.0.1:<random-port> origin can never be on it. Relaying
 * server-side removes CORS from the browser entirely (the call is
 * same-origin) and sends the third party the Origin/Referer of the real dev
 * server — the request looks identical to one from a normal browser tab, so
 * whatever already works at http://localhost:3000 works in the preview too.
 */
function handleTunnel(req, res, targetUrl) {
  let dest;
  try {
    dest = new URL(new URL(req.url, 'http://placeholder').searchParams.get('u'));
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('FrontPeek tunnel: missing or invalid "u" parameter');
    return;
  }
  if (dest.protocol !== 'http:' && dest.protocol !== 'https:') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`FrontPeek tunnel: unsupported protocol ${dest.protocol}`);
    return;
  }

  const headers = stripHopByHop(rewriteBrowserOrigin(req.headers, targetUrl));
  headers.host = dest.host;
  // sec-fetch-* describe the browser->proxy hop (same-origin) — inconsistent
  // with the rewritten Origin, so drop them.
  for (const k of Object.keys(headers)) {
    if (k.startsWith('sec-fetch-')) delete headers[k];
  }
  // The browser attached the proxy-origin cookies (they belong to the dev
  // app, not the third party) — swap them for the tunnel jar's cookies.
  delete headers.cookie;
  const cookie = jarGet(dest);
  if (cookie) headers.cookie = cookie;

  const mod = dest.protocol === 'https:' ? https : http;
  const upstreamReq = mod.request(
    {
      hostname: dest.hostname,
      port: Number(dest.port) || (dest.protocol === 'https:' ? 443 : 80),
      path: dest.pathname + dest.search,
      method: req.method,
      headers,
    },
    (upstream) => {
      log(`Tunnel ${req.method} ${dest.href} -> ${upstream.statusCode}`);
      jarStore(dest, upstream.headers['set-cookie']);
      const outHeaders = stripHopByHop(upstream.headers);
      delete outHeaders['set-cookie']; // lives in the jar, not the browser
      // Keep redirect chains inside the tunnel (a relative Location would
      // otherwise resolve against the proxy origin and hit the dev server).
      if (outHeaders.location) {
        try {
          const loc = new URL(outHeaders.location, dest);
          outHeaders.location =
            loc.origin === targetUrl.origin
              ? loc.pathname + loc.search + loc.hash
              : `/__pv/tunnel?u=${encodeURIComponent(loc.href)}`;
        } catch {}
      }
      res.writeHead(upstream.statusCode, outHeaders);
      upstream.pipe(res);
    }
  );

  upstreamReq.on('error', (err) => {
    log(`Tunnel ${req.method} ${dest.href} failed: ${err.message}`);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`FrontPeek tunnel: ${err.message}`);
  });

  req.pipe(upstreamReq);
}

/**
 * Local HTTP proxy that forwards to the Next.js dev server and injects the
 * inspector script into every HTML response. Needed because the webview
 * iframe is cross-origin — we cannot inject scripts into it directly.
 */
function startProxy(context, targetUrl) {
  return new Promise((resolve, reject) => {
    const inspectorSrc = fs.readFileSync(
      path.join(context.extensionPath, 'media', 'inspector.js'),
      'utf8'
    );
    const tunnelSrc = fs
      .readFileSync(path.join(context.extensionPath, 'media', 'tunnel.js'), 'utf8')
      .replace(/__PV_TARGET_ORIGIN__/g, targetUrl.origin);
    const targetPort = Number(targetUrl.port) || 80;

    if (proxyServer) {
      proxyServer.close();
      proxyServer = null;
    }
    tunnelCookies = new Map(); // fresh third-party session per connect
    nextEndpointMissing = { batch: false, legacy: false, sourceMap: false };

    const server = http.createServer((req, res) => {
      if (req.url === '/__pv/inspector.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(inspectorSrc);
        return;
      }
      if (req.url === '/__pv/tunnel.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(tunnelSrc);
        return;
      }
      if (req.url.startsWith('/__pv/tunnel?')) {
        handleTunnel(req, res, targetUrl);
        return;
      }

      const upstreamReq = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: {
            ...stripHopByHop(rewriteBrowserOrigin(req.headers, targetUrl)),
            host: targetUrl.host,
            // no compression, so we can inject into the HTML
            'accept-encoding': 'identity',
          },
        },
        (upstream) => {
          const headers = stripHopByHop(upstream.headers);
          delete headers['x-frame-options'];
          delete headers['content-security-policy'];
          rewriteSetCookieForWebview(headers);

          const isHtml = (upstream.headers['content-type'] || '').includes('text/html');
          if (!isHtml) {
            res.writeHead(upstream.statusCode, headers);
            upstream.pipe(res);
            return;
          }

          const chunks = [];
          upstream.on('data', (c) => chunks.push(c));
          upstream.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8');
            // tunnel patch first: fetch/XHR must be wrapped before any app
            // code (or the inspector) captures a reference to them
            const tag =
              '<script src="/__pv/tunnel.js"></script>' +
              '<script src="/__pv/inspector.js"></script>';
            body = body.includes('</head>')
              ? body.replace('</head>', tag + '</head>')
              : tag + body;
            delete headers['content-length'];
            res.writeHead(upstream.statusCode, headers);
            res.end(body);
          });
        }
      );

      upstreamReq.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end(
          `<h3>FrontPeek: could not connect to ${targetUrl.origin}</h3><p>${err.message}</p><p>Is the dev server running?</p>`
        );
      });

      req.pipe(upstreamReq);
    });

    // WebSocket passthrough so Next.js HMR keeps working
    server.on('upgrade', (req, socket, head) => {
      const upstream = net.connect(targetPort, targetUrl.hostname, () => {
        let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
        const headers = {
          ...rewriteBrowserOrigin(req.headers, targetUrl),
          host: targetUrl.host,
        };
        for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
        raw += '\r\n';
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });

    // A fixed port (frontPeek.proxyPort) keeps the preview origin stable
    // across sessions so it can be whitelisted at an identity provider; 0 means
    // pick any free port. If the fixed port is taken, fall back to a random one
    // rather than failing to open the preview.
    const desiredPort = readProxyPort();
    let triedFallback = false;
    server.on('listening', () => resolve(server.address().port));
    server.on('error', (err) => {
      if (desiredPort && !triedFallback && err.code === 'EADDRINUSE') {
        triedFallback = true;
        log(`Configured proxy port ${desiredPort} is in use; falling back to a random port`);
        vscode.window.showWarningMessage(
          `FrontPeek: proxy port ${desiredPort} is in use — using a random port instead. ` +
            `Logins that rely on a fixed, whitelisted origin will not work until that port is free.`
        );
        server.listen(0, '127.0.0.1');
        return;
      }
      reject(err);
    });
    server.listen(desiredPort || 0, '127.0.0.1');
    proxyServer = server;
  });
}

// Reads frontPeek.proxyPort, clamped to a valid TCP port (0 = auto).
function readProxyPort() {
  const raw = vscode.workspace.getConfiguration('frontPeek').get('proxyPort', 0);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

async function resolveSourceLocation(source) {
  if (!source) return null;

  const stacks = source.stacks || (source.stack ? [source.stack] : []);
  log(`Resolving source: component=${source.componentName || '?'} fileName=${source.fileName || '-'} stacks=${stacks.length}`);

  let uri = null;
  let lineNumber = source.lineNumber || 1;
  let columnNumber = source.columnNumber || 1;

  // Path 1: _debugSource (React <= 18) — direct file/line. On Vite the line
  // numbers arrive skewed (see correctDebugSourcePosition); correct them via
  // the served module's source map when possible.
  if (source.fileName) {
    uri = resolveFile(source.fileName);
    if (uri) {
      const corrected = await correctDebugSourcePosition(uri, source);
      if (corrected) {
        lineNumber = corrected.lineNumber;
        columnNumber = corrected.columnNumber;
      }
    }
  }

  // Path 2: _debugStack (React 19 / Next 15+) — resolve the compiled frames
  // back to original sources using the Next dev server's own source map
  // endpoints. Stacks come in order: clicked element first, then the owner
  // chain (the element's own stack may land in node_modules, e.g.
  // next/image — the owner's stack resolves instead).
  for (let i = 0; i < stacks.length && !uri; i++) {
    log(`Trying stack ${i + 1}/${stacks.length}`);
    const resolved = await resolveStack(stacks[i]);
    if (resolved) {
      uri = resolved.uri;
      lineNumber = resolved.lineNumber;
      columnNumber = resolved.columnNumber || 1;
    }
  }

  // No stack resolved to an exact position — fall back to the source file
  // named by Turbopack module-scoped frames (?id=<module id>), if any.
  if (!uri) {
    for (let i = 0; i < stacks.length && !uri; i++) {
      const picked = tryModuleIdFallback(parseStackFrames(stacks[i]));
      if (picked) {
        uri = picked.uri;
        lineNumber = picked.lineNumber;
        columnNumber = picked.columnNumber;
      }
    }
  }

  return uri ? { uri, lineNumber, columnNumber } : null;
}

async function openSource(source) {
  if (!source) {
    warnNotFound('element has no debug info');
    return;
  }

  const loc = await resolveSourceLocation(source);
  if (!loc) {
    warnNotFound(source.componentName || source.fileName || 'unknown');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(loc.uri);

  // The resolved position points straight at the clicked element's JSX
  // inside the component — open exactly there.
  const line = Math.min(Math.max(0, loc.lineNumber - 1), doc.lineCount - 1);
  const col = Math.min(Math.max(0, loc.columnNumber - 1), doc.lineAt(line).text.length);

  log(`Opening ${loc.uri.fsPath}:${line + 1}:${col + 1}`);
  const pos = new vscode.Position(line, col);
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
    selection: new vscode.Range(pos, pos),
  });
}

// ---------------------------------------------------------------------------
// AI mode: build a structured prompt and copy it to the clipboard
// ---------------------------------------------------------------------------

async function handleAiPrompt(payload) {
  const { text, source, element, url } = payload || {};
  if (!text || !text.trim()) return;

  log(`AI prompt received for ${(element && element.selector) || 'unknown element'}`);

  let loc = null;
  try {
    loc = await resolveSourceLocation(source);
  } catch (err) {
    log(`Source resolution failed in AI mode: ${err.message}`);
  }

  const prompt = buildAiPrompt(text.trim(), loc, source, element, url);
  await vscode.env.clipboard.writeText(prompt);
  log('Structured prompt copied to clipboard');

  if (previewView) previewView.webview.postMessage({ type: 'pv-ai-copied', ok: true });
}

function buildAiPrompt(text, loc, source, element, url) {
  const lines = [];
  lines.push(text);
  lines.push('');
  lines.push(
    '- Task: apply the change described above to the exact JSX element below (confirm the target via selector, classes and text; if the line shifted, find the equivalent JSX in the same file)'
  );

  if (loc) {
    const relPath = vscode.workspace.asRelativePath(loc.uri, false);
    lines.push(`- File path: ${relPath}:${loc.lineNumber}:${loc.columnNumber}`);
  } else {
    lines.push('- File path: unresolved — locate via the selector, classes and text below');
  }
  if (source && source.componentName) {
    lines.push(`- Component: ${source.componentName}`);
  }

  try {
    const u = new URL(url);
    const devUrl = currentTargetOrigin
      ? currentTargetOrigin + u.pathname + u.search
      : url;
    lines.push(`- Route: ${u.pathname}${u.search}`);
    lines.push(`- URL: ${devUrl}`);
  } catch {}

  if (element) {
    if (element.tag) lines.push(`- Element: <${element.tag}>`);
    if (element.selector) lines.push(`- CSS Selector: ${element.selector}`);
    if (element.classes) lines.push(`- Classes: ${element.classes}`);
    if (element.text) lines.push(`- Text: "${element.text}"`);
  }

  return lines.join('\n');
}

/**
 * React <= 18 `_debugSource` line numbers can be skewed on Vite:
 * @vitejs/plugin-react prepends its refresh preamble BEFORE the JSX dev
 * transform runs, so the recorded lines include the preamble offset (~20
 * lines). Vite serves each source file as an individual module, which lets
 * us correct the skew: fetch the module, find the jsxDEV source literal
 * carrying these exact coordinates, and map that spot through the module's
 * source map back to the original file. Bundling setups (webpack/Next), where
 * _debugSource is already exact, fail the module fetch and keep the original
 * coordinates.
 */
async function correctDebugSourcePosition(uri, source) {
  if (!currentTargetOrigin || !source.lineNumber || !source.columnNumber) return null;
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel)) return null; // not inside the workspace
  const moduleUrl = `${currentTargetOrigin}/${rel}`;
  try {
    const chunk = await loadRemoteChunk(moduleUrl, new Map());
    if (!chunk.text || !chunk.map) return null;
    const re = new RegExp(
      `lineNumber:\\s*${source.lineNumber},\\s*\\n?\\s*columnNumber:\\s*${source.columnNumber}\\b`
    );
    const m = chunk.text.match(re);
    if (!m) return null;
    const line0 = chunk.text.slice(0, m.index).split('\n').length - 1;
    const orig = lookupInMap(chunk.map, line0, 0);
    if (!orig || !orig.source) return null;
    // only trust the correction when it maps back into the same file
    const abs = resolveAgainstBase(orig.source, moduleUrl);
    const mappedUri =
      (isProjectSource(orig.source) && resolveFile(orig.source)) ||
      (abs && isProjectSource(abs) && resolveFile(abs)) ||
      null;
    if (!mappedUri || mappedUri.fsPath !== uri.fsPath) return null;
    if (orig.line !== source.lineNumber)
      log(
        `  debugSource corrected via module map: ${source.lineNumber}:${source.columnNumber} -> ${orig.line}:${orig.column}`
      );
    return { lineNumber: orig.line, columnNumber: orig.column || source.columnNumber };
  } catch {
    return null;
  }
}

function warnNotFound(detail) {
  log(`FAILED: could not resolve source (${detail})`);
  vscode.window.showWarningMessage(
    `FrontPeek: could not locate the source code (${detail}). See the "FrontPeek" output for details.`
  );
}

/**
 * Resolves an element-creation stack (React 19 `_debugStack`) to the original
 * file/line, delegating source map resolution to the Next dev server (same
 * endpoints its error overlay uses).
 */
async function resolveStack(stackText) {
  const frames = parseStackFrames(stackText);
  log(`Stack parsed into ${frames.length} frames:`);
  for (const f of frames)
    log(`  - [${f.isServer ? 'server' : 'client'}] ${f.methodName} @ ${f.file}:${f.lineNumber}:${f.column}`);
  if (!frames.length) return null;

  // Batch endpoint (Next 15+): resolve all frames in both modes, then pick
  // in stack order, preferring the mode that matches the frame kind
  // (rsc:// => server).
  const passes = {};
  for (const isServer of [false, true]) {
    try {
      passes[isServer] = await fetchOriginalFramesBatch(frames, isServer);
    } catch (err) {
      log(`Batch isServer=${isServer} failed: ${err.message}`);
      passes[isServer] = null;
    }
  }

  for (let i = 0; i < frames.length; i++) {
    const order = frames[i].isServer ? [true, false] : [false, true];
    for (const isServer of order) {
      const results = passes[isServer];
      if (!results || !results[i]) continue;
      const picked = extractResolved(results[i], `frame ${i} isServer=${isServer}`);
      if (picked) return picked;
    }
  }
  log('Batch: no frame resolved to a project file');

  // Fallback: resolve the source maps ourselves when the Next endpoint does
  // not map the frames (some Next 16 builds drop the endpoints; 16.2 has the
  // batch one back with line1/column1 field names). Server frames
  // read the SSR chunk from disk (.next/dev/server/...); client frames —
  // elements rendered by 'use client' components carry browser chunk URLs —
  // fetch the chunk's source map from the dev server over HTTP.
  const picked = await trySourceMaps(frames);
  if (picked) return picked;

  // Legacy endpoint, one frame at a time — only when the batch endpoint does
  // not exist at all (Next 13/14; on Next 16 it responds 404).
  if (passes[false] !== null || passes[true] !== null) return null;

  for (const frame of frames.slice(0, 10)) {
    if (nextEndpointMissing.legacy) break;
    const order = frame.isServer ? [true, false] : [false, true];
    for (const isServer of order) {
      try {
        const result = await fetchOriginalFrameLegacy(frame, isServer);
        const picked = extractResolved(result, `GET ${frame.file}:${frame.lineNumber}`);
        if (picked) return picked;
      } catch (err) {
        log(`Legacy GET (${frame.file}:${frame.lineNumber}) isServer=${isServer} failed: ${err.message}`);
      }
    }
  }

  return null;
}

function parseStackFrames(stackText) {
  const frames = [];
  // The page may report frame URLs under either loopback host, depending on
  // what the browser used to load it — rewrite both back to the real origin.
  const proxyOrigins = currentProxyPort
    ? [`http://${PROXY_HOST}:${currentProxyPort}`, `http://127.0.0.1:${currentProxyPort}`]
    : [];

  for (const line of String(stackText).split('\n')) {
    // Chrome: "    at Name (url:line:col)" or "    at url:line:col"
    let m = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    // Firefox/Safari: "Name@url:line:col"
    if (!m) m = line.match(/^\s*(?:(.+?)@)?(.+?):(\d+):(\d+)\s*$/);
    if (!m) continue;

    let file = m[2];
    if (file === '<anonymous>' || file.startsWith('node:')) continue;

    // Server Component frames come wrapped — rsc://React/Server/<url>?N in
    // older versions, about://React/Server/<url> in React 19.2+. Strip the
    // envelope and mark the frame to be resolved with isServer=true.
    let isServer = false;
    const envelope = file.match(/^(?:rsc|about):\/\/React\/[^/]+\/(.+)$/);
    if (envelope) {
      file = envelope[1];
      isServer = true;
    }
    file = file.replace(/\?\d+$/, '');
    if (/\/\.next\/(dev\/)?server\//.test(decodeSafe(file))) isServer = true;

    // The page runs behind our proxy — restore the real origin so Next can
    // find the chunk/source map.
    if (currentTargetOrigin) {
      const po = proxyOrigins.find((o) => file.startsWith(o));
      if (po) file = currentTargetOrigin + file.slice(po.length);
    }

    // Turbopack module-scoped URLs (modules re-evaluated by HMR) carry the
    // original module id in the query: <chunk>?id=<encoded module id>.
    let moduleId = null;
    const idm = file.match(/[?&]id=([^&]+)/);
    if (idm) moduleId = decodeSafe(idm[1]);

    // For file:// URLs also send extra shapes — the format the Next endpoint
    // accepts varies by version/bundler: the fully decoded URL (module-scoped
    // URLs arrive double-encoded) and the decoded plain path.
    const variants = [file];
    if (file.startsWith('file://')) {
      const decoded = decodeSafe(file);
      if (decoded !== file) variants.push(decoded);
      try {
        variants.push(decodeSafe(new URL(file).pathname));
      } catch {}
    }
    for (const fv of variants) {
      frames.push({
        methodName: m[1] || '<unknown>',
        file: fv,
        arguments: [],
        lineNumber: parseInt(m[3], 10),
        column: parseInt(m[4], 10),
        isServer,
        moduleId,
      });
    }
  }
  return frames;
}

// A Next endpoint is "missing" when it 404s — or when the server answers with
// HTML: SPA dev servers (Vite, CRA) serve index.html as fallback for unknown
// paths, so a 200 text/html is still "this is not a Next server".
function nextEndpointGone(res) {
  return res.status === 404 || (res.headers.get('content-type') || '').includes('text/html');
}

async function fetchOriginalFramesBatch(frames, isServer) {
  if (nextEndpointMissing.batch) throw new Error('endpoint not available (cached)');
  const res = await fetch(`${currentTargetOrigin}/__nextjs_original-stack-frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Next <= 15 reads lineNumber/column; Next 16.2+ reads line1/column1
      // (missing fields make it map position 1:0 and echo the frame back
      // unmapped) — send both shapes.
      frames: frames.map((f) => ({ ...f, line1: f.lineNumber, column1: f.column })),
      isServer,
      isEdgeServer: false,
      isAppDirectory: true,
    }),
  });
  if (nextEndpointGone(res)) {
    nextEndpointMissing.batch = true;
    throw new Error(`not a Next endpoint (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : json.frames || [];
}

async function fetchOriginalFrameLegacy(frame, isServer) {
  if (nextEndpointMissing.legacy) throw new Error('endpoint not available (cached)');
  const qs = new URLSearchParams({
    file: frame.file,
    methodName: frame.methodName,
    lineNumber: String(frame.lineNumber),
    column: String(frame.column),
    isServer: String(isServer),
    isEdgeServer: 'false',
    isAppDirectory: 'true',
  });
  const res = await fetch(`${currentTargetOrigin}/__nextjs_original-stack-frame?${qs}`);
  if (nextEndpointGone(res)) {
    nextEndpointMissing.legacy = true;
    throw new Error(`not a Next endpoint (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function decodeSafe(s) {
  // Turbopack module-scoped URLs arrive percent-encoded more than once
  // (%255B == encoded %5B) — decode until stable.
  let out = String(s);
  for (let i = 0; i < 3; i++) {
    let decoded;
    try {
      decoded = decodeURIComponent(out);
    } catch {
      break;
    }
    if (decoded === out) break;
    out = decoded;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fallback: source map resolution (disk for server chunks, HTTP for client)
// ---------------------------------------------------------------------------

const sourceMapCache = new Map();

async function trySourceMaps(frames) {
  const tried = new Set();
  // per click — client chunks keep the same URL across HMR updates, so a
  // long-lived cache would go stale after an edit
  const remoteCache = new Map();
  for (const frame of frames) {
    let picked = null;
    if (/^https?:\/\//.test(frame.file)) {
      picked = await tryRemoteFrame(frame, tried, remoteCache);
    } else if (frame.file.startsWith('webpack-internal:')) {
      picked = await tryWebpackInternalFrame(frame, tried, remoteCache);
    } else {
      picked = tryDiskFrame(frame, tried);
    }
    if (picked) return picked;
  }
  return null;
}

// Webpack-mode frames name eval'd modules (webpack-internal:///...), which
// are not fetchable over HTTP — but Next's /__nextjs_source-map endpoint
// resolves the module's map straight from the compilation (webpack and
// turbopack middlewares both accept these URLs as `filename`).
async function tryWebpackInternalFrame(frame, tried, cache) {
  if (!currentTargetOrigin || nextEndpointMissing.sourceMap) return null;
  const key = `${frame.file}:${frame.lineNumber}:${frame.column}`;
  if (tried.has(key)) return null;
  tried.add(key);

  let entry = cache.get(frame.file);
  if (!entry) {
    entry = { map: null };
    cache.set(frame.file, entry);
    try {
      const res = await fetch(
        `${currentTargetOrigin}/__nextjs_source-map?filename=${encodeURIComponent(frame.file)}`
      );
      if (nextEndpointGone(res)) nextEndpointMissing.sourceMap = true;
      else if (res.ok) {
        try {
          entry.map = JSON.parse(await res.text());
        } catch {}
      }
    } catch (err) {
      log(`  webpack-internal: GET source map failed: ${err.message}`);
    }
  }
  if (!entry.map) {
    log(`  webpack-internal: no source map for ${frame.file}`);
    return null;
  }
  const label = `webpack-internal: ${frame.file.split('/').pop()}`;
  return pickOriginal(entry.map, frame.lineNumber - 1, frame.column - 1, label, frame.column, frame.file);
}

// Server frames: the compiled SSR chunk sits on disk (.next/dev/server/...)
// with its source map next to it.
function tryDiskFrame(frame, tried) {
  let p = frame.file;
  if (p.startsWith('file://')) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  p = decodeSafe(p);
  const key = `${p}:${frame.lineNumber}:${frame.column}`;
  if (!path.isAbsolute(p) || tried.has(key)) return null;
  tried.add(key);
  if (!fs.existsSync(p)) return null;

  // Module-scoped frames (<chunk>?id=<module>, emitted after HMR re-evals)
  // carry positions relative to the module's code, not the chunk file —
  // shift by the line where the module factory sits in the chunk.
  let line0 = frame.lineNumber - 1;
  if (frame.moduleId) {
    const keyLine0 = findModuleKeyLine(readFileSafe(p), frame.moduleId);
    if (keyLine0 < 0) return null;
    line0 += keyLine0;
  }

  const map = loadSourceMap(p);
  if (!map) return null;
  return pickOriginal(map, line0, frame.column - 1, `local: ${path.basename(p)}`, frame.column, p);
}

// Client frames: elements rendered by 'use client' components carry browser
// chunk URLs (the stack was captured during hydration). The chunk is served
// by the dev server — fetch its source map over HTTP.
async function tryRemoteFrame(frame, tried, cache) {
  const url = frame.file.replace(/\?.*$/, ''); // the chunk lives at the base URL
  // only ever fetch from the dev server, never from third-party origins
  if (!currentTargetOrigin || !url.startsWith(currentTargetOrigin)) return null;
  const key = `${url}:${frame.lineNumber}:${frame.column}:${frame.moduleId || ''}`;
  if (tried.has(key)) return null;
  tried.add(key);

  const chunk = await loadRemoteChunk(url, cache);
  if (!chunk.map) return null;

  let line0 = frame.lineNumber - 1;
  if (frame.moduleId) {
    const keyLine0 = findModuleKeyLine(chunk.text, frame.moduleId);
    if (keyLine0 < 0) return null;
    line0 += keyLine0;
  }
  return pickOriginal(chunk.map, line0, frame.column - 1, `remote: ${url.split('/').pop()}`, frame.column, url);
}

/**
 * Fetches a dev-server chunk and its source map. The map comes from Next's
 * own dev endpoint (/__nextjs_source-map — what the Next 16 error overlay
 * uses; works even when the chunk carries no sourceMappingURL comment), with
 * the chunk's sourceMappingURL as fallback for other setups.
 */
async function loadRemoteChunk(url, cache) {
  if (cache.has(url)) return cache.get(url);
  const entry = { text: null, map: null };
  cache.set(url, entry);

  try {
    const res = await fetch(url);
    if (res.ok) entry.text = await res.text();
    else log(`  remote: GET ${url} -> HTTP ${res.status}`);
  } catch (err) {
    log(`  remote: GET ${url} failed: ${err.message}`);
  }

  if (!nextEndpointMissing.sourceMap) {
    try {
      const res = await fetch(
        `${currentTargetOrigin}/__nextjs_source-map?filename=${encodeURIComponent(url)}`
      );
      if (nextEndpointGone(res)) nextEndpointMissing.sourceMap = true;
      else if (res.ok) {
        try {
          entry.map = JSON.parse(await res.text());
        } catch {}
      }
    } catch {}
  }

  if (!entry.map && entry.text) {
    const matches = [...entry.text.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)];
    const smUrl = matches.length ? matches[matches.length - 1][1] : null;
    try {
      if (smUrl && smUrl.startsWith('data:')) {
        const b64 = smUrl.slice(smUrl.indexOf('base64,') + 7);
        entry.map = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
      } else if (smUrl) {
        const res = await fetch(new URL(smUrl, url).href);
        if (res.ok) entry.map = await res.json();
      }
    } catch (err) {
      log(`  remote: source map ${smUrl}: ${err.message}`);
    }
  }

  if (!entry.map) log(`  remote: no source map for ${url}`);
  return entry;
}

// Shared tail of the fallback: generated position -> original source, keeping
// only project files that exist in the workspace. `base` is where the map was
// found (chunk URL or file path) — per the source map spec, relative sources
// resolve against it (Vite inline maps say just "App.jsx" for /src/App.jsx).
function pickOriginal(map, line0, col0, label, dispColumn, base) {
  const orig = lookupInMap(map, line0, col0);
  if (!orig || !orig.source) return null;
  let uri = null;
  // Webpack module maps name their sources as pseudo-URLs
  // (webpack://_N_E/./src/x.tsx) — normalize before judging, the position is
  // already properly mapped here.
  const src = stripBundlerPrefix(orig.source);
  if (isProjectSource(src)) uri = resolveFile(src);
  if (!uri && base) {
    const abs = resolveAgainstBase(orig.source, base);
    if (abs && isProjectSource(abs)) uri = resolveFile(abs);
  }
  if (!uri) {
    log(`  ${label}: mapped to ${orig.source}, but the file was not found in the workspace`);
    return null;
  }
  log(`  ${label}:${line0 + 1}:${dispColumn} -> ${orig.source}:${orig.line}:${orig.column}`);
  return { uri, lineNumber: orig.line || 1, columnNumber: orig.column || 1 };
}

// Resolves a source-map `sources` entry against the map's location: an
// http(s)/file URL for remote chunks, a filesystem path for disk chunks.
function resolveAgainstBase(source, base) {
  if (/^(webpack|turbopack|rsc|about):/.test(source)) return null; // bundler pseudo-URLs, not relative
  try {
    if (/^https?:\/\//.test(base) || base.startsWith('file://')) {
      const u = new URL(source, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return null;
      return decodeSafe(u.pathname);
    }
    if (path.isAbsolute(base)) return path.resolve(path.dirname(base), source);
  } catch {}
  return null;
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Finds the 0-based line where a module's factory is defined inside a
 * Turbopack chunk's source — chunks list factories keyed by the quoted
 * module id at the start of a line:
 *   "[project]/src/components/X/X.tsx [app-rsc] (ecmascript)", ((ctx) => {
 * Module ids extracted from URLs may carry '+' where the real id has spaces.
 * Returns -1 when not found.
 */
function findModuleKeyLine(js, moduleId) {
  if (js == null) return -1;
  const needles = [moduleId, moduleId.replace(/\+/g, ' ')].map(
    (id) => JSON.stringify(id) + ','
  );
  const lines = js.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const needle of needles) {
      if (lines[i].startsWith(needle)) return i;
    }
  }
  return -1;
}

/**
 * Last resort for Turbopack module-scoped frames (<chunk>?id=<module id>):
 * the id itself names the original source file, e.g.
 * "[project]/src/components/X/X.tsx [app-rsc] (ecmascript)" — a file-level
 * match with no line info, but far better than failing entirely.
 */
function tryModuleIdFallback(frames) {
  for (const frame of frames) {
    if (!frame.moduleId) continue;
    // Spaces in the id may arrive as '+'; cut at the " [layer]" suffix.
    const modPath = frame.moduleId.split(/[+ ]\[/)[0];
    if (!modPath || !isProjectSource(modPath)) continue;
    const uri = resolveFile(modPath);
    if (!uri) continue;
    log(`  module-id: ${frame.moduleId} -> ${modPath} (file-level match)`);
    return { uri, lineNumber: 1, columnNumber: 1 };
  }
  return null;
}

function loadSourceMap(absJsPath) {
  let cacheKey = absJsPath;
  try {
    cacheKey += ':' + fs.statSync(absJsPath).mtimeMs;
  } catch {}
  if (sourceMapCache.has(cacheKey)) return sourceMapCache.get(cacheKey);

  let map = null;
  try {
    const js = fs.readFileSync(absJsPath, 'utf8');
    const matches = [...js.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)];
    const url = matches.length ? matches[matches.length - 1][1] : null;
    if (url && url.startsWith('data:')) {
      const b64 = url.slice(url.indexOf('base64,') + 7);
      map = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } else if (url) {
      const mapPath = path.resolve(path.dirname(absJsPath), decodeSafe(url));
      if (fs.existsSync(mapPath)) map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    } else if (fs.existsSync(absJsPath + '.map')) {
      map = JSON.parse(fs.readFileSync(absJsPath + '.map', 'utf8'));
    }
  } catch (err) {
    log(`  source map for ${absJsPath}: ${err.message}`);
  }
  sourceMapCache.set(cacheKey, map);
  return map;
}

// Finds the original position for a generated (line, column) — both 0-based.
// Supports index maps ("sections", Turbopack's format) recursively.
function lookupInMap(map, line0, col0) {
  if (map.sections) {
    let best = null;
    for (const s of map.sections) {
      const o = s.offset;
      if (o.line < line0 || (o.line === line0 && o.column <= col0)) best = s;
      else break;
    }
    if (!best) return null;
    const rl = line0 - best.offset.line;
    const rc = line0 === best.offset.line ? col0 - best.offset.column : col0;
    return lookupInMap(best.map, rl, rc);
  }

  if (!map.mappings || !map.sources) return null;
  const lines = map.mappings.split(';');
  if (line0 >= lines.length) return null;

  let srcIdx = 0;
  let origLine = 0;
  let origCol = 0;
  let best = null;
  let firstOnLine = null;

  for (let l = 0; l <= line0; l++) {
    let genCol = 0;
    if (!lines[l]) continue;
    for (const seg of lines[l].split(',')) {
      if (!seg) continue;
      const v = decodeVLQSegment(seg);
      if (!v.length) continue;
      genCol += v[0];
      if (v.length >= 4) {
        srcIdx += v[1];
        origLine += v[2];
        origCol += v[3];
        if (l === line0) {
          const hit = {
            source: (map.sourceRoot || '') + (map.sources[srcIdx] || ''),
            line: origLine + 1,
            column: origCol + 1,
          };
          if (!firstOnLine) firstOnLine = hit;
          if (genCol <= col0) best = hit;
        }
      }
    }
  }
  return best || firstOnLine;
}

const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeVLQSegment(seg) {
  const vals = [];
  let shift = 0;
  let value = 0;
  for (const ch of seg) {
    const d = VLQ_CHARS.indexOf(ch);
    if (d === -1) return vals;
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
    } else {
      const neg = value & 1;
      value >>>= 1;
      vals.push(neg ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return vals;
}

/**
 * Only accepts results pointing at project source code. When Next cannot map
 * a frame it echoes back the compiled chunk path (.next/...) — that counts
 * as a failure, not a result.
 */
function isProjectSource(file) {
  if (!file) return false;
  if (file.includes('node_modules')) return false;
  if (/(^|[/\\])\.next[/\\]/.test(file)) return false;
  if (file.includes('[root-of-the-server]') || file.includes('[turbopack]')) return false;
  if (file.startsWith('webpack-internal:') || file.startsWith('webpack:')) return false;
  return true;
}

function extractResolved(result, label) {
  if (result && result.status === 'rejected') {
    log(`  ${label}: rejected by Next (${JSON.stringify(result.reason || null)})`);
    return null;
  }
  const value = result.value || result; // allSettled shape ({status, value}) or plain
  const osf = value && value.originalStackFrame;
  if (!osf || !osf.file) return null;
  if (value.sourcePackage) {
    log(`  ${label}: ignored (package ${value.sourcePackage})`);
    return null;
  }
  if (!isProjectSource(osf.file)) {
    log(`  ${label}: ignored (not project source: ${osf.file})`);
    return null;
  }
  const uri = resolveFile(osf.file);
  if (!uri) {
    log(`  ${label}: resolved to ${osf.file}, but the file does not exist in the workspace`);
    return null;
  }
  // Next <= 15 responds with lineNumber/column, Next 16.2+ with line1/column1.
  const lineNumber = osf.lineNumber ?? osf.line1;
  const columnNumber = osf.column ?? osf.column1;
  log(`  ${label}: resolved ${osf.file}:${lineNumber} -> ${uri.fsPath}`);
  return { uri, lineNumber: lineNumber || 1, columnNumber: columnNumber || 1 };
}

// Normalizes the various webpack/turbopack/RSC path formats, e.g.:
//   webpack-internal:///(app-pages-browser)/./src/components/Card.tsx
//   webpack://_N_E/./src/components/Card.tsx
//   turbopack://[project]/src/app/page.tsx
//   rsc://React/Server/file:///Users/x/proj/src/app/page.tsx?42
//   [project]/src/app/page.tsx
//   ./src/app/page.tsx
function stripBundlerPrefix(fileName) {
  return String(fileName)
    .replace(/^rsc:\/\/React\/[^/]+\//, '')
    .replace(/\?\d+$/, '')
    .replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, '')
    .replace(/^webpack:\/\/[^/]+\/(\([^)]*\)\/)?/, '')
    .replace(/^turbopack:\/\/\[project\]\//, '')
    .replace(/^\[project\]\//, '')
    .replace(/^file:\/\//, '')
    .replace(/^\.\//, '');
}

function resolveFile(fileName) {
  if (!fileName) return null;

  let file = stripBundlerPrefix(fileName);

  // never open a compiled artifact
  if (/(^|[/\\])\.next[/\\]/.test(file)) return null;

  if (path.isAbsolute(file) && fs.existsSync(file)) {
    return vscode.Uri.file(file);
  }

  const ws = vscode.workspace.workspaceFolders;
  if (ws) {
    for (const folder of ws) {
      const candidate = path.join(folder.uri.fsPath, file);
      if (fs.existsSync(candidate)) return vscode.Uri.file(candidate);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Webview
// ---------------------------------------------------------------------------

function getWebviewHtml(proxyPort, targetOrigin, initialPath) {
  // URL API percent-encodes quotes/angle brackets, so the path is safe to
  // interpolate into the HTML below.
  const startPath = initialPath || '/';
  const frameSrc = `${proxyOriginFor(proxyPort)}${startPath}`;
  // The iframe navigates through the local proxy, but the address bar shows
  // the origin the user actually connected to.
  const displayOrigin = targetOrigin || proxyOriginFor(proxyPort);
  const nonce = Math.random().toString(36).slice(2);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:* ${displayOrigin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
    }
    body { display: flex; flex-direction: column; }
    iframe {
      flex: 1; width: 100%; border: none; background: #fff;
    }
    #toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 10px;
      background: var(--vscode-editorWidget-background, #252526);
      border-top: 1px solid var(--vscode-editorWidget-border, #454545);
      flex-shrink: 0;
    }
    #toolbar button {
      display: flex; align-items: center; justify-content: center; gap: 5px;
      min-width: 30px; height: 30px; padding: 0 9px;
      background: transparent; border: 1px solid transparent; border-radius: 5px;
      color: var(--vscode-foreground, #ccc); cursor: pointer;
      font-family: var(--vscode-font-family, sans-serif); font-size: 12px;
    }
    #toolbar button:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }
    #toolbar button.active {
      background: #2f81f7; color: #fff; border-color: #2f81f7;
    }
    #ai.active {
      background: linear-gradient(135deg, #7c3aed, #4f46e5); border-color: transparent;
    }
    #addr {
      flex: 1; min-width: 0;
      display: flex; align-items: center;
      height: 30px; padding: 0 9px;
      border: 1px solid transparent; border-radius: 5px;
      font-family: var(--vscode-font-family, sans-serif); font-size: 12px;
    }
    #addr:hover, #addr:focus-within {
      background: var(--vscode-input-background, #3c3c3c);
    }
    #addr:focus-within {
      border-color: var(--vscode-focusBorder, #2f81f7);
    }
    #base {
      color: var(--vscode-descriptionForeground, #999);
      white-space: nowrap; user-select: none;
      cursor: pointer;
    }
    #base:hover {
      text-decoration: underline;
      color: var(--vscode-foreground, #ccc);
    }
    #route, #base-input {
      flex: 1; min-width: 0; padding: 0; margin: 0;
      background: transparent; border: none; outline: none;
      color: var(--vscode-foreground, #ccc);
      font-family: inherit; font-size: inherit;
    }
    #base-input { display: none; }
  </style>
</head>
<body>
  <iframe id="frame" src="${frameSrc}"></iframe>
  <div id="toolbar">
    <button id="edit" title="Edit: click an element to open its source code">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M12.146 1.146a2.05 2.05 0 0 1 2.9 2.9l-.83.83-2.9-2.9.83-.83zM10.61 2.68l2.9 2.9-7.79 7.79a1 1 0 0 1-.44.256l-3.1.886a.5.5 0 0 1-.618-.618l.886-3.1a1 1 0 0 1 .256-.44l7.906-7.674z"/>
      </svg>
      <span>Edit</span>
    </button>
    <button id="ai" title="AI: click an element and describe the change">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1l1.8 4.2L14 7l-4.2 1.8L8 13 6.2 8.8 2 7l4.2-1.8L8 1z"/>
        <path d="M13 10l.9 2.1L16 13l-2.1.9L13 16l-.9-2.1L10 13l2.1-.9L13 10z"/>
      </svg>
      <span>Prompt</span>
    </button>
    <button id="reload" title="Reload page">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/>
      </svg>
    </button>
    <div id="addr" title="Current route — edit and press Enter to navigate">
      <span id="base" title="Click to change the dev server URL">${displayOrigin}</span><input id="base-input" spellcheck="false" autocomplete="off" /><input id="route" value="${startPath}" spellcheck="false" autocomplete="off" />
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const iframe = document.getElementById('frame');
    const editBtn = document.getElementById('edit');
    const aiBtn = document.getElementById('ai');
    const reloadBtn = document.getElementById('reload');
    const routeInput = document.getElementById('route');
    const baseSpan = document.getElementById('base');
    const baseInput = document.getElementById('base-input');
    const baseOrigin = ${JSON.stringify(proxyOriginFor(proxyPort))};
    const displayOrigin = ${JSON.stringify(displayOrigin)};
    let mode = null; // null | 'edit' | 'ai'
    let currentRoute = ${JSON.stringify(startPath)}; // reported by the inspector inside the iframe

    function sendInspectState() {
      iframe.contentWindow.postMessage(
        { type: 'pv-set-inspect', enabled: !!mode, mode: mode },
        '*'
      );
    }

    function applyMode(m) {
      mode = mode === m ? null : m;
      editBtn.classList.toggle('active', mode === 'edit');
      aiBtn.classList.toggle('active', mode === 'ai');
      sendInspectState();
    }

    editBtn.addEventListener('click', () => applyMode('edit'));
    aiBtn.addEventListener('click', () => applyMode('ai'));

    function setRoute(route) {
      currentRoute = route || '/';
      // don't clobber the user's typing mid-edit
      if (document.activeElement !== routeInput) routeInput.value = currentRoute;
    }

    routeInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep Esc from deselecting the active tool
      if (e.key === 'Enter') {
        let route = routeInput.value.trim() || '/';
        if (route[0] !== '/') route = '/' + route;
        currentRoute = route; // optimistic; the inspector confirms on load
        routeInput.value = route;
        iframe.src = baseOrigin + route;
        routeInput.blur();
      } else if (e.key === 'Escape') {
        routeInput.value = currentRoute;
        routeInput.blur();
      }
    });
    routeInput.addEventListener('blur', () => {
      routeInput.value = currentRoute;
    });

    // Clicking the base origin swaps the address bar for a single input with
    // the full URL — Enter reconnects the extension to the new dev server
    // (which restarts the proxy and re-renders this webview).
    baseSpan.addEventListener('click', () => {
      baseSpan.style.display = 'none';
      routeInput.style.display = 'none';
      baseInput.style.display = 'block';
      baseInput.value = displayOrigin + currentRoute;
      baseInput.focus();
      baseInput.select();
    });

    function closeBaseEdit() {
      baseInput.style.display = 'none';
      baseSpan.style.display = '';
      routeInput.style.display = '';
    }

    baseInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep Esc from deselecting the active tool
      if (e.key === 'Enter') {
        let url = baseInput.value.trim();
        if (!url || url === displayOrigin + currentRoute) return closeBaseEdit();
        if (!/^https?:\\/\\//i.test(url)) url = 'http://' + url;
        vscode.postMessage({ type: 'connect', url: url });
        // on success the extension replaces this whole webview; on error
        // (invalid URL) it shows a message and we fall back to display mode
        closeBaseEdit();
      } else if (e.key === 'Escape') {
        closeBaseEdit();
      }
    });
    baseInput.addEventListener('blur', closeBaseEdit);

    // Esc with focus on the webview itself (e.g. right after clicking the
    // button) also deselects the active tool. applyMode(null) always
    // resolves to "no mode", whatever the current one is.
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && mode) applyMode(null);
    });

    reloadBtn.addEventListener('click', () => {
      // iframe.src goes stale after client-side navigation — reload the
      // route the inspector last reported instead.
      iframe.src = baseOrigin + currentRoute;
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || !msg.type) return;
      if (msg.type === 'pv-ready') {
        // page (re)loaded — resync the inspector state
        sendInspectState();
      } else if (msg.type === 'pv-route') {
        setRoute(msg.route);
      } else if (msg.type === 'pv-open-source') {
        vscode.postMessage({ type: 'open-source', source: msg.source, debug: msg.debug });
      } else if (msg.type === 'pv-ai-prompt') {
        vscode.postMessage({ type: 'ai-prompt', payload: msg.payload, debug: msg.debug });
      } else if (msg.type === 'pv-exit-inspect') {
        // Esc pressed inside the page — deselect the tool in the toolbar
        if (mode) applyMode(null);
      } else if (msg.type === 'pv-ai-copied') {
        // from the extension — forward to the inspector inside the iframe
        iframe.contentWindow.postMessage(msg, '*');
      }
    });
  </script>
</body>
</html>`;
}

// Shown in the preview view when no dev server is connected yet: asks for
// the dev server URL and loads the preview in place.
function getPlaceholderHtml() {
  const nonce = Math.random().toString(36).slice(2);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    body {
      margin: 0; padding: 14px 16px;
      font-family: var(--vscode-font-family, sans-serif);
      color: var(--vscode-foreground, #ccc);
    }
    p {
      font-size: 12px; color: var(--vscode-descriptionForeground, #999);
      margin: 0 0 12px;
    }
    label { display: block; font-size: 11px; margin-bottom: 4px; }
    input {
      width: 100%; box-sizing: border-box; margin-bottom: 10px;
      padding: 5px 8px; border-radius: 3px; font-size: 13px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, transparent);
    }
    input:focus { outline: 1px solid var(--vscode-focusBorder, #2f81f7); }
    button {
      width: 100%; padding: 6px 14px; border: none; border-radius: 4px;
      cursor: pointer; font-size: 13px;
      background: var(--vscode-button-background, #2f81f7);
      color: var(--vscode-button-foreground, #fff);
    }
    button:hover { background: var(--vscode-button-hoverBackground, #1f6feb); }
  </style>
</head>
<body>
  <p>Preview your React or Next.js app with a component inspector.</p>
  <label for="url">Dev server URL</label>
  <input id="url" type="text" value="http://localhost:3000" spellcheck="false" />
  <button id="open">Open Preview</button>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const url = document.getElementById('url');
    function open() {
      vscode.postMessage({ type: 'connect', url: url.value.trim() });
    }
    document.getElementById('open').addEventListener('click', open);
    url.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') open();
    });
  </script>
</body>
</html>`;
}

// Shown (briefly) in the activity bar launcher view while it redirects to
// the preview in the secondary sidebar.
function getRedirectHtml() {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
  <style>
    body {
      margin: 0; padding: 14px 16px;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px; color: var(--vscode-descriptionForeground, #999);
    }
  </style>
</head>
<body>Opening preview in the right sidebar…</body>
</html>`;
}

function deactivate() {
  if (proxyServer) proxyServer.close();
}

module.exports = { activate, deactivate };
