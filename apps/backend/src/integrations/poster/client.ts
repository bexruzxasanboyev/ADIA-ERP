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
 *   - dash.getTransactions        — sales check list (fallback poll + revenue breakdown)
 *   - dash.getTransaction         — one check with line products
 *   - settings.getPaymentMethods  — payment-method id->title map (cached, TTL)
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
  /**
   * RAW-ingredient category id (the join target into
   * `menu.getCategoriesIngredients`). "0"/0 or absent = uncategorised.
   * Verified present on every `menu.getIngredients` row (2026-05-30).
   */
  category_id?: number | string;
};

/**
 * Row shape from `menu.getCategories` (doc §5.3). Verified live against the
 * `adia` Poster account 2026-05-30: every field arrives as a string. We only
 * need `category_id` + `category_name`; the rest (photo, color, tree pointers)
 * are surfaced as optional in case a later feature wants them.
 */
export type PosterCategory = {
  category_id: string;
  category_name: string;
  parent_category?: string;
  category_color?: string;
  category_hidden?: string;
  sort_order?: string;
};

/**
 * Row shape from `menu.getCategoriesIngredients` — the RAW-ingredient category
 * lookup. Verified live against the `adia` account 2026-05-30: 14 rows, each
 * `{ category_id, name }` (both strings). This is a DIFFERENT namespace from
 * `menu.getCategories` (finished goods) — the numeric ids collide but mean
 * different things, so callers must keep them separate (categories.kind).
 */
export type PosterIngredientCategory = {
  category_id: string;
  name: string;
};

export type PosterMenuProductRow = {
  product_id: string;
  product_name: string;
  /** "2" = stocked menu item, "3" = configured-via-modifications. */
  type: string;
  ingredient_id?: string;
  unit?: string;
  menu_category_id?: string;
  /**
   * Поster Цех приготовления — the production-workshop id this dish/тех.карта is
   * made in. "0" / absent = no workshop. Verified live on `menu.getProducts`
   * rows (2026-06-08).
   */
  workshop?: string;
  /** Display name of the dish's menu category (verified live 2026-06-08). */
  category_name?: string;
  /** Menu photo (CDN-relative). "" / absent = no photo. */
  photo?: string;
  /** Original (full-size) menu photo (CDN-relative). */
  photo_origin?: string;
};

/**
 * Row shape from `menu.getWorkshops` (doc §5.3) — a production workshop (Цех).
 * Verified live against the `adia` account 2026-06-08: 20 rows, each
 * `{ workshop_id, workshop_name, delete }` (all strings). `delete="1"` marks a
 * soft-deleted workshop.
 */
export type PosterWorkshop = {
  workshop_id: string;
  workshop_name: string;
  delete?: string;
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
  /**
   * Себестоимость of this composition LINE in TIYIN, for the line's
   * `structure_brutto` quantity (verified live 2026-05-30). For a RAW
   * (structure_type=1) line, the raw unit cost = selfprice ÷ brutto-in-unit.
   * Absent on some older fixtures — treat as unavailable then.
   */
  structure_selfprice?: number | string;
  structure_selfprice_netto?: number | string;
  ingredient_name: string;
  ingredient_unit: string;
};

/**
 * One modification under a finished product's `group_modifications` (Поля
 * "Размеры": ЦЕЛЫЙ / ПОЛОВИНА / КУСОК). `ingredient_id` here is a PREPACK's
 * `product_id` (NOT a raw ingredient id). `brutto` is the portion of one
 * prepack unit this modification consumes — ЦЕЛЫЙ is the full unit.
 */
export type PosterModification = {
  dish_modification_id: number | string;
  name: string;
  ingredient_id: number | string;
  type?: number | string;
  brutto?: number | string;
};

export type PosterModificationGroup = {
  dish_modification_group_id: number | string;
  name?: string;
  modifications?: PosterModification[];
};

export type PosterMenuProductFull = PosterMenuProductRow & {
  ingredients?: PosterRecipeIngredient[];
  /** Себестоимость of the finished product (TIYIN); often "0" / stale. */
  cost?: number | string;
  cost_netto?: number | string;
  /** Размеры variants — present when the product has no flat `ingredients`. */
  group_modifications?: PosterModificationGroup[];
};

