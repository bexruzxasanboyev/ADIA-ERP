/**
 * Stock sync — Poster `storage.getStorageLeftovers` -> ADIA `stock` (ADR-0002 §2).
 *
 * For every active `locations` row with `poster_storage_id` set:
 *   1. fetch the storage leftovers,
 *   2. for each leftover element (type=1 AND type=2 — both keyed by
 *      `ingredient_id` per ADR-0002 §1), resolve `products.poster_ingredient_id`,
 *   3. compare Poster `storage_ingredient_left` with ADIA `stock.qty`:
 *        - difference > 0 -> apply an `adjust` movement to align (invariant 1),
 *        - difference < 0 -> apply an `adjust` movement decreasing ADIA qty,
 *        - difference = 0 -> no-op.
 *   4. when Poster `storage_ingredient_left < 0` -> CLAMP ADIA qty to 0 and
 *      raise `negative_stock_detected` notification (invariant 3 — qty never
 *      negative; Poster bookkeeping anomalies are surfaced, not propagated).
 *
 * Idempotent — running the sync twice with no Poster movement is a no-op.
 */
import { applyMovement } from '../../services/stockMovement.js';
import { query, withTransaction, type TxClient } from '../../db/index.js';
import {
  createNotification,
  getLocationManager,
  getPmRecipients,
} from '../../services/notify.js';
import { recordNegativeStockDiscrepancy } from '../../services/salesDiscrepancy.js';
import type { PosterClient, PosterLeftover } from './client.js';
import {
  finishSyncRun,
  notifyPosterSyncFailed,
  redactUrl,
  startSyncRun,
  type SyncTrigger,
} from './syncLog.js';

export type StockSyncResult = {
  readonly storagesScanned: number;
  readonly adjustments: number;
  readonly negativesClamped: number;
  readonly skippedNoProduct: number;
};

/**
 * One negative-Poster-qty item detected during a leftover sync run. Collected
 * (NOT notified) per item; the caller aggregates these into ONE consolidated
 * Telegram digest per location after the whole run, so a sync that finds many
 * negative leftovers no longer floods the boss with N near-identical messages
 * (owner feedback 2026-06 — mirrors the kassa "wrong-keyed" digest fix in
 * salesSync.ts).
 */
export type NegativeStockItem = {
  readonly locationId: number;
  readonly productId: number;
  readonly posterQty: number;
};

/** Read all active locations with a Poster storage id. */
async function listStorageLocations(): Promise<{ id: number; posterStorageId: number; name: string }[]> {
  const { rows } = await query<{ id: number; poster_storage_id: number; name: string }>(
    `SELECT id, poster_storage_id, name FROM locations
      WHERE poster_storage_id IS NOT NULL AND is_active = TRUE`,
  );
  return rows.map((r) => ({ id: r.id, posterStorageId: r.poster_storage_id, name: r.name }));
}

/** Resolve ADIA product_id for a Poster ingredient_id (the universal join key). */
async function resolveProductIdByIngredient(posterIngredientId: number): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM products WHERE poster_ingredient_id = $1`,
    [posterIngredientId],
  );
  return rows[0]?.id ?? null;
}

/** Read the current ADIA qty for `(location, product)`, defaulting to 0. */
async function readQty(locationId: number, productId: number): Promise<number> {
  const { rows } = await query<{ qty: number }>(
    `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
    [locationId, productId],
  );
  return rows[0]?.qty ?? 0;
}

/** How many product lines the digest body lists before collapsing to "…+k". */
const DIGEST_TOP_N = 5;
/** Debounce window for a location digest — a re-scan inside this stays quiet. */
const DIGEST_DEDUPE_MINUTES = 60;

/** Resolve a location name; falls back to "bo'g'in #id" if the row is gone. */
async function resolveLocationName(tx: TxClient, locationId: number): Promise<string> {
  const { rows } = await tx.query<{ name: string }>(
    `SELECT name FROM locations WHERE id = $1`,
    [locationId],
  );
  return rows[0]?.name ?? `bo'g'in #${locationId}`;
}

/** Resolve product names for a set of ids in one round-trip (id → name map). */
async function resolveProductNames(
  tx: TxClient,
  productIds: readonly number[],
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (productIds.length === 0) return map;
  const { rows } = await tx.query<{ id: number; name: string }>(
    `SELECT id, name FROM products WHERE id = ANY($1::int[])`,
    [productIds],
  );
  for (const r of rows) map.set(Number(r.id), r.name);
  return map;
}

