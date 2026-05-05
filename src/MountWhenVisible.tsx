import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Render `placeholder` until the element scrolls into view (or until
 * `eagerAfterMs` elapses), then mount `children`. Used to defer
 * expensive cards (mortality sensitivity, calibration dashboard, log
 * actuals) below the Cockpit fold so the first paint is faster.
 *
 * Why an eager-after timer too: IntersectionObserver fires on
 * scroll/resize, but if the user just lands on the Cockpit and starts
 * reading WITHOUT scrolling, the cards below the fold should still
 * mount eventually. 2-3s after first paint is a reasonable default —
 * the optimizer chain is still running anyway, so the cost amortizes.
 *
 * `minHeight` reserves layout space so the page doesn't jump when
 * children mount.
 */
export function MountWhenVisible({
  children,
  placeholder = null,
  rootMargin = '300px',
  eagerAfterMs = 2500,
  minHeight,
}: {
  children: ReactNode;
  placeholder?: ReactNode;
  /** Pre-fire when the element gets within this distance of the viewport.
   *  Default 300px — mounts ~one screen ahead so the user never sees
   *  a "loading" flash on scroll. */
  rootMargin?: string;
  /** Force-mount after this many ms even if the user hasn't scrolled.
   *  Default 2500ms. Pass `Infinity` to disable. */
  eagerAfterMs?: number;
  /** CSS min-height while the placeholder is showing. Prevents page jump. */
  minHeight?: string;
}) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (visible) return;
    if (!ref.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Fallback for older browsers / SSR — mount immediately.
      setVisible(true);
      return;
    }
    // Bug fix 2026-05-05: on large displays, the entire cockpit fits
    // in viewport, so EVERY lazy card was "intersecting" on initial
    // paint and immediately mounting + running its sync MC compute.
    // The cockpit hung because UncertaintyRangeTile (6 perturbations
    // × MC) + MortalitySensitivityCard (3 paths) all fired in parallel
    // on the main thread.
    //
    // Fix: ignore the *initial* intersection. Only mount when the user
    // actually scrolls past the element (or after the eager timer).
    let firstObservation = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (firstObservation) {
          firstObservation = false;
          // Skip the initial firing — IntersectionObserver always
          // delivers a "current state" entry on connect, even if
          // nothing has scrolled yet. We only want to react to actual
          // scroll-driven visibility changes.
          return;
        }
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin, threshold: 0 },
    );
    observer.observe(ref.current);
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (Number.isFinite(eagerAfterMs)) {
      timer = setTimeout(() => setVisible(true), eagerAfterMs);
    }
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [visible, rootMargin, eagerAfterMs]);

  return (
    <div
      ref={ref}
      style={minHeight && !visible ? { minHeight } : undefined}
    >
      {visible ? children : placeholder}
    </div>
  );
}
