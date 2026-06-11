/**
 * 0046 — Poster write-back (best-effort outbox).
 *
 * When a store confirms a physical receive (POST /api/replenishment/:id/receive)
 * the received qty should also be reflected back into Poster so the POS stays in
 * sync with the ERP ledger. Two paths:
 *
 *   LIVE   — a write-scope Poster credential (`POSTER_WRITE_TOKEN`) is set; we
 *            call Poster's supply/inventory write method. (The current
 *            `PosterClient` is read-only, so this path throws "not implemented"
 *            until a write method is added — but the toggle + the call site are
 *            in place, ready for the credential.)
 *   QUEUED — no write credential (the default today): we append the WRITE INTENT
 *            into `poster_writeback_queue` with status='pending' and log it, so a
 *            future worker (or manual replay) flushes it once the token exists.
 *
 * Invariant: a Poster failure must NEVER roll back the local receive. The caller
 * runs this AFTER the receive transaction has committed, inside a try/catch, so
 * an enqueue/network error is logged and swallowed (best-effort).
 */
import { query } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import { writeAudit } from '../lib/audit.js';
import { poolRunner } from '../lib/audit.js';

export type PosterWritebackResult = {
  /** Which path actually ran. */
  readonly mode: 'live' | 'queued' | 'skipped';
  /** The queue row id when a row was written (queued / failed-live). */
  readonly queueId: number | null;
  /** Human-readable note for the log / report. */
  readonly note: string;
};

/** True when a write-scope Poster credential is configured. */
export function isPosterWriteEnabled(): boolean {
  return loadConfig().poster.writeToken.trim() !== '';
}

/**
 * Reflect a confirmed received qty back to Poster (best-effort).
 *
 * `qty <= 0` is a no-op (a fully-rejected/brak receive has nothing to write).
 * The function is idempotent per (requestId, productId): the unique index on
 * `poster_writeback_queue` turns a duplicate enqueue into a no-op rather than a
 * second row.
 */
