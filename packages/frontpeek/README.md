# @fredsvanelli/frontpeek

A floating dev toolbar for React / Next.js apps. Click any element in your running app to:

- **Code** — jump to the element's source file. If the [FrontPeek VS Code extension](https://github.com/fredsvanelli/frontpeek) is running, it opens the exact file/line in your editor. If not, the component path is copied to your clipboard (`Component path copied!`).
- **Edit** — tweak an element's styles in a live editor and copy the change as a ready-to-paste AI prompt.
- **Prompt** — click an element, describe a change, and copy a structured prompt that already points at the right file and JSX.

A click rarely has just one valid target — the element sits inside a whole component hierarchy (`<Routes> > <Page> > <List> > <p>`), and your intent may live at any level of it. So after you click, all three tools open a small picker listing the 4 deepest levels of that hierarchy; choose the one you meant and it is resolved. Click `[…]` at the top to reveal 2 more ancestors at a time, hover a row to highlight what it covers on the page, and press `Esc` to cancel.

The toolbar is **self-contained** — it needs no browser extension and no proxy. Source resolution runs in the browser against your own dev server (the same endpoints Next's error overlay uses), so it works at your app's real origin, with real cookies and auth.

## Install

```bash
npm install @fredsvanelli/frontpeek
```

`react` (>=17) is a peer dependency.

## Usage

Drop `<FrontPeek />` once, near the root of your app.

### Next.js (App Router) — `app/layout.tsx`

```tsx
import { FrontPeek } from '@fredsvanelli/frontpeek';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <FrontPeek />
      </body>
    </html>
  );
}
```

### React (Vite / CRA)

```jsx
import { FrontPeek } from '@fredsvanelli/frontpeek';

function App() {
  return (
    <>
      {/* your app */}
      <FrontPeek />
    </>
  );
}
```

## Choosing where it shows

By default FrontPeek renders **only in local development** (`process.env.NODE_ENV === 'development'`).

To control it explicitly, pass the `enabled` boolean — you decide the condition, so any environment scheme works (Vercel, custom `NEXT_PUBLIC_*` vars, staging/preview, custom strings like `prod` / `stg`):

```tsx
// show everywhere except production
<FrontPeek enabled={process.env.NEXT_PUBLIC_APP_ENV !== 'production'} />

// show on an explicit allow-list of environments
<FrontPeek enabled={['development', 'staging', 'prod'].includes(process.env.NEXT_PUBLIC_APP_ENV)} />

// force off
<FrontPeek enabled={false} />
```

> Environment variables are inlined at build time, so gate on ones your bundler exposes to the browser (e.g. `NEXT_PUBLIC_*` in Next).

## Props

| Prop         | Type      | Default                                  | Description                                                        |
| ------------ | --------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `enabled`    | `boolean` | `NODE_ENV === 'development'` when omitted | Whether the toolbar mounts. Explicit boolean always wins.          |
| `bridgePort` | `number`  | `57420`                                  | Loopback port the VS Code extension listens on. Change only if you customized the extension. |

## Open-in-editor (optional)

Clicking **Code** copies the path by default. To have it **open your editor** instead, install the companion **FrontPeek** VS Code extension. It runs a tiny local bridge on `localhost:57420`; when detected, the toolbar's status dot turns green and **Code** opens the file at the exact line. Nothing else about the toolbar changes.

## Local development (linking the package)

Installed normally from npm, FrontPeek is a plain dependency — nothing special is
needed. But if you're developing the package itself and linking it into an app
with `npm link` or `file:`, **Turbopack won't resolve the symlink** (it points
outside the app). Two workarounds:

- Install a packed copy instead of a symlink:
  ```bash
  npm pack   # in the frontpeek package → produces a .tgz
  npm install /path/to/fredsvanelli-frontpeek-*.tgz   # in your app
  ```
- Add the package to `transpilePackages` so the bundler processes it from
  `node_modules`:
  ```ts
  // next.config.ts
  const nextConfig = { transpilePackages: ["@fredsvanelli/frontpeek"] };
  ```

## License

MIT
