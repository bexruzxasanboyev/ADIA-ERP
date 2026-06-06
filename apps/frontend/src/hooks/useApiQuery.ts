import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, apiRequest } from '@/lib/api-client';

interface ApiQueryState<T> {
  data: T | null;
  /** True while the first or a refetch request is in flight. */
  isLoading: boolean;
  /** Localized error message, or null. */
  error: string | null;
  /** Re-run the request. */
  refetch: () => void;
}

/**
 * Time-to-live for a cached entry. A cache hit younger than this is
 * considered "fresh" — `prefetchApiQuery` skips re-fetching it, and a
 * mounting consumer serves it without re-validating in the foreground.
 * A stale (older) hit is STILL served immediately (stale-while-revalidate)
 * but triggers a background revalidation. Kept short so the dashboard
 * never shows numbers older than ~a minute without refreshing.
 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  /** The last successful response payload for this path. */
  data: unknown;
  /** `Date.now()` when `data` was stored — drives the TTL freshness check. */
  fetchedAt: number;
}

/**
 * Module-level, app-wide cache keyed by API path. Shared across every
 * `useApiQuery` consumer AND `prefetchApiQuery`, so a range the user has
 * already visited (or that was warmed ahead of time) renders instantly
 * with no loader. Only successful GETs are cached; errors are never
 * stored (so a transient failure can't poison a path).
 */
const cache = new Map<string, CacheEntry>();

/** In-flight prefetches, keyed by path — dedupe concurrent warm-ups. */
const prefetchInFlight = new Map<string, Promise<void>>();

function getEntry(path: string): CacheEntry | undefined {
  return cache.get(path);
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

function storeEntry(path: string, data: unknown): void {
  cache.set(path, { data, fetchedAt: Date.now() });
}

/**
 * Warm the cache for `path` WITHOUT a component subscribing — used to
 * prefetch the ranges the user is likely to toggle to so switching is
 * instant. A no-op when a fresh entry already exists or a prefetch for
 * the same path is already in flight. Never throws: a failed warm-up is
 * swallowed (the consuming component will surface the real error when it
 * actually needs the data).
 */
export function prefetchApiQuery(path: string): void {
  const entry = getEntry(path);
  if (entry !== undefined && isFresh(entry)) return;
  if (prefetchInFlight.has(path)) return;

  const promise = apiRequest<unknown>(path)
    .then((result) => {
      storeEntry(path, result);
    })
    .catch(() => {
      // Swallow — a failed prefetch must never crash the dashboard.
    })
    .finally(() => {
      prefetchInFlight.delete(path);
    });

  prefetchInFlight.set(path, promise);
}

/** Test-only: clear the shared cache so suites don't leak across cases. */
export function __clearApiQueryCache(): void {
  cache.clear();
  prefetchInFlight.clear();
}

/**
 * Data-fetching hook for GET endpoints with a stale-while-revalidate
 * cache. Cancels in-flight requests on unmount or path change to avoid
 * setting state on an unmounted component.
 *
 * Behaviour on path change:
 *   - Cache HIT (fresh OR stale): the cached payload is served IMMEDIATELY
 *     as `data` with `isLoading=false`, then revalidated in the background
 *     (a fetch runs; on success the cache + state update). The user never
 *     sees a loader for an already-seen/prefetched range.
 *   - Cache MISS: `data=null`, `isLoading=true` and the request runs in the
 *     foreground — consumers render their skeleton, exactly as before.
 *
 * `refetch()` always forces a foreground network revalidation regardless
 * of cache state.
 *
 * @param path  API path; pass `null` to skip the request entirely.
 */
export function useApiQuery<T>(path: string | null): ApiQueryState<T> {
  // Seed synchronously from the cache so the very first render of a
  // cached path already shows data (no skeleton flash).
  const initialEntry = path !== null ? getEntry(path) : undefined;
  const [data, setData] = useState<T | null>(
    initialEntry ? (initialEntry.data as T) : null,
  );
  const [isLoading, setIsLoading] = useState<boolean>(
    path !== null && initialEntry === undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Tracks the path of the data currently held in state. When the query key
  // changes (e.g. the dashboard date-range filter flips today→month), the
  // prior query's data is stale and must NOT keep rendering UNLESS the cache
  // has an entry for the new path (stale-while-revalidate). A pure refetch
  // (same path) keeps the data to avoid a flicker on background refresh.
  const dataPathRef = useRef<string | null>(null);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setIsLoading(false);
      setError(null);
      dataPathRef.current = null;
      return;
    }

    // A refetch (reloadKey bumped) for the SAME path must always hit the
    // network — it bypasses the "serve cache and skip foreground" path.
    const isRefetch = dataPathRef.current === path;
    const entry = getEntry(path);
    // When we serve cached data and revalidate in the background, a failed
    // revalidation must NOT flip a working widget into its error state — we
    // keep showing the (stale) cached data. Errors only surface on a true
    // foreground load (cache miss) or an explicit refetch.
    const servedFromCache = !isRefetch && entry !== undefined;

    if (!isRefetch) {
      dataPathRef.current = path;
      if (entry !== undefined) {
        // Cache HIT — serve immediately (stale-while-revalidate). Show the
        // cached data with no loader, then revalidate in the background.
        setData(entry.data as T);
        setError(null);
        setIsLoading(false);
      } else {
        // Cache MISS — drop the previous period's data so consumers render a
        // loading skeleton instead of stale numbers.
        setData(null);
        setIsLoading(true);
        setError(null);
      }
    } else {
      // Forced refetch: keep current data, signal a refresh is in flight.
      setIsLoading(true);
      setError(null);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    apiRequest<T>(path, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        storeEntry(path, result);
        setData(result);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Background revalidation of a cache hit: keep the stale data and
        // stay silent — don't surface an error over a working widget.
        if (servedFromCache) return;
        const message =
          err instanceof ApiError
            ? err.message
            : 'Ma’lumotni yuklab bo‘lmadi.';
        setError(message);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [path, reloadKey]);

  return { data, isLoading, error, refetch };
}
