/**
 * Sales sync — primary path: Poster `transaction.close` webhook;
 *              fallback:     30-minute poll of `dash.getTransactions`.
 *
 * The webhook endpoint inserts the raw event into `poster_webhook_events` and
 * returns 200 within a single round-trip — the actual ingestion happens here,
 * out-of-band, so the webhook can never time out a Poster retry.
 *
 * Idempotency:
 *   - `sales` UNIQUE `(poster_transaction_id, product_id, poster_line_id)` —
 *     a re-played event inserts zero new lines (ON CONFLICT DO NOTHING).
 *   - `stock_movements` partial UNIQUE `(poster_transaction_id, product_id,
 *     from_location_id)` keyed on `reason='sale'` rows — a re-played event
 *     never decrements stock twice.
 *
 * The line product_id is resolved via `products.poster_product_id` (NOT
 * `poster_ingredient_id`) — sales come from the menu side, leftovers come
 * from the storage side. See ADR-0002 §1.
 */
import { query, withTransaction, type TxClient } from '../../db/index.js';
import { writeAudit } from '../../lib/audit.js';
import {
  createNotification,
  getLocationManager,
  getPmRecipients,
} from '../../services/notify.js';
import type { PosterClient, PosterTransactionFull } from './client.js';
import {
  finishSyncRun,
  notifyPosterSyncFailed,
  redactUrl,
  startSyncRun,
} from './syncLog.js';

/**
 * EPIC 8.3 — one over-sold ("noto'g'ri urilgan") line detected during a sync
 * run. Collected (NOT notified) per line; the caller aggregates these into ONE
 * consolidated Telegram digest per store after the whole run, so a sync that
 * finds many over-sold products no longer floods the boss with N near-identical
 * messages (owner feedback 2026-06).
 */
export type WrongKeyedLine = {
  readonly storeId: number;
  readonly productId: number;
  readonly transactionId: number;
  readonly sold: number;
  readonly had: number;
  readonly shortfall: number;
};

export type SalesIngestResult = {
  /** Number of events scanned (== `poster_webhook_events` rows examined). */
  readonly eventsScanned: number;
  /** Events that produced at least one new `sales` line. */
  readonly eventsApplied: number;
  /** New `sales` lines inserted in total. */
  readonly linesInserted: number;
  /** Movements applied (stock decrements). */
  readonly movementsApplied: number;
  /** Events skipped because the store could not be resolved. */
  readonly storeMisses: number;
  /**
   * Lines that raised an exception while being ingested (C7 — Sprint 3 audit).
   * Drives the run-status flip to `partial` when one or more lines failed
   * even though the wrapping fetch / scan loop succeeded.
   */
  readonly failedLines: number;
  /** EPIC 8.3 — chek-level shortfalls detected (sold > on-hand). */
  readonly wrongKeyedLines: number;
};

