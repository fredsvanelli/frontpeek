// Decides whether the toolbar should mount. The explicit `enabled` boolean is
// authoritative — pass it however you like:
//
//   <FrontPeek enabled={process.env.NEXT_PUBLIC_APP_ENV !== 'production'} />
//   <FrontPeek enabled={['development','staging','prod'].includes(env)} />
//
// When `enabled` is omitted, FrontPeek defaults to dev-local only. In a Next /
// bundler build `process.env.NODE_ENV` is inlined at build time, so this is a
// static, tree-shake-friendly check.
export function resolveEnabled(enabled) {
  if (typeof enabled === 'boolean') return enabled;
  try {
    return process.env.NODE_ENV === 'development';
  } catch (_) {
    // No `process` (some browser-only bundles) — be conservative and show it,
    // since an explicit `enabled` is the documented way to gate production.
    return true;
  }
}
