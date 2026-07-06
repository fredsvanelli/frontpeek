import type { FC } from 'react';

export interface FrontPeekProps {
  /**
   * Whether the toolbar mounts. The explicit boolean always wins — pass any
   * condition you like to gate environments:
   *
   * ```tsx
   * <FrontPeek enabled={process.env.NEXT_PUBLIC_APP_ENV !== 'production'} />
   * <FrontPeek enabled={['development', 'staging'].includes(env)} />
   * ```
   *
   * When omitted, defaults to dev-local only (`process.env.NODE_ENV === 'development'`).
   */
  enabled?: boolean;

  /**
   * Loopback port the FrontPeek VS Code extension listens on for
   * open-in-editor. Defaults to `57420`. Change only if you customized the
   * extension's port.
   */
  bridgePort?: number;
}

/**
 * A floating dev toolbar for React / Next.js apps. Click any element to jump to
 * its source (opens VS Code when the companion extension is running, otherwise
 * copies the component path), tweak its styles, or copy a structured AI prompt.
 *
 * Renders nothing itself — it injects the toolbar into `document.body` on mount
 * and tears it down on unmount.
 */
export declare const FrontPeek: FC<FrontPeekProps>;

export default FrontPeek;
