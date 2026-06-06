import { useEffect, useState } from 'react';

/**
 * Reads the `prefers-reduced-motion` user preference reactively.
 *
 * The CSS side of this convention already lives in `index.css`
 * (`@media (prefers-reduced-motion: reduce)`), but Recharts animations are
 * driven in JavaScript and ignore CSS media queries — so charts need to read
 * the same preference at runtime to honour it. Components pass the result to
 * Recharts' `isAnimationActive` (false when motion is reduced).
 *
 * SSR-safe: returns `false` when `window.matchMedia` is unavailable.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => read());

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, []);

  return reduced;
}

function read(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
