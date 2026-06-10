import { useEffect } from 'react';

/** Default «Ishlarim» poll cadence — research Rec 2 ("~25s"). */
export const INBOX_POLL_MS = 25_000;

/**
 * Phase F-V — a lightweight re-fetch loop for an inbox host (research Rule 4 /
 * Rec 2). The spec is explicit: polling stays the HOST's concern and adds NO new
 * endpoint — the host simply re-runs the queries it ALREADY owns on a ~25 s
 * interval so a freshly-arrived task surfaces (and {@link useInboxAlert} can
 * beep/flash on the count rise) without a manual refresh.
 *
 * Pass the host's existing `refetch` callbacks. They are invoked together every
 * `intervalMs` while `enabled`. `useApiQuery`'s `refetch` is a stable
 * `useCallback`, so the dependency list is stable across renders.
 *
 * Kept tiny + shared so all four hosts (store / central / отдел / homashyo) poll
 * identically. The hidden-tab guard pauses polling when the page isn't visible
 * (no point hammering queries the operator can't see; resumes on focus).
 *
 * @param refetchers the host queries to revalidate (spread inline at the call site)
 * @param enabled    gate the loop (default true)
 * @param intervalMs cadence (default {@link INBOX_POLL_MS})
 */
export function useInboxPolling(
  refetchers: ReadonlyArray<() => void>,
  enabled = true,
  intervalMs = INBOX_POLL_MS,
): void {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      for (const refetch of refetchers) refetch();
    };
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
    // Spreading the array keeps the deps primitive-stable: each `refetch` is a
    // stable useCallback from useApiQuery, so this re-subscribes only when the
    // SET of queries (or enabled/interval) changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...refetchers]);
}
