// Browser-side source resolution. Turns the inspector's `source` object
// (React fiber walk output) into a project file path + line/column.
//
// This is a browser port of the extension's Node resolver. The heavy lifting —
// asking the dev server to map a compiled stack frame back to the original
// source — is pure `fetch` against the app's OWN origin, so it runs identically
// here. What DOESN'T port is the filesystem work (reading on-disk SSR chunks,
// grepping the workspace for a component definition); those Node-only fallbacks
// are simply skipped, and we degrade to copying the component name.
//
// Output shape: { file, line, column } where `file` is a cleaned, usually
// project-relative path string — or null when nothing resolved.

// Some Next dev servers drop these endpoints; remember a 404 so every click
// doesn't re-probe before falling back to raw source maps.
const missing = { batch: false, legacy: false, sourceMap: false };

function targetOrigin() {
  return location.origin;
}

export async function resolve(source) {
  if (!source) return null;

  // Path 1: _debugSource (React <= 18 / Vite) — direct file/line.
  if (source.fileName) {
    return {
      file: stripBundlerPrefix(source.fileName),
      line: source.lineNumber || 1,
      column: source.columnNumber || 1,
    };
  }

  // Path 2: _debugStack (React 19 / Next 15+) — resolve compiled frames back
  // to original sources. Stacks come clicked-element-first, then owner chain.
  const stacks = source.stacks || (source.stack ? [source.stack] : []);
  for (let i = 0; i < stacks.length; i++) {
    const resolved = await resolveStack(stacks[i]);
    if (resolved) return resolved;
  }

  // Path 2 tail: Turbopack module-scoped frames name the source in ?id=<module>.
  for (let i = 0; i < stacks.length; i++) {
    const picked = tryModuleIdFallback(parseStackFrames(stacks[i]));
    if (picked) return picked;
  }

  // Nothing mapped to a file. The extension would grep the workspace by
  // component name here — not possible in the browser. Signal the name so the
  // caller can still copy something meaningful.
  return source.componentName ? { componentName: source.componentName } : null;
}

// ---------------------------------------------------------------------------
// Stack → original source, via the Next dev server's own endpoints
// ---------------------------------------------------------------------------

async function resolveStack(stackText) {
  const frames = parseStackFrames(stackText);
  if (!frames.length) return null;

  // Batch endpoint (Next 15+): resolve in both server/client modes, then pick
  // in stack order preferring the mode that matches the frame kind.
  const passes = {};
  for (const isServer of [false, true]) {
    try {
      passes[isServer] = await fetchOriginalFramesBatch(frames, isServer);
    } catch (_) {
      passes[isServer] = null;
    }
  }

  for (let i = 0; i < frames.length; i++) {
    const order = frames[i].isServer ? [true, false] : [false, true];
    for (const isServer of order) {
      const results = passes[isServer];
      if (!results || !results[i]) continue;
      const picked = extractResolved(results[i]);
      if (picked) return picked;
    }
  }

  // Fallback: resolve source maps ourselves (client chunks only — no disk).
  const picked = await trySourceMaps(frames);
  if (picked) return picked;

  // Legacy endpoint (Next 13/14), only if the batch one doesn't exist at all.
  if (passes[false] !== null || passes[true] !== null) return null;
  for (const frame of frames.slice(0, 10)) {
    if (missing.legacy) break;
    const order = frame.isServer ? [true, false] : [false, true];
    for (const isServer of order) {
      try {
        const result = await fetchOriginalFrameLegacy(frame, isServer);
        const picked2 = extractResolved(result);
        if (picked2) return picked2;
      } catch (_) {}
    }
  }
  return null;
}