/** Locate an ADIA store (`type='store'`) by Poster spot_id. */
async function resolveStoreId(posterSpotId: number): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM locations
      WHERE poster_spot_id = $1 AND type = 'store' AND is_active = TRUE`,
    [posterSpotId],
  );
  return rows[0]?.id ?? null;
}

/** Locate an ADIA product by Poster menu product_id (sales side). */
async function resolveSalesProductId(posterProductId: number): Promise<number | null> {
  const { rows } = await query<{ id: number }>(
    `SELECT id FROM products WHERE poster_product_id = $1`,
    [posterProductId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Lower bound for a *real* Poster close date. Poster emits `date_close = "0"`
 * (epoch) or `"2000-01-01 00:00:00"` for transactions that were never actually
 * closed (open / voided / draft checks). Both land on the year-2000 placeholder
 * once parsed — which previously polluted `sales` with ~880 bln of fake revenue
 * dated 2000-01-01 (Asia/Tashkent is UTC+5, so the stored value was
 * `2000-01-01 00:00:00+05`). Any close date at or before this cut-off is a
 * placeholder, never a genuine sale. 2010-01-01 is comfortably before the
 * business started and comfortably after every Poster placeholder value.
 */
const MIN_VALID_CLOSE_MS = Date.UTC(2010, 0, 1);

/**
 * Parse Poster `date_close`. Accepts both ms-unix-string and
 * "YYYY-MM-DD HH:mm:ss". Returns `null` when the value is MISSING or a
 * PLACEHOLDER (epoch / year-2000) — the caller MUST skip such a line instead of
 * inserting a sale with a fake date (root-cause fix for the 2000-01-01 rows).
 */
function parseCloseDate(raw: string | undefined): Date | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  let d: Date;
  if (Number.isFinite(n) && n > 0) {
    // Poster gives milliseconds; values smaller than 1e12 are seconds.
    d = new Date(n > 1e12 ? n : n * 1000);
  } else {
    d = new Date(raw);
  }
  if (Number.isNaN(d.getTime())) return null;
  // Reject the year-2000 / epoch placeholder Poster emits for un-closed checks.
  if (d.getTime() < MIN_VALID_CLOSE_MS) return null;
  return d;
}

/**
 * Ingest one full transaction (sale check). Idempotent — re-running with the
 * same payload inserts zero new lines and applies zero new movements.
 */
export async function ingestTransaction(
  tx: PosterTransactionFull,
): Promise<{
  linesInserted: number;
  movementsApplied: number;
  storeFound: boolean;
  failedLines: number;
  /** EPIC 8.3 — lines whose sold qty exceeded on-hand ("noto'g'ri urilgan"). */
  wrongKeyedLines: number;
  /**
   * The over-sold lines themselves — returned (NOT notified here) so the
   * caller can aggregate them into ONE per-store digest after the whole run.
   */
  wrongKeyedDetails: WrongKeyedLine[];
}> {
  const transactionId = Number(tx.transaction_id);
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    return { linesInserted: 0, movementsApplied: 0, storeFound: false, failedLines: 0, wrongKeyedLines: 0, wrongKeyedDetails: [] };
  }
  const spotId = Number(tx.spot_id);
  const storeId = Number.isInteger(spotId) && spotId > 0 ? await resolveStoreId(spotId) : null;
  if (storeId === null) {
    return { linesInserted: 0, movementsApplied: 0, storeFound: false, failedLines: 0, wrongKeyedLines: 0, wrongKeyedDetails: [] };
  }
  // ROOT-CAUSE GUARD: a transaction with no valid close date (Poster emits
  // "0" / "2000-01-01 00:00:00" for un-closed / voided checks) is NOT a real
  // sale. Skip the WHOLE check rather than inserting a placeholder-dated row —
  // this is what previously created the 2000-01-01 fake-revenue rows. Log
  // loudly so a genuinely-malformed close date is visible, not silent.
  const closedAt = parseCloseDate(tx.date_close);
  if (closedAt === null) {
    console.warn(
      `[poster] tx ${transactionId} skipped — invalid/placeholder date_close=${JSON.stringify(tx.date_close)} (un-closed check, not a sale)`,
    );
    return { linesInserted: 0, movementsApplied: 0, storeFound: true, failedLines: 0, wrongKeyedLines: 0, wrongKeyedDetails: [] };
  }
  const lines = Array.isArray(tx.products) ? tx.products : [];

  let linesInserted = 0;
  let movementsApplied = 0;
  // C7 — per-line failure counter. The whole check used to swallow a thrown
  // SQL error silently (only console.error). Now we expose a counter so the
  // sync log can flip to `partial` when any line of any event failed.
  let failedLines = 0;
  // EPIC 8.3 — count chek-level shortfalls (sold > on-hand).
  let wrongKeyedLines = 0;
  // EPIC 8.3 — accumulate the over-sold lines so the CALLER can send ONE
  // consolidated per-store digest after the whole run (no per-line flood).
  const wrongKeyedDetails: WrongKeyedLine[] = [];

  // Each line is its own transaction — a single bad line must not abort the
  // whole check (and the UNIQUE indexes give us idempotency line-by-line).
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const posterProductId = Number(line.product_id);
    const num = Number(line.num);
    // Poster reports ALL money in TIYIN (1 so'm = 100 tiyin) — the same
    // convention `paymentReportToBuckets` divides by 100. `product_price` is
    // the per-unit price in tiyin; store it as so'm so `qty * price` agrees
    // with the Poster payments report instead of being 100× inflated.
    const price = Number(line.product_price ?? 0) / 100;
    if (!Number.isInteger(posterProductId) || posterProductId <= 0) continue;
    if (!Number.isFinite(num) || num <= 0) continue;

    const productId = await resolveSalesProductId(posterProductId);
    if (productId === null) continue; // menu item not yet seeded — skip silently

    // 0-based positional id within the check — Poster does not surface a stable
    // line id, so we synthesise one. Combined with (tx_id, product_id) it makes
    // the `uq_sales_poster_line` UNIQUE work even for two lines of the same
    // product within one check.
    const lineId = i;
    try {
      const result = await withTransaction(async (txc) => {
        const inserted = await txc.query(
          `INSERT INTO sales
             (store_id, product_id, qty, price, sold_at,
              poster_transaction_id, poster_line_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (poster_transaction_id, product_id, poster_line_id) DO NOTHING
           RETURNING id`,
          [storeId, productId, num, price, closedAt, transactionId, lineId],
        );
        // Only decrement stock when the sale row is brand-new — a replay of
        // the same line must NOT double-decrement (the movements partial
        // UNIQUE is a second-line-of-defence below).
        if (inserted.rowCount === 0) return { applied: false };

        // Insert the `sale` movement DIRECTLY (not via `applyMovement`) so we
        // can set `poster_transaction_id` for idempotency, accept zero stock
        // (sales can drive a store negative according to Poster — but we
        // protect ADIA by clamping to current qty via the guarded decrement,
        // never going below 0; mismatch is reconciled by the leftover sync).
        const current = await txc.query<{ qty: number }>(
          `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
          [storeId, productId],
        );
        const have = Number(current.rows[0]?.qty ?? 0);
        const decrement = Math.min(have, num);
        // EPIC 8.3 — fors major: the check rang up MORE than ADIA had on hand.
        // Stock is clamped to 0 (invariant 3 — never negative); we surface a
        // chek-level "noto'g'ri urilgan" alert so a human reconciles it.
        const shortfall = num > have ? num - have : 0;
        // NOTE: the over-sold alert is NO LONGER emitted per line here (it used
        // to send one Telegram per product → flood). We only RECORD the
        // shortfall on the result; the caller aggregates these into ONE
        // per-store digest after the run. Stock clamping / movement / audit
        // below are unchanged.
        if (decrement > 0) {
          await txc.query(
            `UPDATE stock SET qty = qty - $1
              WHERE location_id = $2 AND product_id = $3 AND qty >= $1`,
            [decrement, storeId, productId],
          );
          await txc.query(
            `INSERT INTO stock_movements
               (product_id, from_location_id, to_location_id, qty, reason,
                poster_transaction_id, note, created_by)
             VALUES ($1, $2, NULL, $3, 'sale', $4, $5, NULL)
             ON CONFLICT (poster_transaction_id, product_id, from_location_id)
               WHERE poster_transaction_id IS NOT NULL
             DO NOTHING`,
            [productId, storeId, decrement, transactionId, `line ${lineId}`],
          );
        }
        await writeAudit(txc, {
          actorUserId: null,
          action: 'poster.sale.ingest',
          entity: 'sales',
          entityId: null,
          payload: {
            poster_transaction_id: transactionId,
            product_id: productId,
            store_id: storeId,
            qty: num,
            decrement,
          },
        });
        return { applied: true, decrement, shortfall, had: have };
      });
      if (result.applied) {
        linesInserted += 1;
        if ((result.decrement ?? 0) > 0) movementsApplied += 1;
        if ((result.shortfall ?? 0) > 0) {
          wrongKeyedLines += 1;
          wrongKeyedDetails.push({
            storeId,
            productId,
            transactionId,
            sold: num,
            had: result.had ?? 0,
            shortfall: result.shortfall ?? 0,
          });
        }
      }
    } catch (err) {
      failedLines += 1;
      console.error(
        `[poster] sale line ${lineId} of tx ${transactionId} failed:`,
        redactUrl((err as Error).message),
      );
    }
  }

  return { linesInserted, movementsApplied, storeFound: true, failedLines, wrongKeyedLines, wrongKeyedDetails };
}

