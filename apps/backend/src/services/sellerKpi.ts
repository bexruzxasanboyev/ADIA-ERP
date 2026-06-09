/**
 * TZ Module 8 — SELLER-level "Do'kon KPI" read service (Variant B).
 *
 * The store-level KPI (`routes/storeKpi.ts`) ranks STORES from the local
 * `sales` table. This service adds the per-SELLER (cashier / waiter) layer:
 * each seller's monthly sales total, an optional PM-entered target, the
 * achievement %, month-over-month growth, and a seller leaderboard.
 *
 * WHY VARIANT B — the local `sales` table has NO seller dimension (a sale row
 * carries store_id + product_id only) and historical sales cannot be
 * re-attributed to a seller. Poster's `dash.getWaitersSales` returns HISTORICAL
 * per-waiter revenue immediately, filterable by spot + date range. So the
 * ACTUAL revenue is read LIVE from Poster; the DB persists only the seller
 * identity (`sellers`) and the plan (`seller_sales_plan`).
 *
 * SELLER -> STORE — Poster partitions a waiter's revenue per spot. We call
 * `getWaiterSales` once PER mapped spot, so a waiter's revenue at that spot is
 * attributed to the ADIA store behind the spot (the SAME spot->store map as
 * `cashShift.ts`). A waiter who sold at two stores yields two KPI rows (one per
 * store) — `store_id` disambiguates. Revenue arrives in TIYIN; we divide by 100
 * (`tiyinToSom`) so it reconciles with every other so'm figure.
 *
 * INVARIANTS: read-only against Poster (no write-back). The only DB write is
 * the idempotent `sellers` upsert (lazy sync) — done in one transaction.
 */
import { query, withTransaction, type TxClient } from '../db/index.js';
import type { PosterClient } from '../integrations/poster/client.js';
import { tiyinToSom } from '../integrations/poster/posterMoney.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A spot mapped to its ADIA store (only active stores with a Poster spot). */
type SpotStore = { spotId: number; storeId: number; storeName: string };

/** A resolved seller row (after the sellers upsert). */
type SellerRow = { id: number; posterWaiterId: string; name: string };

/** One seller's revenue at one store, for one month. Keyed by waiter+store. */
type SellerStoreRevenue = {
  posterWaiterId: string;
  name: string;
  storeId: number;
  storeName: string;
  revenueSom: number;
};

/** The per-seller KPI item the route serialises. */
export type SellerKpiItem = {
  seller_id: number;
  poster_waiter_id: string;
  name: string;
  store_id: number;
  store_name: string;
  target_sum: number | null;
  actual_sum: number;
  achievement_pct: number | null;
  prev_month_actual: number;
  growth_pct_mom: number | null;
  rank: number;
};

export type SellerKpiResult = {
  month: string;
  items: SellerKpiItem[];
  summary: {
    total_target: number;
    total_actual: number;
    achievement_pct: number | null;
  };
};

/** A resolved month window in the `YYYYMMDD` form Poster wants, plus labels. */
export type SellerMonthWindow = {
  /** 'YYYY-MM' label of the target month. */
  label: string;
  /** 'YYYY-MM' label of the previous month. */
  prevLabel: string;
  /** Target month bounds (YYYYMMDD, inclusive). */
  curFrom: string;
  curTo: string;
  /** Previous month bounds (YYYYMMDD, inclusive). */
  prevFrom: string;
  prevTo: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `YYYYMMDD` for a UTC (year, 1-12 month, day). */
function posterDay(year: number, month: number, day: number): string {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

/**
 * Build a Poster-facing window for the `YYYY-MM` label: the target month's
 * first/last calendar day and the previous month's, all as `YYYYMMDD`. Pure —
 * exported for unit testing.
 */
export function buildSellerMonthWindow(label: string): SellerMonthWindow {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (m === null) {
    throw new Error(`buildSellerMonthWindow: expected 'YYYY-MM', got ${label}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  // Last day of a month: day 0 of the NEXT month (UTC).
  const curLastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevLastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  return {
    label,
    prevLabel: `${prevYear}-${String(prevMonth).padStart(2, '0')}`,
    curFrom: posterDay(year, month, 1),
    curTo: posterDay(year, month, curLastDay),
    prevFrom: posterDay(prevYear, prevMonth, 1),
    prevTo: posterDay(prevYear, prevMonth, prevLastDay),
  };
}

/**
 * Load every (poster_spot_id -> ADIA store) for active stores — the SAME query
 * `cashShift.ts` uses, optionally narrowed to an allowed store-id set (RBAC).
 */
async function loadSpotStores(allowedStoreIds: number[] | null): Promise<SpotStore[]> {
  const { rows } = await query<{ id: string; poster_spot_id: string | null; name: string }>(
    `SELECT id, poster_spot_id, name
       FROM locations
      WHERE type = 'store' AND is_active = TRUE AND poster_spot_id IS NOT NULL`,
  );
  const allowed = allowedStoreIds === null ? null : new Set(allowedStoreIds);
  const out: SpotStore[] = [];
  for (const r of rows) {
    if (r.poster_spot_id === null) continue;
    const storeId = Number(r.id);
    if (allowed !== null && !allowed.has(storeId)) continue;
    out.push({ spotId: Number(r.poster_spot_id), storeId, storeName: r.name });
  }
  return out;
}

/**
 * Fetch per-(waiter, store) revenue for a single month window across the given
 * spots. One Poster call per spot; a waiter's revenue at that spot is the
 * store's revenue. Rows with zero revenue are dropped (Poster lists a waiter on
 * a spot even when they sold nothing there — that is not a real seller-store).
 */
async function fetchRevenueByWaiterStore(
  poster: PosterClient,
  spots: SpotStore[],
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, SellerStoreRevenue>> {
  const byKey = new Map<string, SellerStoreRevenue>();
  for (const spot of spots) {
    const rows = await poster.getWaiterSales({ dateFrom, dateTo, spotId: spot.spotId });
    for (const w of rows) {
      const waiterId = w.user_id.trim();
      if (waiterId === '') continue;
      const revenueSom = round2(tiyinToSom(w.revenue));
      if (revenueSom <= 0) continue; // not a seller AT this spot in this window.
      const key = `${waiterId}::${spot.storeId}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          posterWaiterId: waiterId,
          name: w.name.trim() || `Poster #${waiterId}`,
          storeId: spot.storeId,
          storeName: spot.storeName,
          revenueSom,
        });
      } else {
        // A store backed by >1 spot would sum the waiter's revenue across them.
        existing.revenueSom = round2(existing.revenueSom + revenueSom);
      }
    }
  }
  return byKey;
}