export type PosterPrepack = {
  product_id: string;
  ingredient_id: string;
  product_name: string;
  /** Yield of one batch — used to normalise BOM qty per produced unit. */
  out: number | string;
  /** Себестоимость of the whole `out` batch (TIYIN); may be stale — see sync. */
  cost?: number | string;
  cost_netto?: number | string;
  ingredients: PosterRecipeIngredient[];
};

export type PosterTransactionLine = {
  product_id: string;
  modification_id?: string;
  /**
   * Quantity sold. For PIECE products this is an integer count; for WEIGHTED
   * ("КГ") products Poster reports the weight in a sub-unit (e.g. 100g steps),
   * so `num` is NOT a count and MUST NOT be multiplied by `product_price` —
   * doing so over-states revenue ~Nx. See `salesSync.ingestTransaction`.
   */
  num: string;
  /**
   * LINE TOTAL (gross, before discounts) in TIYIN — verified live against the
   * `adia` account 2026-06-08: `sum(product_price)` over a check's lines equals
   * the check's `sum` field exactly. It is NOT a per-unit price. Divide by 100
   * for so'm.
   */
  product_price: string;
  /**
   * LINE TOTAL (NET, after discounts/bonus) in TIYIN — verified live 2026-06-08:
   * `sum(payed_sum)` over a store's closed checks reconciles EXACTLY to that
   * store's `dash.getTransactions` revenue-breakdown total. This is the
   * authoritative per-line money source. Divide by 100 for so'm.
   */
  payed_sum?: string;
};

export type PosterTransactionSummary = {
  transaction_id: string;
  spot_id: string;
  date_close?: string;
  status?: string;
  sum?: string;
  /**
   * Revenue-breakdown fields (verified live against `adia` 2026-06-06). All
   * money is in TIYIN (string). `pay_type`: "0" open/unpaid, "1" cash,
   * "2" card, "3" mixed. `payment_method_id` is the custom-method id (string;
   * "0" = no custom method -> use the cash/card split). Optional because
   * `dash.getTransactions` is also used by the sales-sync poll, which ignores
   * them.
   */
  pay_type?: string | number;
  payment_method_id?: string | number;
  payed_cash?: string | number;
  payed_card?: string | number;
  payed_third_party?: string | number;
  payed_ewallet?: string | number;
  payed_bonus?: string | number;
  payed_sum?: string | number;
};

/**
 * Revenue-breakdown — one row from `settings.getPaymentMethods` (verified live
 * against `adia` 2026-06-06). Built-in ids 1=cash, 2=card; custom methods
 * (Payme=19, Click=20 for `adia`) get the next free integer and are
 * account-specific — match by `title` for stability. All fields arrive as
 * strings.
 */
export type PosterPaymentMethod = {
  payment_method_id: string;
  title: string;
  /** "1"=cash-type, "2"=card-type, "3"=external/other (Poster convention). */
  type?: string;
};

export type PosterTransactionFull = PosterTransactionSummary & {
  products?: PosterTransactionLine[];
};

/**
 * Sub-task #7 — row shape returned by `dash.getPaymentsReport`. Aggregates
 * sales by payment method for a date range. Poster groups by day-and-method;
 * `payment_count`/`payment_sum` are strings (Poster numeric convention).
 *
 * Fields seen in real responses:
 *   date          — YYYY-MM-DD
 *   spot_id       — present when `spot_id` parameter was set
 *   payment_id    — built-in 1=cash, 2=card; custom methods get next free int
 *   payment_title — operator-chosen label ("Payme", "Click", "Naqd")
 *   payment_count — integer string ("17")
 *   payment_sum   — money string in the venue's currency ("1234500")
 */
export type PosterPaymentReportRow = {
  date?: string;
  spot_id?: string | number;
  payment_id: string | number;
  payment_title: string;
  payment_count: string | number;
  payment_sum: string | number;
};

