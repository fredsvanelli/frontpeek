// Orchestrator. Wires the three UI/transport pieces together:
//   toolbar  — the floating footer (emits pv-set-inspect, shows the dot)
//   inspector — click handling in the page (emits pv-open-source / pv-*-prompt)
//   bridge    — optional link to the VS Code extension
//
// It owns the routing the extension's bridge used to do: resolve the clicked
// element's source in the browser, then either hand it to the extension (open
// in the editor) or copy it to the clipboard (standalone).

import { createToolbar } from './toolbar.js';
import { installInspector } from './inspector.js';
import { createBridge } from './bridge.js';
import * as source from './source.js';
import * as clipboard from './clipboard.js';
import { buildAiPrompt, buildCssPrompt } from './prompt.js';

export function mount(options) {
  options = options || {};
  var port = options.bridgePort || 57420;

  var toolbar = createToolbar();
  var inspector = installInspector();
  var bridge = createBridge(port);
  bridge.connect(function (connected) { toolbar.setConnected(connected); });

  async function onMessage(e) {
    var msg = e.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'pv-open-source') {
      var loc = await safeResolve(msg.source);
      if (bridge.isConnected() && loc && loc.file) {
        bridge.openFile(loc);
      } else {
        var res = await clipboard.copyPath(loc || {});
        clipboard.showToast(
          res.path ? 'Component path copied!' : 'Source not found',
          toolbar.el
        );
      }
      return;
    }

    if (msg.type === 'pv-ai-prompt') {
      var p = msg.payload || {};
      var loc2 = await safeResolve(p.source);
      var aiText = buildAiPrompt(p.text || '', loc2, p.source, p.element, p.url);
      await clipboard.write(aiText);
      window.postMessage({ type: 'pv-ai-copied', ok: true }, '*');
      return;
    }

    if (msg.type === 'pv-css-prompt') {
      var pc = msg.payload || {};
      if (!pc.changes || !pc.changes.length) return;
      var loc3 = await safeResolve(pc.source);
      var cssText = buildCssPrompt(pc.changes, loc3, pc.source, pc.element, pc.url);
      await clipboard.write(cssText);
      window.postMessage({ type: 'pv-css-copied', ok: true }, '*');
      return;
    }
  }

  async function safeResolve(src) {
    try {
      return await source.resolve(src);
    } catch (_) {
      return null;
    }
  }

  window.addEventListener('message', onMessage);

  function destroy() {
    window.removeEventListener('message', onMessage);
    bridge.destroy();
    inspector.destroy();
    toolbar.destroy();
    clipboard.destroyToast();
  }

  return { destroy: destroy };
}