/** How many product lines the digest body lists before collapsing to "…+k". */
const DIGEST_TOP_N = 5;
/** Debounce window for a store digest — a re-sync inside this stays quiet. */
const DIGEST_DEDUPE_MINUTES = 60;

/** Resolve a store name; falls back to "do'kon #id" if the row is gone. */
async function resolveStoreName(txc: TxClient, storeId: number): Promise<string> {
  const { rows } = await txc.query<{ name: string }>(
    `SELECT name FROM locations WHERE id = $1`,
    [storeId],
  );
  return rows[0]?.name ?? `do'kon #${storeId}`;
}

/** Resolve product names for a set of ids in one round-trip (id → name map). */
async function resolveProductNames(
  txc: TxClient,
  productIds: readonly number[],
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (productIds.length === 0) return map;
  const { rows } = await txc.query<{ id: number; name: string }>(
    `SELECT id, name FROM products WHERE id = ANY($1::int[])`,
    [productIds],
  );
  for (const r of rows) map.set(Number(r.id), r.name);
  return map;
}

/**
 * EPIC 8.3 (owner feedback 2026-06) — emit ONE consolidated "noto'g'ri urilgan"
 * digest per store after a whole sync run, instead of one Telegram per
 * over-sold line. The body resolves the store name and product NAMES (never raw
 * ids), lists the top {DIGEST_TOP_N} products by shortfall, and collapses the
 * rest into "…va yana k ta mahsulot." Recipients: PMs + the store's manager.
 * Deduped per (store, user) for {DIGEST_DEDUPE_MINUTES} min so back-to-back
 * syncs in the same window don't re-flood.
 *
 * Each store's digest is emitted in its own transaction so one bad store does
 * not roll back the others. Already-clamped stock / movements / audit are NOT
 * touched here.
 */
