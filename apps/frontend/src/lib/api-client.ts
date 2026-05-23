import { env } from './env';
import { getToken, clearToken } from './auth-storage';
import type { ApiErrorBody } from './types';

/**
 * Error thrown for any non-2xx API response. Carries the parsed
 * `{ error: { code, message } }` envelope (phase-1-mvp.md §4.10) when present.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Extra headers; merged over the defaults. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const err = (value as Record<string, unknown>).error;
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e.code === 'string' && typeof e.message === 'string';
}

/**
 * Typed `fetch` wrapper for the ADIA ERP backend.
 * Attaches the JWT `Authorization: Bearer` header, sends/receives JSON,
 * and parses the standard error envelope into an `ApiError`.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, headers = {}, signal } = options;

  const finalHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...headers,
  };

  const token = getToken();
  if (token) {
    finalHeaders.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Tarmoq xatosi. Qayta urinib ko‘ring.');
  }

  const text = await response.text();
  const payload: unknown = text.length > 0 ? safeJsonParse(text) : null;

  if (!response.ok) {
    const code = isApiErrorBody(payload) ? payload.error.code : 'UNKNOWN_ERROR';

    // Central session-expiry handling: a 401 means the stored JWT is
    // missing/expired/invalid. Clear it and bounce the user to /login so
    // no screen is left rendering against a dead session.
    if (response.status === 401) {
      handleUnauthenticated();
    }

    if (isApiErrorBody(payload)) {
      throw new ApiError(response.status, code, payload.error.message);
    }
    throw new ApiError(response.status, code, `So‘rov muvaffaqiyatsiz (${response.status}).`);
  }

  return payload as T;
}

/**
 * Reacts to a 401 response: drop the stale token and redirect to /login.
 * A hard `window.location` redirect (rather than the router) is used
 * deliberately — the fetch layer must stay decoupled from React/router,
 * and a full reload guarantees all in-memory app state is discarded.
 * Guarded so it is a no-op outside a browser (tests / SSR).
 */
function handleUnauthenticated(): void {
  clearToken();
  if (typeof window === 'undefined') return;
  if (window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