/** Trim a qty for display — integers print bare, fractionals keep 3 places. */
function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/**
 * Owner feedback 2026-06 — emit ONE consolidated negative-stock digest per
 * location after a whole leftover sync run, instead of one Telegram per
 * affected product (the old `notifyNegative` flooded PMs once per product on
 * EVERY 15-minute scan). The body resolves the location name and product
 * NAMES (never raw ids), lists the top {DIGEST_TOP_N} most-negative products,
 * and collapses the rest into "…va yana k ta mahsulot." Recipients: PMs + the
 * location's manager. Deduped per (location, user) for {DIGEST_DEDUPE_MINUTES}
 * min so back-to-back scans in the same window don't re-flood.
 *
 * Each location's digest is emitted in its own transaction so one bad location
 * does not roll back the others. The stock CLAMP / movement / audit already
 * applied by `applyLeftover` are NOT touched here.
 */
export async function emitNegativeStockDigests(
  items: readonly NegativeStockItem[],
): Promise<void> {
  if (items.length === 0) return;

  // Group the negative items by location.
  const byLocation = new Map<number, NegativeStockItem[]>();
  for (const it of items) {
    const list = byLocation.get(it.locationId);
    if (list === undefined) byLocation.set(it.locationId, [it]);
    else list.push(it);
  }

  for (const [locationId, locItems] of byLocation) {
    try {
      await withTransaction(async (tx) => {
        // Keep the most-negative Poster qty per product across the run's rows
        // (a product can appear once per storage; collapse to the worst value).
        const perProduct = new Map<number, number>();
        for (const it of locItems) {
          const prev = perProduct.get(it.productId);
          if (prev === undefined || it.posterQty < prev) {
            perProduct.set(it.productId, it.posterQty);
          }
        }

        // M9 (TZ §9) — PERSIST each negative-leftover anomaly into the
        // discrepancy log. One row per (location, product) per day; the
        // recorder keeps the WORST shortfall on conflict and is non-fatal, and
        // joins THIS transaction via `tx`. `posterQty` is negative, so the
        // shortfall magnitude is its absolute value. The digest below is
        // unchanged.
        for (const [productId, posterQty] of perProduct) {
          await recordNegativeStockDiscrepancy(tx, {
            locationId,
            productId,
            shortfall: Math.abs(posterQty),
          });
        }

        const locationName = await resolveLocationName(tx, locationId);
        const nameById = await resolveProductNames(tx, [...perProduct.keys()]);

        // Most-negative first (ascending posterQty).
        const ranked = [...perProduct.entries()].sort((a, b) => a[1] - b[1]);
        const shown = ranked.slice(0, DIGEST_TOP_N);
        const remaining = ranked.length - shown.length;

        const listLines = shown
          .map(([productId, posterQty]) => {
            const name = nameById.get(productId) ?? `mahsulot #${productId}`;
            return `• ${name} — Poster: ${formatQty(posterQty)}`;
          })
          .join('\n');
        const tail = remaining > 0 ? `\n…va yana ${remaining} ta mahsulot.` : '';

        const title = `⚠️ Manfiy qoldiq aniqlandi — ${locationName}`;
        const body =
          `${ranked.length} ta mahsulotda Poster manfiy qoldiq berdi ` +
          `(0 ga tushirildi — tekshiring).\n\n` +
          `${listLines}${tail}`;

        const pmIds = await getPmRecipients(tx);
        const managerId = await getLocationManager(tx, locationId);
        const recipients = new Set<number>(pmIds);
        if (managerId !== null) recipients.add(managerId);

        for (const userId of recipients) {
          await createNotification(tx, {
            recipientUserId: userId,
            type: 'negative_stock_detected',
            title,
            body,
            payload: {
              location_id: locationId,
              product_count: ranked.length,
              products: ranked.map(([productId, posterQty]) => ({
                product_id: productId,
                name: nameById.get(productId) ?? null,
                poster_qty: posterQty,
              })),
            },
            // Per-recipient location-level scope — `createNotification` dedupes
            // on the key alone, so a single recipient-less key would let the
            // FIRST user's row suppress every other user's nudge.
            dedupeKey: `negative_stock_digest:${locationId}:user:${userId}`,
            dedupeWindowMinutes: DIGEST_DEDUPE_MINUTES,
          });
        }
      });
    } catch (err) {
      console.error(
        `[poster] negative-stock digest for location ${locationId} failed:`,
        redactUrl((err as Error).message),
      );
    }
  }
}

/**
 * Apply one Poster leftover row to ADIA stock. Returns one of:
 *   - 'no-product' when no ADIA product matches the Poster ingredient_id;
 *   - 'noop'       when qty matches and no clamp was needed;
 *   - 'adjusted'   when one or more `adjust` movements were written;
 *   - 'clamped'    when negative Poster qty triggered a clamp + notification.
 */