/**
 * Real `dash.getPaymentsReport` response shape verified against the live
 * `adia` Poster account on 2026-05-28. Poster does NOT emit an array of
 * `{payment_id, payment_title, payment_sum}` rows — it emits a single
 * aggregate object with a per-day breakdown and a grand `total` block.
 * Money is in tiyin (1 so'm = 100). All numeric-looking fields may arrive
 * as either strings or numbers — Poster is inconsistent across endpoints.
 */
export type PosterPaymentDay = {
  date: string;
  payed_cash_sum?: string | number;
  payed_card_sum?: string | number;
  payed_cert_in_sum?: string | number;
  payed_cert_out_sum?: string | number;
  payed_bonus_sum?: string | number;
  payed_third_party_sum?: string | number;
  payed_ewallet_sum?: string | number;
  payed_sum_sum?: string | number;
  round_sum?: string | number;
};

export type PosterPaymentTotal = {
  payed_cash_sum?: string | number;
  payed_card_sum?: string | number;
  payed_cert_in_sum?: string | number;
  payed_cert_out_sum?: string | number;
  payed_bonus_sum?: string | number;
  payed_third_party_sum?: string | number;
  payed_ewallet_sum?: string | number;
  payed_sum_sum?: string | number;
  transactions_count?: string | number;
};

export type PosterPaymentReport = {
  days?: PosterPaymentDay[];
  total: PosterPaymentTotal;
};

/**
 * Top-selling-products — one row from `dash.getProductsSales` (verified live
 * against the `adia` Poster account on 2026-06-06). Poster emits one row per
 * product+modification, so a product with several modifications appears in
 * several rows and must be aggregated by `product_id`.
 *
 * Money fields (`payed_sum`, `product_sum`, `product_profit`) are in TIYIN
 * (string) — divide by 100 via `tiyinToSom`. `count` is the quantity sold as a
 * decimal string ("12.5"). All numeric-looking fields arrive as strings.
 */
export type PosterProductSalesRow = {
  product_id: string;
  product_name: string;
  modificator_name?: string;
  modification_id?: string;
  category_id?: string;
  /**
   * Quantity sold (decimal string, e.g. "12.5"). Its UNIT depends on
   * `weight_flag`: for piece-sold products this is an integer count of pieces;
   * for weight-sold products it is a decimal weight in the `unit` (e.g. kg).
   * Verified live 2026-06-06: `count` and `count_converted` are equal for the
   * `adia` catalogue (no secondary-unit conversion configured), so `count` is
   * the canonical quantity field for both product types.
   */
  count: string;
  /**
   * Quantity sold in the product's CONVERTED unit (decimal string). Equal to
   * `count` when no unit conversion is configured (the live `adia` case). Kept
   * for completeness; the route reads `count`.
   */
  count_converted?: string;
  /**
   * Sale-mode flag (verified live 2026-06-06):
   *   "1" -> sold BY WEIGHT  (`unit` = "kg"; `count` is a decimal weight).
   *   "0" -> sold BY PIECE   (`unit` = "p";  `count` is an integer count).
   * Drives the displayed quantity unit on the dashboard.
   */
  weight_flag?: string | number;
  /** Gross paid amount in TIYIN (string). */
  payed_sum: string;
  /** Product sum in TIYIN (string). */
  product_sum?: string;
  /** Product profit in TIYIN (string). */
  product_profit?: string;
  /**
   * Unit of `count` as Poster reports it ("p" = pieces / dona, "kg" = weight).
   * Mirrors `weight_flag`; the route normalises this to a stable display unit.
   */
  unit?: string;
};

/**
 * EPIC 0.1 / 0.2 / P4 — `dash.getAnalytics` response (doc §5.1).
 *
 * UNIT NOTE: unlike `getPaymentsReport` (tiyin), the analytics `data` series
 * and `counters.revenue` are ALREADY in so'm — verified live 2026-05-29:
 * the 2026-05-29 daily revenue was "19553300.0000" (so'm) here vs
 * 1955330000 (tiyin) in getPaymentsReport. So NO ÷100 for analytics values.
 *
 * `data` is the per-interval series (one entry per day when
 * `interpolate=day`). Values are decimal strings ("31059707.0000").
 */
export type PosterAnalyticsCounters = {
  revenue?: string | number;
  profit?: string | number;
  transactions?: string | number;
  visitors?: string | number;
  average_receipt?: string | number;
  average_time?: string | number;
};

