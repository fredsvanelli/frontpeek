# FrontPeek — moving off the iframe/proxy (real-origin exploration)

Branch: `real-origin-toolbar`

## Why change

Today FrontPeek hosts the app inside a **VS Code webview** and loads it in an
`<iframe>`. The webview's top-level origin is `vscode-webview://…`, so the
iframe is cross-origin and the webview **cannot inject scripts into it**. To get
the inspector into the page, the extension runs a **local HTTP proxy** that
serves the app at `http://localhost:<port>` and injects `inspector.js` +
`tunnel.js` into every HTML response.

That fake origin is the root of every auth problem in the README:

- **Cookies** must be rewritten to `SameSite=None; Secure` and have their
  `Domain` stripped (`rewriteSetCookieForWebview`).
- **CORS-guarded APIs** (Okta, Auth0, custom) reject the proxy origin, so a
  server-side **tunnel** (`/__pv/tunnel`, `media/tunnel.js`) re-issues every
  cross-origin `fetch`/`XHR`/`sendBeacon` with a faked `Origin` and its own
  cookie jar.
- **Next dev-resource protection** blocks the proxy origin, so `Origin`/
  `Referer` are rewritten upstream.
- **OAuth/SSO SPA login can't be made to work at all** without extra setup: the
  hidden-iframe token exchange is a *navigation* validated against the app's
  real, whitelisted origin — it can't be tunneled or faked. The user must pin
  `frontPeek.proxyPort` and whitelist `http://localhost:<port>` at the identity
  provider, and even then it's fragile.

All of this machinery exists **only** to work around one constraint: injecting
into a cross-origin iframe. Remove the iframe and the whole layer disappears.

## The fundamental constraint

A VS Code webview can never show an external site at its **real** origin *and*
let us inject into it:

- The webview's own document is HTML we author; we can't point its top-level
  navigation at `http://localhost:3000`.
- Any external site therefore has to go in an `<iframe>`, which is cross-origin
  → no injection → back to the proxy.
- "Simple Browser" and other webview-based previews have the identical limit.

**So "run the app at its real URL" necessarily means rendering it outside the
webview — in the user's real browser.** There is no webview configuration that
avoids this. The question is only *how the inspector gets into that page* and
*how it talks back to VS Code*.

## Options considered

| Option | Real origin? | OAuth/cookies | Injection path | Verdict |
|---|---|---|---|---|
| **A. Keep webview iframe + proxy** (today) | ❌ fake `localhost:<port>` | needs tunnel + cookie rewrite; OAuth needs whitelisting | proxy rewrites HTML | The status quo we're trying to leave |
| **B. Webview iframe → real origin, no proxy** | ✅ | native | **impossible** — cross-origin, can't inject | Dead end |
| **C. Real browser + injected toolbar/bridge** | ✅ | **all native**, zero config | one-line dev `<script>` loads toolbar+inspector | **Recommended** |
| **D. Real browser + browser extension (CDP)** | ✅ | native | extension injects | Works, but ships/maintains a second artifact and needs install/permissions |
| **E. Framework plugin** (Vite/Next/webpack) | ✅ | native | build-time middleware injects | Cleanest for one framework, but N plugins to maintain; C subsumes it |

Option **C** is exactly the direction in the request: *at runtime, append a div
to the end of the site's `<body>` and render a draggable floating footer
toolbar.* The toolbar and inspector run **in the page**, same-origin, so there's
nothing to tunnel. It's the Vercel-Toolbar / Next-DevTools model.

## Recommended architecture (prototyped on this branch)

```
┌─ user's real browser ──────────────────────────┐        ┌─ VS Code extension ─┐
│  http://localhost:3000  (the real dev app)      │        │                     │
│                                                 │        │   Bridge server     │
│   <script src=".../frontpeek.js" async>         │        │   (http, no deps)   │
│      ├── media/toolbar.js  → floating footer    │        │                     │
│      └── media/inspector.js (unchanged)         │        │   GET /frontpeek.js │
│                                                 │        │   GET /events (SSE) │
│   toolbar ⇄ inspector  via same-window          │        │   POST /msg         │
│                           postMessage           │        │                     │
│   toolbar ── POST /msg  (open-source/ai/css) ──────────► │ openSource / handle │
│   toolbar ◄─ SSE /events (copy acks) ─────────────────── │ AiPrompt / CssPrompt│
└─────────────────────────────────────────────────┘        └─────────────────────┘
```

Key insight that made this small: **`inspector.js` needs no changes.** It
already speaks to its host with `window.parent.postMessage(…)` and
`window.addEventListener('message', …)`. When the page is **not** framed,
`window.parent === window`, so those messages are delivered to same-window
listeners. `media/toolbar.js` is one such listener: it forwards the
extension-bound messages (`pv-open-source`, `pv-ai-prompt`, `pv-css-prompt`)
over the bridge, and posts control/ack messages (`pv-set-inspect`,
`pv-ai-copied`, `pv-css-copied`) back to `window` for the inspector to consume.

