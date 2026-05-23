/**
 * JWT token persistence. Backed by localStorage so a session survives
 * page reloads; the in-memory copy avoids repeated storage reads.
 */
const TOKEN_KEY = 'adia.token';

let memoryToken: string | null = null;

export function getToken(): string | null {
  if (memoryToken !== null) return memoryToken;
  try {
    memoryToken = window.localStorage.getItem(TOKEN_KEY);
  } catch {
    memoryToken = null;
  }
  return memoryToken;
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable — keep in-memory copy only */
  }
}

export function clearToken(): void {
  memoryToken = null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}