export async function emitWrongKeyedDigests(
  details: readonly WrongKeyedLine[],
): Promise<void> {
  if (details.length === 0) return;

  // Group the over-sold lines by store.
  const byStore = new Map<number, WrongKeyedLine[]>();
  for (const d of details) {
    const list = byStore.get(d.storeId);
    if (list === undefined) byStore.set(d.storeId, [d]);
    else list.push(d);
  }

  for (const [storeId, lines] of byStore) {
    try {
      await withTransaction(async (txc) => {
        // Aggregate shortfall per product across all the run's checks for this
        // store (a product over-sold in 3 checks shows once with the total).
        const perProduct = new Map<number, number>();
        for (const l of lines) {
          perProduct.set(l.productId, (perProduct.get(l.productId) ?? 0) + l.shortfall);
        }
        const totalShortfall = lines.reduce((s, l) => s + l.shortfall, 0);
        const checkCount = new Set(lines.map((l) => l.transactionId)).size;

        const storeName = await resolveStoreName(txc, storeId);
        const nameById = await resolveProductNames(txc, [...perProduct.keys()]);

        const ranked = [...perProduct.entries()].sort((a, b) => b[1] - a[1]);
        const shown = ranked.slice(0, DIGEST_TOP_N);
        const remaining = ranked.length - shown.length;

        const listLines = shown
          .map(([productId, shortfall]) => {
            const name = nameById.get(productId) ?? `mahsulot #${productId}`;
            return `• ${name} — ${formatQty(shortfall)} dona ortiqcha`;
          })
          .join('\n');
        const tail = remaining > 0 ? `\n…va yana ${remaining} ta mahsulot.` : '';

        const title = `⚠️ Kassa nomuvofiqligi — ${storeName}`;
        const body =
          `${checkCount} ta chekda ostatkadan ortiq sotildi ` +
          `(jami ${formatQty(totalShortfall)} dona ortiqcha). ` +
          `Ostatka 0 ga tushirildi — tekshiring.\n\n` +
          `${listLines}${tail}`;

        const pmIds = await getPmRecipients(txc);
        const managerId = await getLocationManager(txc, storeId);
        const recipients = new Set<number>(pmIds);
        if (managerId !== null) recipients.add(managerId);

        for (const userId of recipients) {
          await createNotification(txc, {
            recipientUserId: userId,
            type: 'wrong_keyed_check',
            title,
            body,
            payload: {
              store_id: storeId,
              check_count: checkCount,
              total_shortfall: totalShortfall,
              products: ranked.map(([productId, shortfall]) => ({
                product_id: productId,
                name: nameById.get(productId) ?? null,
                shortfall,
              })),
            },
            dedupeKey: `wrong_keyed_digest:${storeId}:user:${userId}`,
            dedupeWindowMinutes: DIGEST_DEDUPE_MINUTES,
          });
        }
      });
    } catch (err) {
      console.error(
        `[poster] wrong-keyed digest for store ${storeId} failed:`,
        redactUrl((err as Error).message),
      );
    }
  }
}

