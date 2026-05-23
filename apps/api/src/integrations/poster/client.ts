/**
 * Typed Poster POS API client (read-only — Faza-1 / ADR-0002 §6).
 *
 * Wraps the small slice of Poster endpoints M7 needs:
 *   - access.getSpots             — 5 retail spots
 *   - storage.getStorages         — 25 storages
 *   - storage.getStorageLeftovers — current on-hand qty per storage
 *   - menu.getIngredients         — raw ingredients (375 in production)
 *   - menu.getProducts            — menu products (293 in production)
 *   - menu.getProduct             — single menu product with BOM (`ingredients`)
 *   - menu.getPrepacks            — 1121 prepacks with their BOMs
 *   - dash.getTransactions        — sales check list (fallback poll)
 *   - dash.getTransaction         — one check with line products
 *
 * Cross-cutting behaviour:
 *   - rate limit ~5 req/sec via a serial gate + minimum 200ms gap;
 *   - per-call timeout (default 10s) via `AbortController`;
 *   - secrets (token) NEVER appear in thrown errors or log lines —
 *     we strip the `token` query param from any URL we surface.
 *
 * The client is a class with a `.fetch()` injection point so tests can mock the
 * network without an HTTP server. Production code constructs it via
 * `createPosterClientFromConfig()` and reuses the singleton.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../../config/index.js';
import { AppError } from '../../errors/index.js';

// -----------------------------------------------------------------------------
// Response row shapes — keys present in real Poster responses (2026-05-23).
// All numeric-looking fields arrive as strings; we keep them as strings here
// and parse at the boundary inside each sync service.
// -----------------------------------------------------------------------------

export type PosterSpot = {
  spot_id: string;
  name: string;
  spot_name?: string;
  spot_adress?: string;
};

export type PosterStorage = {
  storage_id: string;
  storage_name: string;
  storage_adress?: string;
  delete?: string;
};

export type PosterLeftover = {
  ingredient_id: string;
  ingredient_name: string;
  ingredient_left: string;
  /** Per-storage on-hand qty. May be NEGATIVE (Poster bookkeeping artefact). */
  storage_ingredient_left: string;
  storage_ingredient_sum?: string;
  prime_cost?: string;
  ingredient_unit: string;
  /** "1" = raw ingredient, "2" = finished good (G/P). Both keyed by ingredient_id. */
  ingredients_type: string;
  limit_value?: string;
  hidden?: string;
};

export type PosterIngredient = {
  ingredient_id: number | string;
  ingredient_name: string;
  ingredient_unit: string;
  ingredients_type?: number | string;
  limit_value?: number | string;
};

export type PosterMenuProductRow = {
  product_id: string;
  product_name: string;
  /** "2" = stocked menu item, "3" = configured-via-modifications. */
  type: string;
  ingredient_id?: string;
  unit?: string;
  menu_category_id?: string;
};

export type PosterRecipeIngredient = {
  structure_id: string;
  ingredient_id: string;
  /** Quantity unit of the brutto/netto values: typically "g" or "kg". */
  structure_unit: string;
  /** "1" = raw, "2" = prepack (semi). */
  structure_type: string;
  structure_brutto: number | string;
  structure_netto: number | string;
  ingredient_name: string;
  ingredient_unit: string;
};

export type PosterMenuProductFull = PosterMenuProductRow & {
  ingredients?: PosterRecipeIngredient[];
};

export type PosterPrepack = {
  product_id: string;
  ingredient_id: string;
  product_name: string;
  /** Yield of one batch — used to normalise BOM qty per produced unit. */
  out: number | string;
  ingredients: PosterRecipeIngredient[];
};

export type PosterTransactionLine = {
  product_id: string;
  modification_id?: string;
  num: string;
  product_price: string;
  payed_sum?: string;
};

export type PosterTransactionSummary = {
  transaction_id: string;
  spot_id: string;
  date_close?: string;
  status?: string;
  sum?: string;
};

export type PosterTransactionFull = PosterTransactionSummary & {
  products?: PosterTransactionLine[];
};

// -----------------------------------------------------------------------------
// Client options + errors
// -----------------------------------------------------------------------------

export type PosterClientOptions = {
  /** Personal Integration token (account:32hex). REQUIRED for any call. */
  readonly token: string;
  /** Override the base URL (used by tests). Defaults to the public Poster host. */
  readonly baseUrl?: string;
  /** Per-call timeout in ms. Default: 10_000 (10s). */
  readonly timeoutMs?: number;
  /** Minimum gap between calls in ms. Default: 220 (≈4.5 req/sec, under 5). */
  readonly minIntervalMs?: number;
  /** Injection point for tests — default is the global `fetch`. */
  readonly fetcher?: typeof fetch;
};

export class PosterApiError extends Error {
  public override readonly name = 'PosterApiError';
  public readonly method: string;
  public readonly status: number | undefined;
  public readonly posterCode: number | undefined;

  constructor(
    method: string,
    message: string,
    opts: { status?: number; posterCode?: number } = {},
  ) {
    super(`[poster:${method}] ${message}`);
    this.method = method;
    this.status = opts.status;
    this.posterCode = opts.posterCode;
  }
}

// -----------------------------------------------------------------------------
// Client implementation
// -----------------------------------------------------------------------------

const DEFAULT_BASE_URL = 'https://joinposter.com/api';

/**
 * The typed Poster client. One instance per process is enough; construct via
 * `createPosterClientFromConfig()` so the token is read from validated config.
 */