/**
 * Upsert every seen waiter into `sellers` (identity sync) and return the
 * resolved id/name per `poster_waiter_id`. One transaction; the name is
 * refreshed on conflict so a Poster rename propagates. `waiters` is the set of
 * (id -> latest name) seen across the current AND previous month.
 */
async function upsertSellers(
  waiters: Map<string, string>,
): Promise<Map<string, SellerRow>> {
  const out = new Map<string, SellerRow>();
  if (waiters.size === 0) return out;
  await withTransaction(async (tx: TxClient) => {
    for (const [waiterId, name] of waiters) {
      const { rows } = await tx.query<{ id: string; poster_waiter_id: string; name: string }>(
        `INSERT INTO sellers (poster_waiter_id, name)
         VALUES ($1, $2)
         ON CONFLICT (poster_waiter_id)
         DO UPDATE SET name = EXCLUDED.name
         RETURNING id, poster_waiter_id, name`,
        [waiterId, name],
      );
      const r = rows[0];
      if (r !== undefined) {
        out.set(r.poster_waiter_id, {
          id: Number(r.id),
          posterWaiterId: r.poster_waiter_id,
          name: r.name,
        });
      }
    }
  });
  return out;
}

/** Load the seller_sales_plan target_sum for a month, keyed by seller_id. */
async function loadPlans(
  sellerIds: number[],
  month: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (sellerIds.length === 0) return out;
  const { rows } = await query<{ seller_id: string; target_sum: string }>(
    `SELECT seller_id, target_sum
       FROM seller_sales_plan
      WHERE month = $1 AND seller_id = ANY($2::bigint[])`,
    [month, sellerIds],
  );
  for (const r of rows) out.set(Number(r.seller_id), Number(r.target_sum));
  return out;
}

// ---------------------------------------------------------------------------
// Public: compute the seller KPI for a month, RBAC-scoped to allowed stores.
// ---------------------------------------------------------------------------

export type ComputeSellerKpiArgs = {
  /** 'YYYY-MM'. */
  readonly month: string;
  /**
   * RBAC store scope: `null` = every active store (pm / ai_assistant);
   * an array = only these store ids (store_manager). An EMPTY array means the
   * caller has no stores -> empty result (the caller usually short-circuits).
   */
  readonly allowedStoreIds: number[] | null;
};

/**
 * Build the seller leaderboard for `month`. Reads live Poster waiter revenue
 * per spot, attributes it to ADIA stores, syncs the seller identities, joins
 * the plan, and computes achievement % + MoM growth + rank.
 *
 * A method-level Poster failure propagates (the route degrades to an empty
 * payload, mirroring `cash-shifts`).
 */