export async function enqueuePosterReceiveWriteback(opts: {
  requestId: number;
  productId: number;
  locationId: number;
  qty: number;
  actorUserId: number | null;
}): Promise<PosterWritebackResult> {
  if (!Number.isFinite(opts.qty) || opts.qty <= 0) {
    return { mode: 'skipped', queueId: null, note: 'qty <= 0 — nothing to write back' };
  }

  // LIVE path — a write credential is configured. The current PosterClient has
  // no write method, so until one lands we record the attempt and fall back to
  // the queue (status='failed') so nothing is silently lost. When a real
  // `createSupply` exists, call it here and mark the row 'sent'.
  if (isPosterWriteEnabled()) {
    try {
      await callPosterWrite(opts);
      const queueId = await insertQueueRow({ ...opts, status: 'sent' });
      await safeAudit(opts, 'poster_writeback.sent', queueId);
      return { mode: 'live', queueId, note: 'written to Poster (live)' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const queueId = await insertQueueRow({ ...opts, status: 'failed', lastError: message });
      await safeAudit(opts, 'poster_writeback.failed', queueId, message);
      console.error('[poster-writeback] live write failed, queued for retry:', message);
      return { mode: 'queued', queueId, note: `live write failed: ${message} — queued` };
    }
  }

  // QUEUED path — default today. Record the intent; a future worker flushes it.
  const queueId = await insertQueueRow({ ...opts, status: 'pending' });
  await safeAudit(opts, 'poster_writeback.queued', queueId);
  console.info(
    `[poster-writeback] queued (no write token): request=${opts.requestId} ` +
      `product=${opts.productId} location=${opts.locationId} qty=${opts.qty}`,
  );
  return { mode: 'queued', queueId, note: 'queued (no Poster write token configured)' };
}

/**
 * The actual Poster write call. The live PosterClient is read-only, so this
 * throws until a write method (`createSupply` / inventory adjustment) is added.
 * Kept as a separate function so the wiring is obvious and the test can stub it.
 */
async function callPosterWrite(_opts: {
  requestId: number;
  productId: number;
  locationId: number;
  qty: number;
}): Promise<void> {
  throw new Error(
    'Poster write method (createSupply/inventory) is not implemented in the read-only client yet.',
  );
}

/**
 * Append one queue row. The unique index on (request_id, product_id) makes a
 * duplicate enqueue a no-op — `ON CONFLICT DO NOTHING` then re-reads the
 * existing row's id so callers always get a stable id back.
 */
async function insertQueueRow(opts: {
  requestId: number;
  productId: number;
  locationId: number;
  qty: number;
  status: 'pending' | 'sent' | 'failed';
  lastError?: string;
}): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO poster_writeback_queue
       (request_id, product_id, location_id, qty, status, last_error, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (request_id, product_id) DO NOTHING
     RETURNING id`,
    [
      opts.requestId,
      opts.productId,
      opts.locationId,
      opts.qty,
      opts.status,
      opts.lastError ?? null,
      opts.status === 'sent' ? new Date() : null,
    ],
  );
  if (rows[0] !== undefined) {
    return Number(rows[0].id);
  }
  // Conflict — a row already exists for this (request, product). Return it.
  const existing = await query<{ id: number }>(
    'SELECT id FROM poster_writeback_queue WHERE request_id = $1 AND product_id = $2',
    [opts.requestId, opts.productId],
  );
  return Number(existing.rows[0]?.id ?? 0);
}

/**
 * Result of a product-master write-back enqueue.
 */
export type ProductWritebackResult = {
  /** 'queued' when a row was written; 'skipped' when there was nothing to push. */
  readonly mode: 'queued' | 'skipped';
  /** The `poster_product_writeback` row id when one was written. */
  readonly queueId: number | null;
  /** Human-readable note for the log / report. */
  readonly note: string;
};

/**
 * Enqueue a PRODUCT-MASTER field change (e.g. unit) for write-back to Poster.
 *
 * Best-effort outbox only — the live PosterClient is read-only, so this NEVER
 * calls Poster now; it just appends a `pending` row to `poster_product_writeback`
 * (migration 0050). A future worker flushes the queue via `menu.updateProduct`
 * once a write-capable credential exists.
 *
 * No-op (mode='skipped', no row) when `posterProductId` is null — a product with
 * no Poster mapping has nothing to push to the POS. The caller still updates the
 * ERP DB; only the write-back is skipped.
 *
 * Invariant: this runs AFTER the local update has committed, so an enqueue error
 * must be caught/swallowed by the caller — a Poster failure cannot break the
 * local edit.
 */
export async function enqueueProductUnitWriteback(opts: {
  productId: number;
  posterProductId: number | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
}): Promise<ProductWritebackResult> {
  if (opts.posterProductId === null) {
    return {
      mode: 'skipped',
      queueId: null,
      note: 'no poster_product_id — nothing to push to Poster',
    };
  }

  const { rows } = await query<{ id: number }>(
    `INSERT INTO poster_product_writeback
       (product_id, poster_product_id, field, old_value, new_value, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id`,
    [opts.productId, opts.posterProductId, opts.field, opts.oldValue, opts.newValue],
  );
  const queueId = rows[0] !== undefined ? Number(rows[0].id) : null;
  console.info(
    `[poster-product-writeback] queued (no write token): product=${opts.productId} ` +
      `field=${opts.field} ${opts.oldValue ?? '∅'}→${opts.newValue ?? '∅'}`,
  );
  return { mode: 'queued', queueId, note: 'queued (no Poster write token configured)' };
}

/** Best-effort audit — a logging failure must not break the receive flow. */
async function safeAudit(
  opts: { requestId: number; productId: number; locationId: number; qty: number; actorUserId: number | null },
  action: string,
  queueId: number,
  error?: string,
): Promise<void> {
  try {
    await writeAudit(poolRunner, {
      actorUserId: opts.actorUserId,
      action,
      entity: 'poster_writeback_queue',
      entityId: queueId,
      payload: {
        request_id: opts.requestId,
        product_id: opts.productId,
        location_id: opts.locationId,
        qty: opts.qty,
        ...(error !== undefined ? { error } : {}),
      },
    });
  } catch {
    // Swallow — audit is best-effort here.
  }
}