export class PosterClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly fetcher: typeof fetch;
  /** Serial gate — every call awaits this chain so requests run one at a time. */
  private gate: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;

  constructor(opts: PosterClientOptions) {
    if (typeof opts.token !== 'string' || opts.token.trim() === '') {
      throw new PosterApiError(
        '<init>',
        'Poster token is missing — set POSTER_TOKEN in .env before using the client.',
      );
    }
    this.token = opts.token.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.minIntervalMs = opts.minIntervalMs ?? 220;
    this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  // --- Public API methods --------------------------------------------------

  async getSpots(): Promise<PosterSpot[]> {
    const r = await this.call<PosterSpot[]>('access.getSpots');
    return r ?? [];
  }

  async getStorages(): Promise<PosterStorage[]> {
    const r = await this.call<PosterStorage[]>('storage.getStorages');
    return r ?? [];
  }

  async getStorageLeftovers(storageId: number): Promise<PosterLeftover[]> {
    const r = await this.call<PosterLeftover[]>('storage.getStorageLeftovers', {
      storage_id: String(storageId),
    });
    return r ?? [];
  }

  async getIngredients(): Promise<PosterIngredient[]> {
    const r = await this.call<PosterIngredient[]>('menu.getIngredients');
    return r ?? [];
  }

  async getProducts(): Promise<PosterMenuProductRow[]> {
    const r = await this.call<PosterMenuProductRow[]>('menu.getProducts');
    return r ?? [];
  }

  async getProduct(productId: number): Promise<PosterMenuProductFull | null> {
    const r = await this.call<PosterMenuProductFull | PosterMenuProductFull[]>(
      'menu.getProduct',
      { product_id: String(productId) },
    );
    if (r === null || r === undefined) return null;
    return Array.isArray(r) ? (r[0] ?? null) : r;
  }

  async getPrepacks(): Promise<PosterPrepack[]> {
    const r = await this.call<PosterPrepack[]>('menu.getPrepacks');
    return r ?? [];
  }

  /**
   * Fetch a sales check list. `dateFrom`/`dateTo` are `YYYY-MM-DD HH:mm:ss`
   * strings (Poster accepts them for `dash.getTransactions`).
   */
  async getTransactions(params: {
    dateFrom: string;
    dateTo: string;
    spotId?: number;
    num?: number;
  }): Promise<PosterTransactionSummary[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    if (params.num !== undefined) qs.num = String(params.num);
    const r = await this.call<PosterTransactionSummary[]>('dash.getTransactions', qs);
    return r ?? [];
  }

  async getTransaction(transactionId: number): Promise<PosterTransactionFull | null> {
    const r = await this.call<PosterTransactionFull | PosterTransactionFull[]>(
      'dash.getTransaction',
      { transaction_id: String(transactionId), include_products: 'true' },
    );
    if (r === null || r === undefined) return null;
    return Array.isArray(r) ? (r[0] ?? null) : r;
  }

  // --- Internal: throttled, timed-out, parameterized call -----------------

  private async call<T>(
    method: string,
    params: Readonly<Record<string, string>> = {},
  ): Promise<T | null> {
    // Serial gate — every call waits for the previous chain to settle, then
    // ensures we are at least `minIntervalMs` past the previous call's start.
    const ticket = this.gate.then(async () => {
      const gap = this.minIntervalMs - (Date.now() - this.lastCallAt);
      if (gap > 0) await delay(gap);
      this.lastCallAt = Date.now();
    });
    // Chain regardless of outcome — a slow/failed call must NOT block the gate.
    this.gate = ticket.catch(() => undefined);
    await ticket;

    const url = this.buildUrl(method, params);
    const ctrl = new AbortController();
    const t = globalThis.setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetcher(url, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) {
        // Do not leak the token in error messages — surface just the method.
        throw new PosterApiError(method, `HTTP ${res.status} ${res.statusText}`, {
          status: res.status,
        });
      }
      const body = (await res.json()) as
        | { response: T }
        | { error: { code: number; message: string } };
      if ('error' in body) {
        throw new PosterApiError(method, body.error.message, { posterCode: body.error.code });
      }
      return body.response ?? null;
    } catch (err) {
      if (err instanceof PosterApiError) throw err;
      const msg = (err as Error)?.message ?? String(err);
      // AbortError from the timeout has its own name; surface it cleanly.
      if ((err as Error)?.name === 'AbortError') {
        throw new PosterApiError(method, `request timed out after ${this.timeoutMs}ms`);
      }
      throw new PosterApiError(method, msg);
    } finally {
      globalThis.clearTimeout(t);
    }
  }

  private buildUrl(method: string, params: Readonly<Record<string, string>>): string {
    const url = new URL(`${this.baseUrl}/${method}`);
    url.searchParams.set('token', this.token);
    url.searchParams.set('format', 'json');
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }
}

/**
 * Lazy singleton — built from validated config on first access. Throws clearly
 * when `POSTER_TOKEN` is empty in `.env`.
 */
let cached: PosterClient | undefined;

export function createPosterClientFromConfig(): PosterClient {
  if (cached !== undefined) return cached;
  const cfg = loadConfig();
  if (cfg.poster.token === '') {
    throw AppError.internal(
      'POSTER_TOKEN is not configured — set it in .env before using Poster integration.',
    );
  }
  cached = new PosterClient({ token: cfg.poster.token });
  return cached;
}

/** TEST-ONLY — reset the singleton between suites. */
export function resetPosterClientCache(): void {
  cached = undefined;
}

/** TEST-ONLY — install a specific instance as the singleton. */
export function setPosterClientForTests(client: PosterClient | undefined): void {
  cached = client;
}
