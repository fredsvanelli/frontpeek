// FrontPeek — VS Code companion extension.
//
// One job: run a tiny local bridge so the FrontPeek toolbar (the npm package
// @fredsvanelli/frontpeek, running inside your app in the browser) can open a
// file in this editor when you click its "Code" button.
//
// The toolbar resolves the clicked element's source *in the browser* and sends
// us an already-resolved { file, line, column }. We just map that path to a
// workspace file and open it. No webview, no proxy, no source-map machinery —
// all of that now lives in the browser package.
//
// Protocol (loopback HTTP, CORS-open, Origin-guarded for writes):
//   GET  /events → SSE. A successful connection is how the toolbar detects us.
//   POST /msg    → { type: 'open-file', file, line, column, origin }

const vscode = require('vscode');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');

const BRIDGE_DEFAULT_PORT = 57420;

let bridgeServer = null;
let bridgePort = null;
let output = null;
const sseClients = new Set();

function log(msg) {
  if (output) output.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function activate(context) {
  output = vscode.window.createOutputChannel('FrontPeek');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('frontPeek.showOutput', () => output.show())
  );

  startBridge().catch((err) => log(`Bridge failed to start: ${err.message}`));
}

function deactivate() {
  for (const res of sseClients) {
    try { res.end(); } catch { }
  }
  sseClients.clear();
  if (bridgeServer) {
    try { bridgeServer.close(); } catch { }
    bridgeServer = null;
  }
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

function bridgeOrigin() {
  return `http://localhost:${bridgePort || BRIDGE_DEFAULT_PORT}`;
}

// Only loopback web origins may drive the bridge. With CORS `*` the browser
// will deliver a simple POST from any site, so this server-side Origin check is
// the real guard against a random page you visit poking at your source files.
function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === 'localhost' ||
        u.hostname === '127.0.0.1' ||
        u.hostname === '[::1]' ||
        u.hostname === '::1')
    );
  } catch {
    return false;
  }
}

function startBridge() {
  if (bridgeServer) return Promise.resolve(bridgePort);

  const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
  };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      log(`Toolbar connected (${sseClients.size} open)`);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (url === '/msg' && req.method === 'POST') {
      if (!isLoopbackOrigin(req.headers.origin || '')) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let msg = null;
        try {
          msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400);
          res.end('bad json');
          return;
        }
        handleBridgeMessage(msg).catch((err) => {
          log(`ERROR in bridge message: ${err.stack || err.message}`);
        });
        res.writeHead(204);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end('FrontPeek bridge');
  });

  return new Promise((resolve) => {
    const onListen = () => {
      bridgeServer = server;
      bridgePort = server.address().port;
      log(`Bridge listening on ${bridgeOrigin()}`);
      resolve(bridgePort);
    };
    server.once('error', () => {
      // Default port busy — fall back to a random one. Note: the toolbar probes
      // the fixed default port, so a fallback port means open-in-editor won't be
      // detected until the port is freed. We log it so it's diagnosable.
      log(`Port ${BRIDGE_DEFAULT_PORT} busy; falling back to a random port.`);
      server.listen(0, '127.0.0.1', onListen);
    });
    server.listen(BRIDGE_DEFAULT_PORT, '127.0.0.1', onListen);
  });
}

async function handleBridgeMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'open-file') {
    await openFile(msg);
  }
}

// ---------------------------------------------------------------------------
// Open in editor
// ---------------------------------------------------------------------------

async function openFile(msg) {
  const uri = resolveFile(msg.file);
  if (!uri) {
    warnNotFound(msg.file || 'unknown');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(uri);
  const line = Math.min(Math.max(0, (msg.line || 1) - 1), doc.lineCount - 1);
  const col = Math.min(Math.max(0, (msg.column || 1) - 1), doc.lineAt(line).text.length);

  log(`Opening ${uri.fsPath}:${line + 1}:${col + 1}`);
  const pos = new vscode.Position(line, col);
  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.One,
    preview: false,
    selection: new vscode.Range(pos, pos),
  });
  focusEditorWindow();
}

function warnNotFound(detail) {
  log(`FAILED: could not open source (${detail})`);
  vscode.window.showWarningMessage(
    `FrontPeek: could not locate "${detail}" in the workspace. See the "FrontPeek" output for details.`
  );
}

// Maps a browser-provided source path (already stripped of most bundler
// prefixes, but we normalize again to be safe) to a workspace file URI.
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

// Normalizes the various webpack/turbopack/RSC path formats down to a plain
// path. The toolbar already strips these, but a stray prefix here is harmless.
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

// In real-origin mode the click happens in the browser, so the editor window
// stays in the background. Raise it. macOS uses `open` on the running editor's
// app bundle — editor-agnostic (Code/Insiders/Cursor/VSCodium) and needs no
// Automation (TCC) permission prompt.
function focusEditorWindow() {
  try {
    if (process.platform === 'darwin') {
      const bundle = (process.execPath.match(/^(.*?\.app)(\/|$)/) || [])[1];
      if (bundle) cp.execFile('open', [bundle], () => {});
      else cp.execFile('open', ['-a', vscode.env.appName], () => {});
    } else if (process.platform === 'linux') {
      cp.execFile('wmctrl', ['-a', vscode.env.appName], () => {});
    }
    // Windows blocks cross-process foreground stealing, so we rely on the focus
    // command below there.
  } catch (err) {
    log(`focusEditorWindow failed: ${err.message}`);
  }
  vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

module.exports = { activate, deactivate };