The **source-resolution logic also needs no changes**: it already fetches
chunks, source maps and the Next `__nextjs_*` endpoints from the *real*
`currentTargetOrigin`, never from the proxy. The only proxy-coupled line
(`parseStackFrames` remapping proxy-origin chunk URLs) is a natural no-op when
there's no proxy. The bridge just sets `currentTargetOrigin` from the origin the
page reports in each message.

### Transport

Dependency-free, matching the rest of the extension (which hand-rolls its proxy,
tunnel, VLQ decoder and cookie jar rather than pulling in npm):

- **page → extension**: `fetch` `POST /msg` with `text/plain` (a CORS "simple
  request", so no preflight). Body carries the message + the page's real
  `origin`.
- **extension → page**: **SSE** (`EventSource` on `GET /events`) for copy acks.
  Built into browsers; server side is just `text/event-stream` + `data:` lines.
- No raw WebSocket framing needed.

### Security

`POST /msg` only acts on requests whose `Origin` header is a **loopback** web
origin. With `Access-Control-Allow-Origin: *`, the browser will *deliver* a
simple POST from any site you visit, so this server-side check is the real guard
that a random page can't drive your editor into opening source files.

## What's on this branch

- **`media/toolbar.js`** (new) — injectable draggable footer toolbar + bridge
  client (SSE + POST). Styled with `all:initial` isolation so host CSS can't
  bleed in.
- **`extension.js`** — added `startBridge()` (serves `/frontpeek.js`, `/events`,
  `/msg`), `bridgeSend()`, the loopback-origin guard, a
  **`FrontPeek: Copy Injection Snippet`** command, and copy-acks now broadcast
  over the bridge as well as the webview. The old proxy/webview path is left
  intact (additive) so nothing regresses while the approach is evaluated.
- **`package.json`** — registers `frontPeek.copySnippet`.

### Validated end-to-end (real Chrome, real origin, no iframe/proxy)

1. Toolbar injects into `<body>` as a floating footer with a live SSE-connection
   dot. ✔
2. Mode buttons toggle and drive the inspector (`data-pv-inspecting` set). ✔
3. Clicking an element posts `open-source` to the bridge, tagged with the real
   origin. ✔
4. Prompt mode opens the inspector's in-page AI panel anchored to the element;
   Enter posts `ai-prompt`; the copy-ack returns over SSE and the panel shows
   "Copied!" then fades. ✔
5. The toolbar drags freely and stays put. ✔
6. Non-loopback `Origin` on `POST /msg` → `403`. ✔

(Automated wire-contract test + a browser demo harness live under the session
scratchpad; they're not committed.)

## Usage (real-origin mode)

1. Run **`FrontPeek: Copy Injection Snippet`**. It pre-selects the framework it
   detects in your `package.json` and copies a **dev-only** recipe, with the
   live bridge port already filled in:
   - **Next.js (App Router)** — a `<Script strategy="afterInteractive">` gated on
     `process.env.NODE_ENV !== 'production'`, placed in `app/layout.tsx`.
   - **Vite** — a dev-only plugin (`apply: 'serve'` + `transformIndexHtml`) added
     to `vite.config.js`, so it never reaches the production build.
   - **React (CRA / webpack / other)** — a `NODE_ENV === 'development'`-gated
     `document.createElement('script')` in your entry file.
   - **Plain HTML** — a bare `<script … async>` before `</body>`.
2. Paste it into your app (development only).
3. Open the app in your browser at its **real** URL. The toolbar appears; Code /
   Edit / Prompt behave exactly as today — but OAuth, SSO, cookies and CORS all
   work natively because the browser is at the origin the provider whitelisted.

## Trade-offs & open questions

- **"Inside the extension" vs. real browser.** The request also says the site
  should run *inside the extension*. That is in direct tension with *real URL*:
  a webview forces a fake origin (see the constraint above). This prototype
  chooses **real URL in the real browser**, since that's what actually fixes
  auth. If keeping the panel inside VS Code matters more than native auth, we'd
  stay on the proxy and can't fully solve OAuth.
- **One-time injection step.** The user must add the snippet to their dev app.
  That's the cost of same-origin injection — but it's a single dev-only line and
  replaces the proxy, the tunnel, the cookie rewriting, and the OAuth
  whitelisting dance. We can reduce friction further with per-framework
  one-liners or a `postinstall`/CLI helper.
- **Stable port.** The bridge defaults to `57420` (falls back to a random port
  if busy). Keeping it fixed means the snippet URL is stable across sessions;
  the served bundle also self-reports its origin, so a fallback port still works
  without editing the snippet.
- **Removable once adopted.** If we commit to this model, we can delete the
  proxy server, `media/tunnel.js`, the tunnel cookie jar, the Set-Cookie
  rewriting, the origin/referer rewriting, `getWebviewHtml`'s iframe shell, and
  the `frontPeek.proxyPort` setting — a large net simplification.

## Suggested next steps

1. Decide the "inside the extension" vs. "real browser" trade-off with the user.
2. If real-browser is accepted: ship framework snippet recipes (Next/Vite) and
   a friendlier connect UI (the launcher view can show connection status +
   copy-snippet button instead of the URL box).
3. Then retire the proxy/tunnel path and the `proxyPort` setting.
