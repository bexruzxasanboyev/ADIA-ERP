/**
 * JWT token persistence (access + refresh).
 *
 * Sprint 3 added a refresh-token flow on the backend:
 *  - access token TTL 1h
 *  - refresh token TTL 30d, rotated on every refresh
 *
 * Both tokens are stored in `localStorage` so a session survives page
 * reloads; an in-memory copy avoids repeated storage reads on every
 * `apiRequest` call.
 *
 * XSS TRADEOFF (accepted technical debt — code-reviewer Sprint 0):
 * Tokens live in localStorage rather than an httpOnly cookie because
 * spec §4 requires `Authorization: Bearer <JWT>` on every endpoint.
 * ADIA is a single-company internal ERP, so the Bearer-header + storage
 * model is kept; access to the tokens is funnelled through this module,
 * keeping the XSS surface to one auditable point. The 1h access TTL +
 * rotated refresh narrows the blast radius further.
 */
const ACCESS_KEY = 'adia.access_token';
const REFRESH_KEY = 'adia.refresh_token';

let memoryAccess: string | null = null;
let memoryRefresh: string | null = null;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — keep in-memory copy only */
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function getAccessToken(): string | null {
  if (memoryAccess !== null) return memoryAccess;
  memoryAccess = readStorage(ACCESS_KEY);
  return memoryAccess;
}

export function getRefreshToken(): string | null {
  if (memoryRefresh !== null) return memoryRefresh;
  memoryRefresh = readStorage(REFRESH_KEY);
  return memoryRefresh;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export function setTokens({ accessToken, refreshToken }: TokenPair): void {
  memoryAccess = accessToken;
  memoryRefresh = refreshToken;
  writeStorage(ACCESS_KEY, accessToken);
  writeStorage(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  memoryAccess = null;
  memoryRefresh = null;
  removeStorage(ACCESS_KEY);
  removeStorage(REFRESH_KEY);
}