export type PosterAnalytics = {
  data?: Array<string | number>;
  data_hourly?: Array<string | number>;
  data_weekday?: Array<string | number>;
  counters?: PosterAnalyticsCounters;
};

/**
 * EPIC 8.5 / P8 — `finance.getCashshifts` row (kassa smenasi). One row per
 * opened/closed cash-register shift. Money fields are in TIYIN (Poster finance
 * convention — divide by 100 via `tiyinToSom`). Field names follow Poster's
 * public finance schema; all numeric fields may arrive as string or number.
 *
 *   cash_shift_id     — shift id.
 *   spot_id           — the retail spot (maps to an ADIA store).
 *   amount_start      — opening till float.
 *   amount_end        — closing till count (factual cash counted).
 *   amount_sell_cash  — cash sales during the shift.
 *   amount_sell_card  — card / non-cash sales during the shift.
 *   amount_debit      — pay-outs from the till (rasxod / expenses).
 *   amount_collection — cash collected up the chain (inkassatsiya).
 *   date_start/end    — open/close timestamps ("YYYY-MM-DD HH:mm:ss").
 *   user_id           — cashier (Poster employee id).
 */
export type PosterCashShift = {
  cash_shift_id: string | number;
  spot_id?: string | number;
  amount_start?: string | number;
  amount_end?: string | number;
  amount_sell_cash?: string | number;
  amount_sell_card?: string | number;
  amount_debit?: string | number;
  amount_collection?: string | number;
  date_start?: string;
  date_end?: string | null;
  user_id?: string | number;
};

/**
 * TZ Module 15 / P8 — one spot row nested under a `finance.getAccounts`
 * account. Verified live against the `adia` account (2026-06-09): every
 * account carries a `spots[]` array linking it to the retail spots it serves;
 * `account_cash`/`account_bank`/`account_collection` are the per-spot money
 * account ids (cash box / bank / collection). We read `account_cash` to resolve
 * a store's safe (cash-box) balance from its `spot_id`. Numeric fields arrive
 * as numbers here (unlike most Poster string fields).
 */
export type PosterAccountSpot = {
  spot_id: string | number;
  spot_name?: string;
  /** The cash-box account id that backs this spot's till. */
  account_cash?: string | number;
  account_bank?: string | number;
  account_collection?: string | number;
};

/**
 * TZ Module 15 / P8 — `finance.getAccounts` row ("Hisob raqamlar"). One money
 * account (cash box / safe / supplier ledger). Verified live against the `adia`
 * account (2026-06-09): 64 accounts. Money is in TIYIN (string, MAY be
 * negative — supplier ledgers run negative). `type` is Poster's account-kind
 * code as a string: "1" = non-cash / supplier ledger, "3" = cash-box / safe
 * (Сейф, Денежный ящик …). All numeric-looking fields may arrive as string or
 * number; the client normalises `balance` to so'm and keeps `type` as a string.
 *
 *   account_id  — account id.
 *   name        — account label ("Сейф", "Денежный ящик Кукча"…).
 *   type        — account-kind code ("1" non-cash, "3" cash box).
 *   balance     — current balance in TIYIN (may be negative).
 *   spots       — the retail spots this account serves (→ per-spot cash account).
 */
export type PosterAccount = {
  account_id: string | number;
  name?: string;
  type?: string | number;
  balance?: string | number;
  balance_start?: string | number;
  currency_code_iso?: string;
  spots?: PosterAccountSpot[];
};

/**
 * EPIC 8.7 / P8 — `finance.getTransactions` row (moliyaviy operatsiya). A safe
 * (seyf) income/expense entry. `type` 0 = expense (rasxod), 1 = income; we
 * surface expenses for the safe-expense view. `amount` is in TIYIN.
 *
 *   transaction_id  — finance transaction id.
 *   account_id      — the money account (the safe).
 *   category_id     — expense/income category id.
 *   category_name   — category label ("Ijara", "Maosh"…).
 *   type            — "0" expense, "1" income.
 *   amount          — money in tiyin (positive).
 *   date            — "YYYY-MM-DD HH:mm:ss".
 *   user_id         — who recorded it.
 *   comment         — free-text note.
 */
