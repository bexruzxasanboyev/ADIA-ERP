/**
 * TZ Module 9 — Sales discrepancy log (persistence layer).
 *
 * Detection of the two fors-major anomalies already lives in the Poster syncs
 * and is UNCHANGED:
 *   - `salesSync.ts`  detects a "noto'g'ri urilgan" / over-sold check line
 *     (POS sold more than ADIA had on hand) and clamps stock to 0;
 *   - `stockSync.ts`  detects a negative Poster leftover and clamps stock to 0.
 *
 * Both already emit a consolidated Telegram digest. This service adds the
 * SECOND half of M9: it PERSISTS each detected anomaly into
 * `sales_discrepancies` so the app can render an in-app, queryable log + report
 * (`/api/discrepancies`). It does NOT touch detection thresholds or the digest.
 *
 * Two design rules drive the API:
 *   1. Both recorders accept the caller's `TxClient` so the persistence joins
 *      the SAME unit-of-work as the digest that already wraps it — no extra
 *      transaction, no partial state.
 *   2. Both recorders are NON-FATAL. A failure to log a discrepancy must NEVER
 *      break the Poster sync (the sync's job — clamping stock, ingesting sales —
 *      already succeeded). A failure is caught and logged as a warning; the
 *      caller proceeds. This mirrors how the syncs isolate every other
 *      side-effect (per-store / per-location try/catch).
 *
 * Idempotency is enforced by the UNIQUE `dedupe_key` (migration 0059):
 *   - wrong_keyed   — a check line is a one-time fact → ON CONFLICT DO NOTHING.
 *   - negative_stock — a per-day anomaly → ON CONFLICT keep the WORST shortfall
 *                      and refresh `detected_at`; status/note/resolved_* are
 *                      never overwritten (a human's triage survives a re-sync).
 */
import type { TxClient } from '../db/index.js';

/** One detected over-sold ("noto'g'ri urilgan") check line. */
export type WrongKeyedDiscrepancyInput = {
  /** The store (`locations.id`, type='store') the check rang up on. */
  readonly storeId: number;
  /** The ADIA product (`products.id`) that was over-sold. */
  readonly productId: number;
  /** The Poster check id (`dash.getTransaction` transaction_id). */
  readonly transactionId: number;
  /** Units the POS sold on this line. */
  readonly sold: number;
  /** Units ADIA had on hand at sale time (clamped from here). */
  readonly had: number;
  /** sold − had (always > 0 for a detected over-sale). */
  readonly shortfall: number;
};

/** One detected negative Poster leftover (manfiy qoldiq) for a (location, product). */
export type NegativeStockDiscrepancyInput = {
  /** The location (`locations.id`) whose Poster storage went negative. */
  readonly locationId: number;
  /** The ADIA product (`products.id`) with the negative leftover. */
  readonly productId: number;
  /** The magnitude of the negative qty (a positive number, e.g. 3 for −3). */
  readonly shortfall: number;
  /**
   * The detection moment — used to build the day bucket of the dedupe key.
   * Defaults to `now()` when omitted; tests pass an explicit date.
   */
  readonly date?: Date;
};

/** Format a `Date` as a UTC `YYYY-MM-DD` day bucket for the dedupe key. */
function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Persist one over-sold check line. dedupe_key = `wrong_keyed:<tx>:<product>`;
 * a check line is a one-time fact, so a conflict is a no-op (ON CONFLICT DO
 * NOTHING) — a re-played sync never double-logs it.
 *
 * NON-FATAL: any failure is caught and warned; the sync continues. Pass the
 * digest's `TxClient` so this joins the current transaction.
 */
export async function recordWrongKeyedDiscrepancy(
  client: TxClient,
  input: WrongKeyedDiscrepancyInput,
): Promise<void> {
  const dedupeKey = `wrong_keyed:${input.transactionId}:${input.productId}`;
  try {
    await client.query(
      `INSERT INTO sales_discrepancies
         (kind, location_id, product_id, poster_transaction_id,
          sold_qty, had_qty, shortfall, dedupe_key)
       VALUES ('wrong_keyed', $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.storeId,
        input.productId,
        String(input.transactionId),
        input.sold,
        input.had,
        input.shortfall,
        dedupeKey,
      ],
    );
  } catch (err) {
    // Logging a discrepancy must NEVER break the sync — warn and move on.
    console.warn(
      `[salesDiscrepancy] failed to record wrong_keyed (tx=${input.transactionId}, product=${input.productId}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Persist one negative-leftover anomaly. dedupe_key =
 * `negative_stock:<location>:<product>:<YYYY-MM-DD>`; on conflict we keep the
 * WORST shortfall seen that day and refresh `detected_at`, but leave
 * status/note/resolved_* untouched so a human's triage is not clobbered.
 *
 * NON-FATAL: any failure is caught and warned; the sync continues. Pass the
 * digest's `TxClient` so this joins the current transaction.
 */
export async function recordNegativeStockDiscrepancy(
  client: TxClient,
  input: NegativeStockDiscrepancyInput,
): Promise<void> {
  const day = toDayKey(input.date ?? new Date());
  const dedupeKey = `negative_stock:${input.locationId}:${input.productId}:${day}`;
  try {
    await client.query(
      `INSERT INTO sales_discrepancies
         (kind, location_id, product_id, shortfall, dedupe_key)
       VALUES ('negative_stock', $1, $2, $3, $4)
       ON CONFLICT (dedupe_key) DO UPDATE
         SET shortfall   = GREATEST(sales_discrepancies.shortfall, EXCLUDED.shortfall),
             detected_at = now()`,
      [input.locationId, input.productId, input.shortfall, dedupeKey],
    );
  } catch (err) {
    console.warn(
      `[salesDiscrepancy] failed to record negative_stock (location=${input.locationId}, product=${input.productId}):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
