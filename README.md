# FrontPeek (POC)

VS Code extension that opens your React app in a webview with a component
inspector: hover to highlight elements, click to open the component's source
file, or describe a change and get a structured AI prompt copied to your
clipboard.

Works with **Next.js** and with **plain React apps** (Vite, CRA,
webpack-dev-server) on **React 16 through 19**.

## How to run

1. Open this folder in VS Code and press **F5** (Run Extension). An
   "Extension Development Host" window opens.
2. In the Extension Development Host, open your React/Next.js project folder
   and start the dev server (`npm run dev`).
3. Click the **FrontPeek icon** (cursor with an AI sparkle) in the left
   activity bar — the view opens in the **secondary sidebar** (right side).
   Confirm the dev server URL (default `http://localhost:3000`) and hit
   **Open Preview**; the app loads in the same view. (`Cmd+Shift+P` →
   **FrontPeek: Open Preview** also works.)
4. In the toolbar below the preview:
   - **Edit** (pencil): hover elements (blue outline) and click one — the
     component file opens in a new tab, at the exact line/column of the
     element's JSX.
   - **AI** (sparkle): click an element and a floating prompt panel opens.
     Describe the change and press Enter — a structured prompt (with file
     path, line, route, selector, etc.) is copied to the clipboard, ready to
     paste into Claude Code. Shift+Enter inserts a new line; Esc closes.

## How it works

- The webview cannot inject scripts into a cross-origin iframe, so the
  extension runs a **local HTTP proxy** that forwards the dev server and
  injects `media/inspector.js` into every HTML response (the HMR WebSocket is
  passed through, and `Origin`/`Referer` are rewritten so Next's cross-origin
  dev-resource protection doesn't block requests).
- Because the page's origin becomes `localhost:<port>`, direct fetch/XHR calls
  to third-party services that validate CORS against an origin allowlist (Okta,
  Auth0, custom APIs) would be rejected. The proxy also injects
  `media/tunnel.js`, which reroutes cross-origin fetch/XHR/sendBeacon through
  the same-origin `/__pv/tunnel` endpoint; the extension re-issues the request
  server-side with the real dev server `Origin` and keeps the third party's
  cookies in its own jar. So CORS-guarded API calls work with no configuration.
- The preview is served over `localhost` (not `127.0.0.1`). Cookies are keyed
  by host and ignore the port, so a session cookie the dev server sets for
  `localhost` is also sent to the preview — cookie-session logins carry in for
  free.

## Authenticated apps (OAuth / SSO logins)

CORS-guarded API calls and cookie-session logins work out of the box (see
above). A full **SPA OAuth/SSO** login (Okta, Auth0, Cognito, …) needs one
setting, because of how that flow works: after the credential check
(`POST .../authn`, a `fetch` the tunnel handles), the auth library exchanges the
session for tokens through a **hidden iframe** to the identity provider that
`postMessage`s the tokens back, targeting — and validated against — the app's
**real, whitelisted origin**. That handshake is a navigation, not a `fetch`, so
it can't be tunneled, and its origin can't be faked; against a random preview
origin the browser drops the message and the login spinner hangs. (The console
logs a `[FrontPeek]` warning when this happens.)

To make these logins work, give the preview a **stable, whitelisted origin**:

1. Set `frontPeek.proxyPort` to a fixed free port (e.g. `5787`). The preview
   then always runs at `http://localhost:5787`. (If that port is busy, the
   extension falls back to a random one and warns.)
2. Add `http://localhost:5787` once to the identity provider's **Trusted
   Origins** and **Redirect URIs** (a one-time, per-org step).

With that in place the OAuth handshake targets an origin that matches the
preview, tokens are delivered, and authenticated pages load with the inspector
fully working. Left at the default (`0` = random port), everything except
OAuth-SPA login still works.

- Highlighting uses `outline` (not `border`), which takes no layout space.
- On click, the inspector reads the element's **React fiber** (the DOM node
  key is `__reactFiber$…` on React 17+, `__reactInternalInstance$…` on
  React 16 — both are supported):
  - `_debugSource` (React ≤ 18): exact JSX file/line. On Vite the recorded
    line numbers are skewed (`@vitejs/plugin-react` prepends its refresh
    preamble before the JSX dev transform runs), so the extension fetches the
    served module, locates the jsxDEV source literal with those coordinates
    and maps it through the module's source map back to the true line. On
    webpack/Next the coordinates are already exact and are used as-is.
  - `_debugStack` (React 19.1+ / Next 15+): the stack points at compiled
    chunks. On Next, the extension asks the dev server itself to resolve them
    (`__nextjs_original-stack-frames`, the same endpoint its error overlay
    uses). Stacks are collected along the whole owner chain, so elements
    rendered by libraries (e.g. `next/image`) resolve to where you use them.
  - If the Next endpoints don't exist (plain React dev servers like Vite, or
    Next 16), a **source map fallback** resolves the mapping itself (VLQ
    decoder, supports Turbopack index maps): server frames read the SSR chunk
    from `.next/dev/server/...` on disk; client frames carry browser chunk
    URLs — the extension fetches the chunk's map from the dev server
    (`/__nextjs_source-map` on Next 16, falling back to the chunk's
    `sourceMappingURL` comment — which is how Vite modules resolve). Relative
    `sources` entries resolve against the chunk URL per the source map spec.
  - Whether a dev server has the Next endpoints is probed once per connect
    (a 404 — or an HTML response, the SPA fallback of Vite/CRA — marks them
    missing), so plain React servers aren't re-probed on every click.

## Troubleshooting

- The **"FrontPeek" output channel** (View → Output) logs every click:
  fiber found, stack frames, Next endpoint responses and the resolved file.
- If the dev server logs `Blocked cross-origin request to Next.js dev
  resource`, the proxy already rewrites `Origin`/`Referer`; if it still
  blocks, add to your `next.config.ts`:
  `allowedDevOrigins: ['localhost']`.
- If a login spinner hangs forever, check the console for a `[FrontPeek]`
  warning about a non-tunneled cross-origin iframe navigation — that is an
  OAuth/SSO flow needing a whitelisted origin (see "Authenticated apps").

## Limitations (POC)

- Requires the app in **dev mode** (production fibers carry no source info).
- On React 19 the line precision depends on the bundler's stack format and
  source maps. React 19.0 without owner stacks (they shipped enabled in
  19.1) exposes neither `_debugSource` nor `_debugStack` — use 19.1+.
- **Next 14 App Router** pages don't resolve: the React canary bundled
  inside Next 14 already stripped `_debugSource` (grep it in
  `next/dist/compiled/react-dom` — zero hits) but predates `_debugStack`,
  so its fibers carry no source info at all. Pages Router (which uses the
  app's own React 18) and Next 15+ are fine.
- Plain **webpack with an `eval-*` devtool** (CRA default) can't resolve
  React 19 stacks (frames point at eval'd code, not fetchable chunks);
  React ≤ 18 still works there via `_debugSource`.
- Pure Server Components with no nearby client element may not resolve — the
  fiber chain is walked upward until an owner with source info is found.
- The cross-origin tunnel covers `fetch`, `XMLHttpRequest` and `sendBeacon`
  from documents (including same-origin iframes). Requests from Web Workers and
  third-party WebSockets are not rerouted.
- SPA OAuth/SSO logins (hidden-iframe token exchange) need a fixed, whitelisted
  preview origin — set `frontPeek.proxyPort` and whitelist it at the
  identity provider (see "Authenticated apps"). Without that, the credential
  check and CORS APIs still work, but the token exchange can't complete.