export async function computeSellerKpi(
  poster: PosterClient,
  args: ComputeSellerKpiArgs,
): Promise<SellerKpiResult> {
  const win = buildSellerMonthWindow(args.month);

  // No stores in scope -> nothing to read.
  if (args.allowedStoreIds !== null && args.allowedStoreIds.length === 0) {
    return {
      month: win.label,
      items: [],
      summary: { total_target: 0, total_actual: 0, achievement_pct: null },
    };
  }

  const spots = await loadSpotStores(args.allowedStoreIds);
  if (spots.length === 0) {
    return {
      month: win.label,
      items: [],
      summary: { total_target: 0, total_actual: 0, achievement_pct: null },
    };
  }

  // Live Poster reads — current + previous month, per spot.
  const curByKey = await fetchRevenueByWaiterStore(poster, spots, win.curFrom, win.curTo);
  const prevByKey = await fetchRevenueByWaiterStore(poster, spots, win.prevFrom, win.prevTo);

  // The union of waiters seen in either month -> sellers upsert (latest name).
  const waiterNames = new Map<string, string>();
  for (const v of curByKey.values()) waiterNames.set(v.posterWaiterId, v.name);
  for (const v of prevByKey.values()) {
    if (!waiterNames.has(v.posterWaiterId)) waiterNames.set(v.posterWaiterId, v.name);
  }
  const sellers = await upsertSellers(waiterNames);

  // The KPI rows are keyed by (waiter, store) for the CURRENT month. A seller
  // who sold last month but not this month is not on this month's leaderboard
  // (their prev figure only matters as a MoM baseline for a current row).
  const sellerIds = Array.from(
    new Set(Array.from(sellers.values()).map((s) => s.id)),
  );
  const plans = await loadPlans(sellerIds, win.label);

  let totalTarget = 0;
  let totalActual = 0;
  const rawItems: Array<Omit<SellerKpiItem, 'rank'>> = [];
  for (const [key, cur] of curByKey) {
    const seller = sellers.get(cur.posterWaiterId);
    if (seller === undefined) continue; // upsert failure — skip defensively.
    const actualSum = round2(cur.revenueSom);
    const prevActual = round2(prevByKey.get(key)?.revenueSom ?? 0);
    const targetSum = plans.get(seller.id) ?? null;

    // achievement_pct — null when no target. A zero target is a real goal:
    // positive actual -> 100, zero actual -> 0 (guard the divide-by-zero).
    let achievementPct: number | null = null;
    if (targetSum !== null) {
      achievementPct =
        targetSum === 0 ? (actualSum > 0 ? 100 : 0) : round2((actualSum / targetSum) * 100);
    }

    // growth_pct_mom — null with no prior baseline (growth from zero undefined).
    const growthPctMom =
      prevActual === 0 ? null : round2(((actualSum - prevActual) / prevActual) * 100);

    if (targetSum !== null) totalTarget += targetSum;
    totalActual += actualSum;

    rawItems.push({
      seller_id: seller.id,
      poster_waiter_id: cur.posterWaiterId,
      name: cur.name,
      store_id: cur.storeId,
      store_name: cur.storeName,
      target_sum: targetSum,
      actual_sum: actualSum,
      achievement_pct: achievementPct,
      prev_month_actual: prevActual,
      growth_pct_mom: growthPctMom,
    });
  }

  // Rank by actual_sum DESC; stable tie-break by seller_id then store_id so the
  // order is deterministic.
  rawItems.sort(
    (a, b) =>
      b.actual_sum - a.actual_sum ||
      a.seller_id - b.seller_id ||
      a.store_id - b.store_id,
  );
  const items: SellerKpiItem[] = rawItems.map((it, idx) => ({ ...it, rank: idx + 1 }));

  return {
    month: win.label,
    items,
    summary: {
      total_target: round2(totalTarget),
      total_actual: round2(totalActual),
      achievement_pct: totalTarget === 0 ? null : round2((totalActual / totalTarget) * 100),
    },
  };
}

// ---------------------------------------------------------------------------
// Public: explicit sellers sync (POST /api/seller-kpi/sync).
// ---------------------------------------------------------------------------

/**
 * Sync Poster waiters -> `sellers` for a month window, returning the number of
 * seller identities upserted. Used by POST /api/seller-kpi/sync. Reads the
 * current month's per-spot waiter list (any spot the principal can see) and
 * upserts each. Read-only against Poster; the only write is the idempotent
 * `sellers` upsert.
 */
export async function syncSellersFromPoster(
  poster: PosterClient,
  args: { month: string; allowedStoreIds: number[] | null },
): Promise<{ synced: number }> {
  const win = buildSellerMonthWindow(args.month);
  if (args.allowedStoreIds !== null && args.allowedStoreIds.length === 0) {
    return { synced: 0 };
  }
  const spots = await loadSpotStores(args.allowedStoreIds);
  if (spots.length === 0) return { synced: 0 };

  const byKey = await fetchRevenueByWaiterStore(poster, spots, win.curFrom, win.curTo);
  const waiterNames = new Map<string, string>();
  for (const v of byKey.values()) waiterNames.set(v.posterWaiterId, v.name);
  const sellers = await upsertSellers(waiterNames);
  return { synced: sellers.size };
}