async function applyLeftover(
  locationId: number,
  leftover: PosterLeftover,
  negatives: NegativeStockItem[],
): Promise<'no-product' | 'noop' | 'adjusted' | 'clamped'> {
  const posterIngredientId = Number(leftover.ingredient_id);
  if (!Number.isInteger(posterIngredientId) || posterIngredientId <= 0) return 'no-product';

  const productId = await resolveProductIdByIngredient(posterIngredientId);
  if (productId === null) return 'no-product';

  const posterQty = Number(leftover.storage_ingredient_left);
  if (!Number.isFinite(posterQty)) return 'noop';

  // Negative Poster qty is a bookkeeping artefact — clamp to 0 in ADIA and
  // notify, never write a negative row (invariant 3).
  if (posterQty < 0) {
    const current = await readQty(locationId, productId);
    if (current > 0) {
      await applyMovement({
        productId,
        fromLocationId: locationId,
        toLocationId: null,
        qty: current,
        reason: 'adjust',
        actorUserId: null,
        note: `Poster clamp: storage_ingredient_left=${posterQty}`,
      });
    }
    // Owner feedback 2026-06 — DO NOT notify per product here (that flooded
    // PMs once per product on every scan). COLLECT the negative item; the
    // caller emits ONE consolidated per-location digest after the whole run.
    negatives.push({ locationId, productId, posterQty });
    return 'clamped';
  }

  const current = await readQty(locationId, productId);
  const diff = posterQty - current;
  // Tolerate float noise — 0.0001 is below the schema precision.
  if (Math.abs(diff) < 0.0001) return 'noop';

  if (diff > 0) {
    // ADIA below Poster — receipt the difference.
    await applyMovement({
      productId,
      fromLocationId: null,
      toLocationId: locationId,
      qty: diff,
      reason: 'adjust',
      actorUserId: null,
      note: 'Poster leftover reconcile (+)',
    });
  } else {
    // ADIA above Poster — issue the absolute difference.
    await applyMovement({
      productId,
      fromLocationId: locationId,
      toLocationId: null,
      qty: -diff,
      reason: 'adjust',
      actorUserId: null,
      note: 'Poster leftover reconcile (-)',
    });
  }
  return 'adjusted';
}

/**
 * One run of the leftover sync over every Poster-mapped location.
 * Returns a per-run summary that the worker logs and the sync log records.
 */
export async function syncStockLeftovers(
  client: PosterClient,
  trigger: SyncTrigger = 'poll',
): Promise<StockSyncResult> {
  const runId = await startSyncRun('leftovers', trigger);
  const summary: { storagesScanned: number; adjustments: number; negativesClamped: number; skippedNoProduct: number } =
    { storagesScanned: 0, adjustments: 0, negativesClamped: 0, skippedNoProduct: 0 };
  let recordsIn = 0;
  let recordsApplied = 0;
  // Owner feedback 2026-06 — collect negative-stock items across the WHOLE run,
  // then emit ONE consolidated digest per location at the end (no per-product
  // flood). Mirrors the kassa wrong-keyed digest in salesSync.ts.
  const negatives: NegativeStockItem[] = [];
  try {
    const locations = await listStorageLocations();
    for (const loc of locations) {
      let leftovers: PosterLeftover[];
      try {
        leftovers = await client.getStorageLeftovers(loc.posterStorageId);
      } catch (err) {
        console.error(
          `[poster] leftovers for storage_id=${loc.posterStorageId} failed:`,
          (err as Error).message,
        );
        continue;
      }
      summary.storagesScanned += 1;
      recordsIn += leftovers.length;
      for (const lo of leftovers) {
        try {
          const outcome = await applyLeftover(loc.id, lo, negatives);
          if (outcome === 'no-product') summary.skippedNoProduct += 1;
          else if (outcome === 'adjusted') {
            summary.adjustments += 1;
            recordsApplied += 1;
          } else if (outcome === 'clamped') {
            summary.negativesClamped += 1;
            recordsApplied += 1;
          }
        } catch (err) {
          console.error(
            '[poster] leftover row failed for ingredient_id=',
            lo.ingredient_id,
            (err as Error).message,
          );
        }
      }
    }
    // Owner feedback 2026-06 — ONE consolidated digest per location for the
    // whole run (after all clamps/movements/audit already committed).
    await emitNegativeStockDigests(negatives);
    await finishSyncRun(runId, 'ok', { recordsIn, recordsApplied });
    return summary;
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn, recordsApplied }, detail);
    await notifyPosterSyncFailed('leftovers', detail);
    throw err;
  }
}