export type PosterFinanceTransaction = {
  transaction_id: string | number;
  account_id?: string | number;
  category_id?: string | number;
  category_name?: string;
  type?: string | number;
  amount?: string | number;
  date?: string;
  user_id?: string | number;
  comment?: string | null;
};

/**
 * TZ Module 8 (seller KPI) — one row from `dash.getWaitersSales` ("Ofitsiantlar
 * reytingi"). HISTORICAL per-waiter (seller) revenue for the date range,
 * filterable by `spot_id`. Verified live against the `adia` account
 * (2026-06-09):
 *
 *   { user_id:"5", name:"Муяссар Икромова", profit:"60911440404",
 *     revenue:"84799376770", clients:"5793", ... }
 *
 * THE UNIT — `revenue` is in TIYIN (string). SUM(revenue) over all waiters for
 * a month divided by `dash.getAnalytics.counters.revenue` (known so'm) for the
 * SAME window is EXACTLY 100, so the client divides by 100 (`tiyinToSom`)
 * before it reconciles with every other so'm figure in the app. A per-spot
 * call partitions revenue cleanly (a waiter shows non-zero revenue only on the
 * spot(s) they actually sold at) — that is how we attribute a seller to a
 * store. `user_id` is Poster's waiter id (kept as a string).
 */
export type PosterWaiterSales = {
  user_id: string;
  name: string;
  revenue: string;
  profit?: string;
  clients?: string;
};

// -----------------------------------------------------------------------------
// Client options + errors
// -----------------------------------------------------------------------------

