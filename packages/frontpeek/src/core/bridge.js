// Talks to the FrontPeek VS Code extension when it is running. The extension
// listens on a fixed loopback port (default 57420) and speaks the same tiny
// HTTP/SSE protocol the old in-extension toolbar used:
//   - GET  /events  → SSE; a successful connection means "extension present"
//   - POST /msg     → deliver an { type: 'open-file', ... } message
//
// When nothing is listening (no extension, or an https page where the browser
// blocks the mixed-content request) the connection just never opens and the
// toolbar stays in standalone / clipboard mode.

export function createBridge(port) {
  const origin = 'http://localhost:' + port;
  let connected = false;
  let es = null;
  let onStatus = null;

  function setConnected(v) {
    if (v === connected) return;
    connected = v;
    if (onStatus) onStatus(connected);
  }

  function connect(statusCb) {
    onStatus = statusCb;
    if (typeof EventSource === 'undefined') return;
    try {
      es = new EventSource(origin + '/events');
    } catch (_) {
      return;
    }
    es.onopen = function () { setConnected(true); };
    es.onerror = function () {
      // EventSource auto-reconnects; reflect the current gap as disconnected.
      setConnected(false);
    };
  }

  // text/plain keeps this a CORS "simple request" (no preflight); the extension
  // responds with Access-Control-Allow-Origin:* and guards writes by Origin.
  function openFile(loc) {
    if (!loc || !loc.file) return;
    try {
      fetch(origin + '/msg', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          type: 'open-file',
          file: loc.file,
          line: loc.line || 1,
          column: loc.column || 1,
          origin: location.origin,
        }),
        keepalive: true,
      }).catch(function () {});
    } catch (_) {}
  }

  function isConnected() { return connected; }

  function destroy() {
    onStatus = null;
    if (es) { try { es.close(); } catch (_) {} es = null; }
    connected = false;
  }

  return { connect, openFile, isConnected, destroy };
}
