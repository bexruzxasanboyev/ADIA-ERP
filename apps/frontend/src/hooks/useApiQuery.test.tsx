/**
 * useApiQuery — stale-while-revalidate cache + prefetch tests.
 *
 * Covers the three behaviours the dashboard relies on:
 *   1. Cache MISS → loader then data (legacy behaviour preserved).
 *   2. Cache HIT  → cached data served instantly (isLoading=false) with a
 *      silent background revalidation.
 *   3. refetch()  → forces a network revalidation regardless of cache.
 *   4. prefetchApiQuery → populates the shared cache without a subscriber,
 *      so a later mount is an instant hit.
 *
 * `apiRequest` is mocked so no real network is hit; the shared module cache
 * is cleared between cases via the test-only `__clearApiQueryCache`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  __clearApiQueryCache,
  prefetchApiQuery,
  useApiQuery,
} from './useApiQuery';
import { apiRequest } from '@/lib/api-client';

vi.mock('@/lib/api-client', () => ({
  // ApiError is referenced by the hook's catch branch; a minimal class
  // standing in for the real one keeps the import graph satisfied.
  ApiError: class ApiError extends Error {},
  apiRequest: vi.fn(),
}));

const mockedApiRequest = vi.mocked(apiRequest);

beforeEach(() => {
  __clearApiQueryCache();
  mockedApiRequest.mockReset();
});

afterEach(() => {
  __clearApiQueryCache();
});

describe('useApiQuery — cache miss', () => {
  it('starts loading, then resolves with data', async () => {
    mockedApiRequest.mockResolvedValueOnce({ value: 1 });

    const { result } = renderHook(() => useApiQuery<{ value: number }>('/x'));

    // First render: no cache → loading, no data.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual({ value: 1 });
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
  });
});

describe('useApiQuery — cache hit (stale-while-revalidate)', () => {
  it('serves cached data instantly without a loader, then revalidates', async () => {
    // Warm the cache via a first mount.
    mockedApiRequest.mockResolvedValueOnce({ value: 1 });
    const first = renderHook(() => useApiQuery<{ value: number }>('/x'));
    await waitFor(() => expect(first.result.current.data).toEqual({ value: 1 }));
    first.unmount();

    // Second mount of the same path: instant data, NO loading flash. The
    // background revalidation returns fresh data.
    mockedApiRequest.mockResolvedValueOnce({ value: 2 });
    const second = renderHook(() => useApiQuery<{ value: number }>('/x'));

    // Synchronously served from cache: data present, not loading.
    expect(second.result.current.isLoading).toBe(false);
    expect(second.result.current.data).toEqual({ value: 1 });

    // Background revalidation updates to the fresh payload.
    await waitFor(() =>
      expect(second.result.current.data).toEqual({ value: 2 }),
    );
  });

  it('keeps stale data and stays silent when background revalidation fails', async () => {
    mockedApiRequest.mockResolvedValueOnce({ value: 1 });
    const first = renderHook(() => useApiQuery<{ value: number }>('/x'));
    await waitFor(() => expect(first.result.current.data).toEqual({ value: 1 }));
    first.unmount();

    mockedApiRequest.mockRejectedValueOnce(new Error('boom'));
    const second = renderHook(() => useApiQuery<{ value: number }>('/x'));

    expect(second.result.current.data).toEqual({ value: 1 });
    // Let the failed revalidation settle: data preserved, no error surfaced.
    await waitFor(() => expect(mockedApiRequest).toHaveBeenCalledTimes(2));
    expect(second.result.current.data).toEqual({ value: 1 });
    expect(second.result.current.error).toBeNull();
  });
});

describe('useApiQuery — refetch', () => {
  it('forces a network revalidation', async () => {
    mockedApiRequest.mockResolvedValueOnce({ value: 1 });
    const { result } = renderHook(() => useApiQuery<{ value: number }>('/x'));
    await waitFor(() => expect(result.current.data).toEqual({ value: 1 }));

    mockedApiRequest.mockResolvedValueOnce({ value: 9 });
    act(() => result.current.refetch());

    await waitFor(() => expect(result.current.data).toEqual({ value: 9 }));
    expect(mockedApiRequest).toHaveBeenCalledTimes(2);
  });
});

describe('useApiQuery — null path', () => {
  it('skips the request entirely', () => {
    const { result } = renderHook(() => useApiQuery<unknown>(null));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });
});

describe('prefetchApiQuery', () => {
  it('populates the cache so a later mount is an instant hit', async () => {
    mockedApiRequest.mockResolvedValueOnce({ value: 7 });

    prefetchApiQuery('/x');
    await waitFor(() => expect(mockedApiRequest).toHaveBeenCalledTimes(1));

    // Mounting the same path now serves the prefetched value with no loader.
    mockedApiRequest.mockResolvedValueOnce({ value: 7 });
    const { result } = renderHook(() => useApiQuery<{ value: number }>('/x'));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toEqual({ value: 7 });
  });

  it('is a no-op when a fresh cache entry already exists', async () => {
    mockedApiRequest.mockResolvedValueOnce({ value: 7 });
    prefetchApiQuery('/x');
    await waitFor(() => expect(mockedApiRequest).toHaveBeenCalledTimes(1));

    // Fresh entry → second prefetch must not fire another request.
    prefetchApiQuery('/x');
    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
  });

  it('swallows errors (never throws)', async () => {
    mockedApiRequest.mockRejectedValueOnce(new Error('nope'));
    expect(() => prefetchApiQuery('/x')).not.toThrow();
    await waitFor(() => expect(mockedApiRequest).toHaveBeenCalledTimes(1));
  });
});