export type PosterClientOptions = {
  /** Personal Integration token (account:32hex). REQUIRED for any call. */
  readonly token: string;
  /** Override the base URL (used by tests). Defaults to the public Poster host. */
  readonly baseUrl?: string;
  /**
   * Per-call timeout in ms. Default: 20_000 (20s).
   *
   * I9 (Sprint 3 audit P2): Poster's first call after a cold idle window is
   * 4–5s; the previous 10s default left almost no headroom and the FIRST
   * `menu.getIngredients` after process start surfaced as `fetch failed`.
   * 20s gives a comfortable margin while still bounding a stuck request.
   */
  readonly timeoutMs?: number;
  /** Minimum gap between calls in ms. Default: 220 (≈4.5 req/sec, under 5). */
  readonly minIntervalMs?: number;
  /** Injection point for tests — default is the global `fetch`. */
  readonly fetcher?: typeof fetch;
  /**
   * Transient-failure retry attempts. Default: 1 (so up to 2 total attempts).
   * Only `AbortError` (timeout) and bare `fetch failed` / network errors are
   * retried — 4xx/5xx Poster envelopes pass through untouched. Backoff is a
   * fixed 300ms gap before the retry.
   */
  readonly transientRetries?: number;
  /** TTL for the in-memory `getPaymentMethods` cache. Default: 600_000 (10 min). */
  readonly paymentMethodsTtlMs?: number;
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
  private readonly transientRetries: number;
  /** Serial gate — every call awaits this chain so requests run one at a time. */
  private gate: Promise<unknown> = Promise.resolve();
  private lastCallAt = 0;
  /**
   * In-memory cache for `settings.getPaymentMethods` — the id->title map rarely
   * changes, so we avoid refetching on every dashboard hit. Invalidated by TTL.
   */
  private paymentMethodsCache:
    | { at: number; value: PosterPaymentMethod[] }
    | undefined;
  private readonly paymentMethodsTtlMs: number;

  constructor(opts: PosterClientOptions) {
    if (typeof opts.token !== 'string' || opts.token.trim() === '') {
      throw new PosterApiError(
        '<init>',
        'Poster token is missing — set POSTER_TOKEN in .env before using the client.',
      );
    }
    this.token = opts.token.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.minIntervalMs = opts.minIntervalMs ?? 220;
    this.fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
    this.transientRetries = opts.transientRetries ?? 1;
    this.paymentMethodsTtlMs = opts.paymentMethodsTtlMs ?? 10 * 60_000;
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

  /** All Poster product categories (menu.getCategories — doc §5.3). */
  async getCategories(): Promise<PosterCategory[]> {
    const r = await this.call<PosterCategory[]>('menu.getCategories');
    return r ?? [];
  }

  /**
   * All Poster production workshops (Цехи — menu.getWorkshops, doc §5.3). Used
   * to seed `locations(type='production', poster_workshop_id=…)`. Returns `[]`
   * when none.
   */
  async getWorkshops(): Promise<PosterWorkshop[]> {
    const r = await this.call<PosterWorkshop[]>('menu.getWorkshops');
    return r ?? [];
  }

  /**
   * RAW-ingredient categories (menu.getCategoriesIngredients). A SEPARATE
   * namespace from getCategories — used to group `products(type='raw')`.
   */
  async getIngredientCategories(): Promise<PosterIngredientCategory[]> {
    const r = await this.call<PosterIngredientCategory[]>('menu.getCategoriesIngredients');
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
   * Fetch a sales check list. `dateFrom`/`dateTo` are `YYYY-MM-DD` (or
   * `YYYY-MM-DD HH:mm:ss`) strings — Poster accepts them for
   * `dash.getTransactions`.
   *
   * Pagination: Poster pages with `num` (page size, max 1000) + `offset`. A
   * single `num`-only call without `offset` returns at most `num` rows and
   * silently truncates a busy day. When `paginate` is true we loop on `offset`
   * until a page comes back shorter than `num` (or the safety cap is hit), so a
   * long range (e.g. 6 months) returns every row. The legacy sales-sync poll
   * keeps the old single-page behaviour by leaving `paginate` undefined.
   */
  async getTransactions(params: {
    dateFrom: string;
    dateTo: string;
    spotId?: number;
    num?: number;
    /** When true, loop on `offset` until all rows are fetched. */
    paginate?: boolean;
    /** Safety cap on total rows when paginating. Default: 100_000. */
    maxRows?: number;
  }): Promise<PosterTransactionSummary[]> {
    const pageSize = params.num ?? 1000;
    const baseQs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      num: String(pageSize),
    };
    if (params.spotId !== undefined) baseQs.spot_id = String(params.spotId);

    if (params.paginate !== true) {
      const r = await this.call<PosterTransactionSummary[]>(
        'dash.getTransactions',
        baseQs,
      );
      return r ?? [];
    }

    const maxRows = params.maxRows ?? 100_000;
    const all: PosterTransactionSummary[] = [];
    let offset = 0;
    // Hard cap on iterations as a belt-and-braces guard against a Poster page
    // that never shrinks (would otherwise loop forever).
    for (let page = 0; page < 1000; page += 1) {
      const r = await this.call<PosterTransactionSummary[]>('dash.getTransactions', {
        ...baseQs,
        offset: String(offset),
      });
      const rows = r ?? [];
      all.push(...rows);
      if (rows.length < pageSize || all.length >= maxRows) break;
      offset += pageSize;
    }
    return all.slice(0, maxRows);
  }

  /**
   * Revenue-breakdown — the account's payment-method id->title map
   * (`settings.getPaymentMethods`). Cached in-memory with a TTL since it rarely
   * changes (operators add a method maybe once a quarter). Used to resolve a
   * transaction's `payment_method_id` to a canonical bucket (cash/card/payme/
   * click/other) WITHOUT hardcoding ids — ids differ per account, titles are
   * stable.
   */
  async getPaymentMethods(): Promise<PosterPaymentMethod[]> {
    const now = Date.now();
    const cached = this.paymentMethodsCache;
    if (cached !== undefined && now - cached.at < this.paymentMethodsTtlMs) {
      return cached.value;
    }
    // Poster returns either an array or an id-keyed object map — normalise.
    const r = await this.call<PosterPaymentMethod[] | Record<string, PosterPaymentMethod>>(
      'settings.getPaymentMethods',
    );
    let value: PosterPaymentMethod[];
    if (Array.isArray(r)) {
      value = r;
    } else if (r !== null && typeof r === 'object') {
      value = Object.values(r);
    } else {
      value = [];
    }
    this.paymentMethodsCache = { at: now, value };
    return value;
  }

  /**
   * Sub-task #7 — sales aggregated by payment method.
   * Date strings follow Poster's `YYYYMMDD` convention.
   */
  async getPaymentsReport(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string;   // YYYYMMDD
    spotId?: number;
  }): Promise<PosterPaymentReportRow[] | PosterPaymentReport> {
    // Poster returns ONE of two shapes here:
    //   • the real `{days, total}` aggregate (production today);
    //   • a legacy/synthetic per-method row array (used by older tests).
    // We return the raw response and let the caller branch on shape — that
    // way a future Poster format change touches one place, not every caller.
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    const r = await this.call<PosterPaymentReportRow[] | PosterPaymentReport>(
      'dash.getPaymentsReport',
      qs,
    );
    return r ?? [];
  }

  /**
   * EPIC 0.1 / 0.2 — `dash.getAnalytics`: revenue/profit/transactions series.
   * The single authoritative revenue source (already in so'm — see
   * `PosterAnalytics`). Used by the dashboard chart + historical backfill so
   * the 30-day chart reflects Poster instead of the locally-corrupted `sales`
   * aggregate. Date strings follow Poster's `YYYYMMDD` convention.
   */
  async getAnalytics(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string; // YYYYMMDD
    interpolate?: 'day' | 'week' | 'month';
    select?: 'revenue' | 'profit' | 'transactions' | 'visitors' | 'average_receipt';
    spotId?: number;
  }): Promise<PosterAnalytics> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      interpolate: params.interpolate ?? 'day',
      select: params.select ?? 'revenue',
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    const r = await this.call<PosterAnalytics>('dash.getAnalytics', qs);
    return r ?? {};
  }

  /**
   * Top-selling products in a date range (`dash.getProductsSales`). Poster
   * returns one row per product+modification — the caller aggregates by
   * `product_id`. Date strings follow Poster's `YYYYMMDD` convention. String
   * fields are normalised so every row has the keys the aggregator reads.
   */
  async getProductsSales(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string; // YYYYMMDD
    spotId?: number;
  }): Promise<PosterProductSalesRow[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    const r = await this.call<PosterProductSalesRow[]>('dash.getProductsSales', qs);
    if (!Array.isArray(r)) return [];
    return r.map((row) => {
      const out: PosterProductSalesRow = {
        product_id: String(row.product_id ?? ''),
        product_name: String(row.product_name ?? ''),
        count: String(row.count ?? '0'),
        payed_sum: String(row.payed_sum ?? '0'),
      };
      if (row.modificator_name !== undefined) out.modificator_name = String(row.modificator_name);
      if (row.modification_id !== undefined) out.modification_id = String(row.modification_id);
      if (row.category_id !== undefined) out.category_id = String(row.category_id);
      if (row.product_sum !== undefined) out.product_sum = String(row.product_sum);
      if (row.product_profit !== undefined) out.product_profit = String(row.product_profit);
      if (row.unit !== undefined) out.unit = String(row.unit);
      return out;
    });
  }

  async getTransaction(transactionId: number): Promise<PosterTransactionFull | null> {
    const r = await this.call<PosterTransactionFull | PosterTransactionFull[]>(
      'dash.getTransaction',
      { transaction_id: String(transactionId), include_products: 'true' },
    );
    if (r === null || r === undefined) return null;
    return Array.isArray(r) ? (r[0] ?? null) : r;
  }

  /**
   * EPIC 8.5 — cash-register shifts in a date range (read-only). Date strings
   * follow Poster's `YYYYMMDD` convention. Returns `[]` when none.
   */
  async getCashShifts(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string; // YYYYMMDD
    spotId?: number;
  }): Promise<PosterCashShift[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    // NB: Poster method names are CASE-SENSITIVE. The correct method is
    // `finance.getCashShifts` (capital S) — the lowercase `finance.getCashshifts`
    // returns HTTP 405 `{code:30, Method Not Allowed}` for the `adia` token.
    // Verified live 2026-06-01.
    const r = await this.call<PosterCashShift[]>('finance.getCashShifts', qs);
    return r ?? [];
  }

  /**
   * TZ Module 8 (seller KPI) — per-waiter (seller) revenue in a date range via
   * `dash.getWaitersSales`. Date strings follow Poster's `YYYYMMDD` convention.
   * When `spotId` is set the revenue is the waiter's revenue AT THAT SPOT only
   * (Poster partitions it), which is how we attribute a seller to a store.
   *
   * Rows are normalised so every entry has `user_id`/`name`/`revenue` as
   * strings (Poster numeric fields arrive as strings). `revenue` is left in
   * TIYIN — the caller divides by 100 (`tiyinToSom`). Returns `[]` when Poster
   * yields nothing; a method-level failure is left to the caller to degrade.
   */
  async getWaiterSales(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string; // YYYYMMDD
    spotId?: number;
  }): Promise<PosterWaiterSales[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.spotId !== undefined) qs.spot_id = String(params.spotId);
    const r = await this.call<PosterWaiterSales[]>('dash.getWaitersSales', qs);
    if (!Array.isArray(r)) return [];
    return r.map((row) => {
      const out: PosterWaiterSales = {
        user_id: String(row.user_id ?? ''),
        name: String(row.name ?? ''),
        revenue: String(row.revenue ?? '0'),
      };
      if (row.profit !== undefined) out.profit = String(row.profit);
      if (row.clients !== undefined) out.clients = String(row.clients);
      return out;
    });
  }

  /**
   * EPIC 8.7 — finance transactions (safe income/expense) in a date range
   * (read-only). Date strings follow Poster's `YYYYMMDD` convention.
   */
  async getFinanceTransactions(params: {
    dateFrom: string; // YYYYMMDD
    dateTo: string; // YYYYMMDD
    accountId?: number;
  }): Promise<PosterFinanceTransaction[]> {
    const qs: Record<string, string> = {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    };
    if (params.accountId !== undefined) qs.account_id = String(params.accountId);
    const r = await this.call<PosterFinanceTransaction[]>('finance.getTransactions', qs);
    return r ?? [];
  }

  /**
   * TZ Module 15 — money accounts ("Hisob raqamlar", `finance.getAccounts`),
   * read-only. Returns every account with its TIYIN balance and the spots it
   * serves — used to read a store's safe (cash-box) balance for the kassir
   * reconciliation. Returns `[]` when Poster yields nothing. Takes no
   * parameters (Poster ignores any). Verified live shape 2026-06-09.
   */
  async getAccounts(): Promise<PosterAccount[]> {
    const r = await this.call<PosterAccount[]>('finance.getAccounts');
    return r ?? [];
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

    // I9 (Sprint 3 audit P2): retry once on transient network failures
    // (`fetch failed` from undici, `AbortError` from our own timeout). Poster
    // HTTP 4xx/5xx envelopes and `error: {...}` envelopes are NOT retried —
    // they are deterministic API responses and a retry would be wasted work.
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.transientRetries; attempt += 1) {
      try {
        return await this.callOnce<T>(method, params);
      } catch (err) {
        lastErr = err;
        if (!this.isTransient(err) || attempt === this.transientRetries) {
          throw err;
        }
        // Fixed 300ms backoff — the rate-limit gate already enforces 220ms.
        await delay(300);
      }
    }
    // Unreachable — the loop either returns or throws.
    throw lastErr;
  }

  /** Single HTTP attempt. The outer `call()` wraps this with retry. */
  private async callOnce<T>(
    method: string,
    params: Readonly<Record<string, string>>,
  ): Promise<T | null> {
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

  /**
   * Decide whether an error is worth retrying. Transient = the call never
   * reached a real Poster response (network drop, DNS, our own timeout).
   * A `PosterApiError` with `status` set means we got an HTTP response from
   * Poster (4xx/5xx) — that is NOT transient. A `PosterApiError` with
   * `posterCode` set means Poster returned an `{error}` envelope — also
   * not transient. Only timeouts and bare network failures retry.
   */
  private isTransient(err: unknown): boolean {
    if (err instanceof PosterApiError) {
      if (err.status !== undefined || err.posterCode !== undefined) return false;
      const m = err.message ?? '';
      return /timed out|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(m);
    }
    const e = err as { name?: string; message?: string };
    if (e?.name === 'AbortError') return true;
    return /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(e?.message ?? '');
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
