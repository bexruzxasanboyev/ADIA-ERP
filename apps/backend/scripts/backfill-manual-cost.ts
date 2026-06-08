/**
 * One-time backfill — seed `manual_cost_per_unit` for RAW products from the
 * current Poster-synced `cost_per_unit`.
 *
 * Owner decision (2026-06-08): product PRICING is now app-owned and Poster-
 * INDEPENDENT. Raw (xom-ashyo) prices are entered MANUALLY in our app
 * (`manual_cost_per_unit`); semi/finished prices are COMPUTED from those via
 * the recipe roll-up. The catalog-price roll-up no longer falls back to the
 * Poster-synced cost. As a STARTING POINT we copy the current Poster prices
 * into the manual field — once set, `seedSync.setRawIngredientCost` freezes
 * them (its `AND manual_cost_per_unit IS NULL` guard skips them on re-sync).
 *
 * Only RAW is backfilled — semi/finished prices are computed, never stored
 * manually. Idempotent: only fills NULL `manual_cost_per_unit` rows, so a
 * re-run is a safe no-op for already-seeded rows.
 *
 * Usage:  npm run backfill:manual-cost  (or: npx tsx scripts/backfill-manual-cost.ts)
 */
import { query, closePool } from '../src/db/index.js';

async function main(): Promise<void> {
  const result = await query(
    `UPDATE products
        SET manual_cost_per_unit = cost_per_unit
      WHERE type = 'raw'
        AND manual_cost_per_unit IS NULL
        AND cost_per_unit IS NOT NULL`,
  );
  console.log(`[backfill-manual-cost] raw rows set: ${result.rowCount ?? 0}`);
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[backfill-manual-cost] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