/** Trim a qty for display — integers print bare, fractionals keep 3 places. */
function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)));
}

/**
 * Process pending `poster_webhook_events` rows: fetch the full transaction
 * for each, ingest, mark processed. Returns a summary for the worker log.
 */
export async function processPendingWebhookEvents(
  client: PosterClient,
  limit = 50,
): Promise<SalesIngestResult> {
  const runId = await startSyncRun('transactions', 'webhook');
  const summary = {
    eventsScanned: 0,
    eventsApplied: 0,
    linesInserted: 0,
    movementsApplied: 0,
    storeMisses: 0,
    failedLines: 0,
    wrongKeyedLines: 0,
  };
  // EPIC 8.3 — collect over-sold lines across the WHOLE run, then emit one
  // consolidated digest per store at the end (no per-line flood).
  const wrongKeyed: WrongKeyedLine[] = [];
  try {
    const { rows } = await query<{ id: number; event_type: string; poster_object_id: number | null }>(
      `SELECT id, event_type, poster_object_id
         FROM poster_webhook_events
        WHERE processed = FALSE
          AND event_type IN ('transaction.close', 'transaction.update', 'transaction.add')
        ORDER BY received_at
        LIMIT $1`,
      [limit],
    );
    for (const ev of rows) {
      summary.eventsScanned += 1;
      const txId = ev.poster_object_id;
      if (txId === null) {
        await query(
          `UPDATE poster_webhook_events SET processed = TRUE, processed_at = now() WHERE id = $1`,
          [ev.id],
        );
        continue;
      }
      let full: PosterTransactionFull | null = null;
      try {
        full = await client.getTransaction(txId);
      } catch (err) {
        console.error(`[poster] getTransaction(${txId}) failed:`, redactUrl((err as Error).message));
        // leave the event un-processed so the next tick retries
        continue;
      }
      if (full === null) {
        await query(
          `UPDATE poster_webhook_events SET processed = TRUE, processed_at = now() WHERE id = $1`,
          [ev.id],
        );
        continue;
      }
      const result = await ingestTransaction(full);
      if (!result.storeFound) summary.storeMisses += 1;
      if (result.linesInserted > 0) summary.eventsApplied += 1;
      summary.linesInserted += result.linesInserted;
      summary.movementsApplied += result.movementsApplied;
      summary.failedLines += result.failedLines;
      summary.wrongKeyedLines += result.wrongKeyedLines;
      wrongKeyed.push(...result.wrongKeyedDetails);
      await query(
        `UPDATE poster_webhook_events SET processed = TRUE, processed_at = now() WHERE id = $1`,
        [ev.id],
      );
    }
    // EPIC 8.3 — ONE consolidated digest per store for the whole run.
    await emitWrongKeyedDigests(wrongKeyed);
    // C7 — flip to `partial` (with a per-run stats string) when any line of
    // any event raised an exception, even though every other event succeeded.
    if (summary.failedLines > 0) {
      const detail =
        `partial: ${summary.failedLines} failed line(s) across ${summary.eventsScanned} event(s); ` +
        `${summary.linesInserted} line(s) ingested.`;
      await finishSyncRun(
        runId,
        'partial',
        { recordsIn: summary.eventsScanned, recordsApplied: summary.eventsApplied },
        detail,
      );
    } else {
      await finishSyncRun(runId, 'ok', {
        recordsIn: summary.eventsScanned,
        recordsApplied: summary.eventsApplied,
      });
    }
    return summary;
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(
      runId,
      'failed',
      { recordsIn: summary.eventsScanned, recordsApplied: summary.eventsApplied },
      detail,
    );
    await notifyPosterSyncFailed('transactions', detail);
    throw err;
  }
}

