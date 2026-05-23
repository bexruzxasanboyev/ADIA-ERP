/**
 * Unit tests for the token persistence module — Sprint 3 added the
 * refresh-token flow (`docs/specs/phase-1-mvp.md §4.1`). The module
 * now stores TWO tokens (access + refresh) and exposes a different
 * API than the original single-`token` helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAccessToken,
  getRefreshToken,
  setTokens,
  clearTokens,
} from './auth-storage';

const ACCESS_KEY = 'adia.access_token';
const REFRESH_KEY = 'adia.refresh_token';

describe('auth-storage', () => {
  beforeEach(() => {
    clearTokens();
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
  });

  it('returns null when no tokens are stored', () => {
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  it('persists both tokens to localStorage with the documented keys', () => {
    setTokens({ accessToken: 'A1', refreshToken: 'R1' });
    expect(window.localStorage.getItem(ACCESS_KEY)).toBe('A1');
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe('R1');
  });

  it('reads back the stored tokens via the typed getters', () => {
    setTokens({ accessToken: 'A2', refreshToken: 'R2' });
    expect(getAccessToken()).toBe('A2');
    expect(getRefreshToken()).toBe('R2');
  });

  it('overwrites a previous pair on subsequent setTokens()', () => {
    setTokens({ accessToken: 'old-a', refreshToken: 'old-r' });
    setTokens({ accessToken: 'new-a', refreshToken: 'new-r' });
    expect(getAccessToken()).toBe('new-a');
    expect(getRefreshToken()).toBe('new-r');
    expect(window.localStorage.getItem(ACCESS_KEY)).toBe('new-a');
    expect(window.localStorage.getItem(REFRESH_KEY)).toBe('new-r');
  });

  it('clearTokens() drops both tokens from memory AND localStorage', () => {
    setTokens({ accessToken: 'A', refreshToken: 'R' });
    clearTokens();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(window.localStorage.getItem(ACCESS_KEY)).toBeNull();
    expect(window.localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it('hydrates the in-memory cache from localStorage on first read', () => {
    // Simulates a fresh page load: a previous session wrote to
    // localStorage, the in-memory cache was reset by `clearTokens()`,
    // and the next getter must repopulate from storage.
    window.localStorage.setItem(ACCESS_KEY, 'persisted-a');
    window.localStorage.setItem(REFRESH_KEY, 'persisted-r');
    expect(getAccessToken()).toBe('persisted-a');
    expect(getRefreshToken()).toBe('persisted-r');
  });
});
