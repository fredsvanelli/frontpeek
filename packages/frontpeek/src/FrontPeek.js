'use client';

// The public React component. It renders nothing itself — on mount it injects
// the FrontPeek toolbar + inspector into document.body and tears them down on
// unmount. All the real work lives in the framework-agnostic core/*.js modules,
// so `<FrontPeek />` is just the React lifecycle glue.

import { useEffect } from 'react';
import { resolveEnabled } from './core/env.js';
import { mount } from './core/mount.js';

export function FrontPeek(props) {
  props = props || {};
  const enabled = props.enabled;
  const bridgePort = props.bridgePort;

  useEffect(() => {
    // Never mounts on the server, and stays out of the way in environments the
    // caller hasn't opted in (default: dev-local only). See core/env.js.
    if (typeof document === 'undefined') return;
    if (!resolveEnabled(enabled)) return;
    const instance = mount({ bridgePort: bridgePort });
    return () => instance.destroy();
  }, [enabled, bridgePort]);

  return null;
}

export default FrontPeek;
