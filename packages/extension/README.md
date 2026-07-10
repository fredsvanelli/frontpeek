# Frontpeek (connector)

> ⚠️ **This extension requires [`@fredsvanelli/frontpeek`](https://www.npmjs.com/package/@fredsvanelli/frontpeek) to work.** On its own it does nothing - it only listens for the toolbar shipped by that package. Install the npm package in your app first (see [Setup](#setup)).

## The **official connector** for [`@fredsvanelli/frontpeek`](https://www.npmjs.com/package/@fredsvanelli/frontpeek) npm package.

The toolbar runs **inside your app**, in your real browser, and lets you click any element to jump to its source. On its own it copies the component path to your clipboard. Install this connector and the toolbar's **Code** button opens the file directly in your editor instead.

## How it works

The extension runs a tiny local bridge on `http://localhost:57420`:

- `GET /events` - a Server-Sent-Events stream. When the toolbar connects, its status dot turns green (open-in-editor is available).
- `POST /msg` - receives `{ type: 'open-file', file, line, column }` (a path the toolbar already resolved in the browser) and opens it at that position, raising the editor window.

Writes are guarded: only loopback (`localhost` / `127.0.0.1`) origins are accepted.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `frontPeek.port` | `57420` | Loopback port the bridge listens on. Changing it restarts the bridge automatically — no window reload needed. |

If you change `frontPeek.port`, pass the **same** value to the toolbar so it probes the right port:

```tsx
<FrontPeek bridgePort={57420} />
```

Both sides must agree on the port — the extension listens on `frontPeek.port` and the toolbar connects to `bridgePort`. If they differ, the toolbar's status dot stays gray and the **Code** button falls back to copying the path to the clipboard.

> If the configured port is already in use, the bridge falls back to a random free port. The toolbar only probes the configured port, so open-in-editor won't be detected until the configured port is free. Check **FrontPeek: Show Output** for the actual port.

That's the whole extension - no webview, no proxy, no source-map resolution. All source resolution now happens in the browser inside the npm package.

## Setup

1. Install this extension.
2. Add the toolbar to your app (React or Next.js):
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

## License

MIT
