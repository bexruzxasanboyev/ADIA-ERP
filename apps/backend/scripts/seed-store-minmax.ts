/**
 * One-off seed — give STORE stock rows meaningful min_level / max_level so the
 * "Min'dan past" (below-min) filter flags a useful subset of products.
 *
 * Why: stores synced from Poster arrive with min_level=max_level=0, so
 * `scanBelowMin` (which requires `max_level > 0`) flags nothing and the whole
 * store replenishment workflow has no input.
 *
 * Computation per (store, product):
 *   - velocity path (preferred): avg daily qty over the last ~14 days from the
 *     `sales` ledger. min = ceil(avg_daily * LEAD_DAYS), max = min * 2.
 *   - fallback (no recent sales): from the current on-hand qty —
 *       qty  > 0 -> min = ceil(qty * 0.5), max = ceil(qty * 1.5)
 *       qty == 0 -> min = 1, max = 2
 *   - a velocity row whose computed min rounds to 0 (tiny avg) also falls back
 *     so we never leave a sellable product at min=0 (which the scan ignores).
 *
 * Invariants respected:
 *   - max_level >= min_level (DB CHECK chk_stock_minmax) — guaranteed because
 *     max = min*2 (>= min) and the fallback always yields max >= min.
 *   - min/max live per (location_id, product_id) — we UPDATE one row at a time.
 *
 * Idempotent: only STORE rows are touched, and `minmax_mode` stays 'manual'
 * (this is a manual seed, not the dynamic cron). Re-running recomputes from the
 * same inputs and converges to the same numbers.
 *
 * Usage:  npx tsx scripts/seed-store-minmax.ts
 *         DATABASE_URL=postgres:///adia_erp_dev?host=/var/run/postgresql npx tsx scripts/seed-store-minmax.ts
 */
import { closePool, query, withTransaction } from '../src/db/index.js';

/** Lead time (days) assumed for a store -> central top-up. */
const LEAD_DAYS = 2;
/** Sales-velocity averaging window. */
const VELOCITY_DAYS = 14;

type StoreRow = { id: number; name: string };
type StockRow = { product_id: number; qty: number };
type VelocityRow = { product_id: number; avg_daily: number };

function computeMinMax(qty: number, avgDaily: number): { min: number; max: number } {
  if (avgDaily > 0) {
    const min = Math.ceil(avgDaily * LEAD_DAYS);
    if (min > 0) {
      return { min, max: min * 2 };
    }
    // avg so small it rounds to 0 -> fall through to the qty-based fallback.
  }
  if (qty > 0) {
    return { min: Math.ceil(qty * 0.5), max: Math.ceil(qty * 1.5) };
  }
  return { min: 1, max: 2 };
}

async function seedStore(store: StoreRow): Promise<{ updated: number; belowMin: number }> {
  // Current stock rows for this store.
  const { rows: stockRows } = await query<{ product_id: number; qty: string }>(
    'SELECT product_id, qty FROM stock WHERE location_id = $1',
    [store.id],
  );
  const stock: StockRow[] = stockRows.map((r) => ({
    product_id: Number(r.product_id),
    qty: Number(r.qty),
  }));

  // Sales velocity (avg daily qty over the window) per product for this store.
  const { rows: velRows } = await query<{ product_id: number; avg_daily: string }>(
    `SELECT product_id, SUM(qty) / $2::numeric AS avg_daily
       FROM sales
      WHERE store_id = $1
        AND sold_at >= now() - ($3::text || ' days')::interval
      GROUP BY product_id`,
    [store.id, VELOCITY_DAYS, String(VELOCITY_DAYS)],
  );
  const velocity = new Map<number, number>(
    velRows.map((r): [number, number] => [Number(r.product_id), Number(r.avg_daily)]),
  );

  let updated = 0;
  let belowMin = 0;

  await withTransaction(async (tx) => {
    for (const row of stock) {
      const avgDaily = velocity.get(row.product_id) ?? 0;
      const { min, max } = computeMinMax(row.qty, avgDaily);
      await tx.query(
        `UPDATE stock
            SET min_level = $3, max_level = $4
          WHERE location_id = $1 AND product_id = $2`,
        [store.id, row.product_id, min, max],
      );
      updated += 1;
      if (row.qty <= min && max > 0) {
        belowMin += 1;
      }
    }
  });

  return { updated, belowMin };
}

async function main(): Promise<void> {
  const { rows: stores } = await query<{ id: number; name: string }>(
    "SELECT id, name FROM locations WHERE type = 'store' ORDER BY id",
  );
  if (stores.length === 0) {
    console.log('[seed-store-minmax] no store locations found — nothing to do.');
    return;
  }

  console.log(
    `[seed-store-minmax] lead=${LEAD_DAYS}d velocity-window=${VELOCITY_DAYS}d, ${stores.length} store(s).`,
  );
  let totalUpdated = 0;
  let totalBelow = 0;
  for (const store of stores) {
    const { updated, belowMin } = await seedStore({ id: Number(store.id), name: store.name });
    totalUpdated += updated;
    totalBelow += belowMin;
    console.log(
      `[seed-store-minmax] store ${store.id} (${store.name}): ` +
        `min/max set on ${updated} rows, ${belowMin} now below min.`,
    );
  }
  console.log(
    `[seed-store-minmax] DONE — ${totalUpdated} rows updated, ${totalBelow} below min total.`,
  );
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[seed-store-minmax] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
