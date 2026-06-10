/**
 * One-off transactional repair for the weighted-sales 1000x bug (2026-06-10).
 *
 * ROOT CAUSE: for Poster menu products with `weight_flag=1` ("КГ" items) the
 * transaction line `num` arrives in GRAMS ("770.0000000" = 0.77 kg; verified
 * live, see migration 0067). The old sync stored the grams directly, so:
 *   - `sales.qty` was 1000x too big and `sales.price` 1000x too small
 *     (per-GRAM). Line revenue qty*price was CORRECT — only the split was off.
 *   - `stock_movements(reason='sale')` decremented store stock by the gram
 *     value (clamped at on-hand), draining stores and spawning fake
 *     negative-stock discrepancies.
 *
 * REPAIR PREDICATE (verified against the live dev DB 2026-06-10):
 *   sales row s JOIN poster_menu_product_map m ON m.product_id = s.product_id
 *   WHERE m.weight_flag = TRUE AND s.price < 1000
 * Justification: the price distribution is cleanly bimodal — every gram-scaled
 * row has a per-GRAM price of 40..300 so'm (i.e. a real 40k..300k so'm/kg),
 * while every legitimate per-unit price is >= 2000 so'm; the [300, 2000) gap
 * holds a single row (КАЗЫ @ 300/g = 300k so'm/kg, weighted — included). All
 * 41 products in the <1000 bucket map to weight_flag=1 menu items; weighted
 * products ALSO sold as piece menu items (e.g. БАУНТИ ЦЕЛЫЙ) keep their
 * legitimate >= 2000 piece rows untouched. `qty >= 50` alone would be unsafe
 * (real bulk piece orders exist: 66 tartaletkas @ 7000).
 *
 * The repair sets qty = qty/1000, price = price*1000 — LINE REVENUE IS
 * PRESERVED EXACTLY (asserted below; the tx aborts on any drift).
 *
 * Matching `stock_movements` are set to LEAST(old_qty, repaired_total_qty):
 * a movement that recorded the full gram decrement collapses to the true kg
 * value, while one that was CLAMPED below the true kg value (store had less)
 * keeps its clamp. Stock BALANCES are NOT fixed here — run the Poster stock
 * sync afterwards (`POST /api/integrations/poster/sync?entity=stock`), which
 * overwrites store stock from Poster (authoritative).
 *
 * `sales_stats_daily` is recomputed afterwards via the regular aggregate
 * cycle (same code path as `scripts/sales-agg-now.ts`).
 *
 * Idempotent: a second run matches zero rows (repaired prices are >= 40_000).
 *
 * Usage: npx tsx scripts/repair-weighted-sales.ts
 */
import { withTransaction } from '../src/db/index.js';
import { writeAudit } from '../src/lib/audit.js';
import { runSalesAggregateCycle } from '../src/workers/salesAggregateCron.js';
import { closePool } from '../src/db/pool.js';

async function main(): Promise<void> {
  const summary = await withTransaction(async (tx) => {
    // 0. Snapshot the affected rows (with PRE-repair qty) into a temp table —
    //    the movement fix below needs the original (tx, product, store) keys
    //    and the repaired kg totals.
    await tx.query(
      `CREATE TEMP TABLE repair_affected ON COMMIT DROP AS
         SELECT s.id, s.store_id, s.product_id, s.poster_transaction_id,
                s.qty AS old_qty, s.price AS old_price
           FROM sales s
          WHERE s.price < 1000
            AND EXISTS (SELECT 1 FROM poster_menu_product_map m
                         WHERE m.product_id = s.product_id AND m.weight_flag = TRUE)`,
    );
    const { rows: cnt } = await tx.query<{ n: string; revenue: string }>(
      `SELECT count(*) AS n, COALESCE(sum(old_qty * old_price), 0) AS revenue
         FROM repair_affected`,
    );
    const affected = Number(cnt[0]!.n);
    const revenueBefore = Number(cnt[0]!.revenue);

    // 1. sales: grams -> kg, per-gram -> per-kg. Line revenue must not move.
    await tx.query(
      `UPDATE sales s
          SET qty = s.qty / 1000, price = s.price * 1000
         FROM repair_affected r
        WHERE s.id = r.id`,
    );
    const { rows: after } = await tx.query<{ revenue: string; bad: string }>(
      `SELECT COALESCE(sum(s.qty * s.price), 0) AS revenue,
              count(*) FILTER (WHERE s.qty * s.price IS DISTINCT FROM r.old_qty * r.old_price) AS bad
         FROM sales s JOIN repair_affected r ON r.id = s.id`,
    );
    const revenueAfter = Number(after[0]!.revenue);
    const driftedLines = Number(after[0]!.bad);
    if (driftedLines > 0 || Math.abs(revenueAfter - revenueBefore) > 1e-6) {
      throw new Error(
        `revenue invariant violated: before=${revenueBefore} after=${revenueAfter} drifted=${driftedLines} — rolling back`,
      );
    }

    // 2. stock_movements (reason='sale') of the same Poster transactions:
    //    LEAST(old movement qty, repaired kg total) — see the header.
    const mv = await tx.query<{ id: number }>(
      `UPDATE stock_movements m
          SET qty = LEAST(m.qty, agg.kg_qty)
         FROM (SELECT poster_transaction_id, product_id, store_id,
                      sum(old_qty) / 1000 AS kg_qty
                 FROM repair_affected
                GROUP BY 1, 2, 3) agg
        WHERE m.reason = 'sale'
          AND m.poster_transaction_id = agg.poster_transaction_id
          AND m.product_id = agg.product_id
          AND m.from_location_id = agg.store_id
          AND m.qty > agg.kg_qty
        RETURNING m.id`,
    );

    await writeAudit(tx, {
      actorUserId: null,
      action: 'poster.sales.repair_weighted_1000x',
      entity: 'sales',
      entityId: null,
      payload: {
        affected_sales_rows: affected,
        revenue_preserved: revenueBefore,
        movements_rescaled: mv.rowCount,
        predicate: 'price < 1000 AND product mapped to weight_flag=TRUE menu item',
      },
    });
    return { affected, revenueBefore, movementsRescaled: mv.rowCount };
  });

  console.log(
    `[repair] sales rows repaired=${summary.affected} ` +
      `(line revenue preserved: ${summary.revenueBefore.toFixed(2)} so'm), ` +
      `sale movements rescaled=${summary.movementsRescaled}`,
  );

  // 3. Recompute sales_stats_daily for the affected window (same code path as
  //    scripts/sales-agg-now.ts — rolling 31 days covers 2026-06-06..10).
  const agg = await runSalesAggregateCycle();
  console.log(`[repair] sales_stats_daily reaggregated rows=${agg.rowsAggregated}`);

  await closePool();
}

main().catch((err) => {
  console.error('[repair] FAILED (rolled back):', err);
  process.exit(1);
});