function parseStackFrames(stackText) {
  const frames = [];
  for (const line of String(stackText).split('\n')) {
    // Chrome: "    at Name (url:line:col)" or "    at url:line:col"
    let m = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    // Firefox/Safari: "Name@url:line:col"
    if (!m) m = line.match(/^\s*(?:(.+?)@)?(.+?):(\d+):(\d+)\s*$/);
    if (!m) continue;

    let file = m[2];
    if (file === '<anonymous>' || file.startsWith('node:')) continue;

    // Server Component frames come wrapped: rsc://React/Server/<url>?N (older)
    // or about://React/Server/<url> (React 19.2+). Strip the envelope.
    let isServer = false;
    const envelope = file.match(/^(?:rsc|about):\/\/React\/[^/]+\/(.+)$/);
    if (envelope) {
      file = envelope[1];
      isServer = true;
    }
    file = file.replace(/\?\d+$/, '');
    if (/\/\.next\/(dev\/)?server\//.test(decodeSafe(file))) isServer = true;

    // Turbopack module-scoped URLs carry the module id in the query.
    let moduleId = null;
    const idm = file.match(/[?&]id=([^&]+)/);
    if (idm) moduleId = decodeSafe(idm[1]);

    // file:// URLs: also send decoded shapes the Next endpoint may prefer.
    const variants = [file];
    if (file.startsWith('file://')) {
      const decoded = decodeSafe(file);
      if (decoded !== file) variants.push(decoded);
      try {
        variants.push(decodeSafe(new URL(file).pathname));
      } catch (_) {}
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

// A Next endpoint is "missing" when it 404s — or answers with HTML (SPA dev
// servers serve index.html as a catch-all, so a 200 text/html is not Next).
function nextEndpointGone(res) {
  return res.status === 404 || (res.headers.get('content-type') || '').includes('text/html');
}

async function fetchOriginalFramesBatch(frames, isServer) {
  if (missing.batch) throw new Error('endpoint not available (cached)');
  const res = await fetch(`${targetOrigin()}/__nextjs_original-stack-frames`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // Next <= 15 reads lineNumber/column; Next 16.2+ reads line1/column1.
      frames: frames.map((f) => ({ ...f, line1: f.lineNumber, column1: f.column })),
      isServer,
      isEdgeServer: false,
      isAppDirectory: true,
    }),
  });
  if (nextEndpointGone(res)) {
    missing.batch = true;
    throw new Error(`not a Next endpoint (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : json.frames || [];
}

async function fetchOriginalFrameLegacy(frame, isServer) {
  if (missing.legacy) throw new Error('endpoint not available (cached)');
  const qs = new URLSearchParams({
    file: frame.file,
    methodName: frame.methodName,
    lineNumber: String(frame.lineNumber),
    column: String(frame.column),
    isServer: String(isServer),
    isEdgeServer: 'false',
    isAppDirectory: 'true',
  });
  const res = await fetch(`${targetOrigin()}/__nextjs_original-stack-frame?${qs}`);
  if (nextEndpointGone(res)) {
    missing.legacy = true;
    throw new Error(`not a Next endpoint (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function extractResolved(result) {
  if (result && result.status === 'rejected') return null;
  const value = (result && result.value) || result; // allSettled shape or plain
  const osf = value && value.originalStackFrame;
  if (!osf || !osf.file) return null;
  if (value.sourcePackage) return null;
  if (!isProjectSource(osf.file)) return null;
  // Next <= 15 responds with lineNumber/column, Next 16.2+ with line1/column1.
  const line = osf.lineNumber ?? osf.line1;
  const column = osf.column ?? osf.column1;
  return { file: stripBundlerPrefix(osf.file), line: line || 1, column: column || 1 };
}

// ---------------------------------------------------------------------------
// Fallback: resolve client source maps ourselves (fetch-only; no disk)
// ---------------------------------------------------------------------------

async function trySourceMaps(frames) {
  const tried = new Set();
  const remoteCache = new Map(); // per click — chunk URLs are stable across HMR
  for (const frame of frames) {
    let picked = null;
    if (/^https?:\/\//.test(frame.file)) {
      picked = await tryRemoteFrame(frame, tried, remoteCache);
    } else if (frame.file.startsWith('webpack-internal:')) {
      picked = await tryWebpackInternalFrame(frame, tried, remoteCache);
    }
    // Disk frames (file:// / absolute SSR chunks) are not reachable here.
    if (picked) return picked;
  }
  return null;
}

async function tryWebpackInternalFrame(frame, tried, cache) {
  if (missing.sourceMap) return null;
  const key = `${frame.file}:${frame.lineNumber}:${frame.column}`;
  if (tried.has(key)) return null;
  tried.add(key);

  let entry = cache.get(frame.file);
  if (!entry) {
    entry = { map: null };
    cache.set(frame.file, entry);
    try {
      const res = await fetch(
        `${targetOrigin()}/__nextjs_source-map?filename=${encodeURIComponent(frame.file)}`
      );
      if (nextEndpointGone(res)) missing.sourceMap = true;
      else if (res.ok) {
        try { entry.map = JSON.parse(await res.text()); } catch (_) {}
      }
    } catch (_) {}
  }
  if (!entry.map) return null;
  return pickOriginal(entry.map, frame.lineNumber - 1, frame.column - 1, frame.file);
}

async function tryRemoteFrame(frame, tried, cache) {
  const url = frame.file.replace(/\?.*$/, ''); // the chunk lives at the base URL
  if (!url.startsWith(targetOrigin())) return null; // only ever the dev server
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
  return pickOriginal(chunk.map, line0, frame.column - 1, url);
}

async function loadRemoteChunk(url, cache) {
  if (cache.has(url)) return cache.get(url);
  const entry = { text: null, map: null };
  cache.set(url, entry);

  try {
    const res = await fetch(url);
    if (res.ok) entry.text = await res.text();
  } catch (_) {}

  if (!missing.sourceMap) {
    try {
      const res = await fetch(
        `${targetOrigin()}/__nextjs_source-map?filename=${encodeURIComponent(url)}`
      );
      if (nextEndpointGone(res)) missing.sourceMap = true;
      else if (res.ok) {
        try { entry.map = JSON.parse(await res.text()); } catch (_) {}
      }
    } catch (_) {}
  }

  if (!entry.map && entry.text) {
    const matches = [...entry.text.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)];
    const smUrl = matches.length ? matches[matches.length - 1][1] : null;
    try {
      if (smUrl && smUrl.startsWith('data:')) {
        const b64 = smUrl.slice(smUrl.indexOf('base64,') + 7);
        entry.map = JSON.parse(decodeBase64(b64));
      } else if (smUrl) {
        const res = await fetch(new URL(smUrl, url).href);
        if (res.ok) entry.map = await res.json();
      }
    } catch (_) {}
  }
  return entry;
}

// Generated position -> original source; keep only project files. `base` is
// where the map was found (chunk URL); relative `sources` resolve against it.
function pickOriginal(map, line0, col0, base) {
  const orig = lookupInMap(map, line0, col0);
  if (!orig || !orig.source) return null;
  const src = stripBundlerPrefix(orig.source);
  if (isProjectSource(src)) {
    return { file: src, line: orig.line || 1, column: orig.column || 1 };
  }
  const abs = resolveAgainstBase(orig.source, base);
  if (abs && isProjectSource(abs)) {
    return { file: stripBundlerPrefix(abs), line: orig.line || 1, column: orig.column || 1 };
  }
  return null;
}

// Resolves a source-map `sources` entry against the chunk URL it came from.
function resolveAgainstBase(source, base) {
  if (/^(webpack|turbopack|rsc|about):/.test(source)) return null; // pseudo-URLs
  try {
    if (/^https?:\/\//.test(base) || base.startsWith('file://')) {
      const u = new URL(source, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return null;
      return decodeSafe(u.pathname);
    }
  } catch (_) {}
  return null;
}

// Turbopack chunks list module factories keyed by the quoted module id at the
// start of a line. Returns the 0-based line, or -1.
function findModuleKeyLine(js, moduleId) {
  if (js == null) return -1;
  const needles = [moduleId, moduleId.replace(/\+/g, ' ')].map((id) => JSON.stringify(id) + ',');
  const lines = js.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const needle of needles) {
      if (lines[i].startsWith(needle)) return i;
    }
  }
  return -1;
}

// Last resort for Turbopack module-scoped frames: the id itself names the file.
function tryModuleIdFallback(frames) {
  for (const frame of frames) {
    if (!frame.moduleId) continue;
    const modPath = frame.moduleId.split(/[+ ]\[/)[0];
    if (!modPath || !isProjectSource(modPath)) continue;
    return { file: stripBundlerPrefix(modPath), line: 1, column: 1 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure source-map decoding (index maps supported) — portable, no I/O
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function isProjectSource(file) {
  if (!file) return false;
  if (file.includes('node_modules')) return false;
  if (/(^|[/\\])\.next[/\\]/.test(file)) return false;
  if (file.includes('[root-of-the-server]') || file.includes('[turbopack]')) return false;
  if (file.startsWith('webpack-internal:') || file.startsWith('webpack:')) return false;
  return true;
}

// Normalizes webpack/turbopack/RSC path formats down to a plain path, e.g.
//   webpack-internal:///(app-pages-browser)/./src/components/Card.tsx
//   webpack://_N_E/./src/components/Card.tsx
//   turbopack://[project]/src/app/page.tsx
//   rsc://React/Server/file:///Users/x/proj/src/app/page.tsx?42
//   [project]/src/app/page.tsx  ·  ./src/app/page.tsx
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

function decodeSafe(s) {
  let out = String(s);
  for (let i = 0; i < 3; i++) {
    let decoded;
    try { decoded = decodeURIComponent(out); } catch (_) { break; }
    if (decoded === out) break;
    out = decoded;
  }
  return out;
}

function decodeBase64(b64) {
  // atob → binary string → UTF-8. Handles multibyte chars in inline maps.
  const bin = atob(b64);
  try {
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch (_) {
    return bin;
  }
}