/**
 * Fallback poll — fetch transactions in the last `windowMinutes` and ingest
 * any line that was missed (idempotent — the same UNIQUE index protects us).
 */
export async function fallbackPollTransactions(
  client: PosterClient,
  windowMinutes = 30,
): Promise<SalesIngestResult> {
  const runId = await startSyncRun('transactions', 'poll');
  const summary = {
    eventsScanned: 0,
    eventsApplied: 0,
    linesInserted: 0,
    movementsApplied: 0,
    storeMisses: 0,
    failedLines: 0,
    wrongKeyedLines: 0,
  };
  // EPIC 8.3 — collect over-sold lines across the whole poll, digest at the end.
  const wrongKeyed: WrongKeyedLine[] = [];
  try {
    const to = new Date();
    const from = new Date(to.getTime() - windowMinutes * 60_000);
    const dateFrom = formatPosterDateTime(from);
    const dateTo = formatPosterDateTime(to);
    const list = await client.getTransactions({ dateFrom, dateTo, num: 1000 });
    for (const t of list) {
      summary.eventsScanned += 1;
      const txId = Number(t.transaction_id);
      if (!Number.isInteger(txId) || txId <= 0) continue;
      let full: PosterTransactionFull | null;
      try {
        full = await client.getTransaction(txId);
      } catch (err) {
        console.error(`[poster] fallback getTransaction(${txId}) failed:`, redactUrl((err as Error).message));
        continue;
      }
      if (full === null) continue;
      const result = await ingestTransaction(full);
      if (!result.storeFound) summary.storeMisses += 1;
      if (result.linesInserted > 0) summary.eventsApplied += 1;
      summary.linesInserted += result.linesInserted;
      summary.movementsApplied += result.movementsApplied;
      summary.failedLines += result.failedLines;
      summary.wrongKeyedLines += result.wrongKeyedLines;
      wrongKeyed.push(...result.wrongKeyedDetails);
    }
    // EPIC 8.3 — ONE consolidated digest per store for the whole poll.
    await emitWrongKeyedDigests(wrongKeyed);
    if (summary.failedLines > 0) {
      const detail =
        `partial: ${summary.failedLines} failed line(s) across ${summary.eventsScanned} event(s); ` +
        `${summary.linesInserted} line(s) ingested.`;
      await finishSyncRun(
        runId,
        'partial',
        { recordsIn: summary.eventsScanned, recordsApplied: summary.eventsApplied },
        detail,
      );
    } else {
      await finishSyncRun(runId, 'ok', {
        recordsIn: summary.eventsScanned,
        recordsApplied: summary.eventsApplied,
      });
    }
    return summary;
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(
      runId,
      'failed',
      { recordsIn: summary.eventsScanned, recordsApplied: summary.eventsApplied },
      detail,
    );
    await notifyPosterSyncFailed('transactions', detail);
    throw err;
  }
}

function formatPosterDateTime(d: Date): string {
  // Empirical (2026-05-24): dash.getTransactions accepts "YYYY-MM-DD" but
  // returns ZERO rows when a time component is appended. The old
  // "YYYY-MM-DD HH:mm:ss" form silently dropped every poll. Keep it
  // date-only — the 30-min poll window therefore widens to whole days on
  // each tick, but ingestTransaction is idempotent on
  // (poster_transaction_id, product_id, poster_line_id) so re-runs are
  // free.
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
