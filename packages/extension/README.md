# FrontPeek (VS Code extension)

Companion for the [`@fredsvanelli/frontpeek`](https://www.npmjs.com/package/@fredsvanelli/frontpeek) toolbar.

The toolbar runs **inside your app**, in your real browser, and lets you click any element to jump to its source. On its own it copies the component path to your clipboard. Install this extension and the toolbar's **Code** button opens the file directly in your editor instead.

## How it works

The extension runs a tiny local bridge on `http://localhost:57420`:

- `GET /events` — a Server-Sent-Events stream. When the toolbar connects, its status dot turns green (open-in-editor is available).
- `POST /msg` — receives `{ type: 'open-file', file, line, column }` (a path the toolbar already resolved in the browser) and opens it at that position, raising the editor window.

Writes are guarded: only loopback (`localhost` / `127.0.0.1`) origins are accepted.

That's the whole extension — no webview, no proxy, no source-map resolution. All source resolution now happens in the browser inside the npm package.

## Setup

1. Install this extension.
2. Add the toolbar to your app:
   ```bash
   npm install @fredsvanelli/frontpeek
   ```
   ```tsx
   import { FrontPeek } from '@fredsvanelli/frontpeek';
   // …
   <body>
     {children}
     <FrontPeek />
   </body>
   ```
3. Run your dev server, open the app, and click **Code** on any element.

## Development

From the monorepo root, press <kbd>F5</kbd> (Run FrontPeek Extension) or run the
`Run FrontPeek Extension` launch config. Use **FrontPeek: Show Output** to see the bridge log.

## License

MIT
