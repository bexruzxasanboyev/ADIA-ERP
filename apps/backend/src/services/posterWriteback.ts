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

/** Direction of a Poster write-back (0058). Part of the idempotency key. */
export type PosterWritebackDirection = 'store_in' | 'central_out';

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
 * 0058 — MASTER SAFETY GATE for LIVE Poster writes. A live call to the `adia`
 * Poster account happens ONLY when BOTH the env flag `POSTER_WRITE_ENABLED` is
 * true AND a write-scope token is configured. The default (flag false) is a
 * DRY-RUN: the intended Poster call + payload are logged and the intent is
 * enqueued, but no live request is made. NODE_ENV=test forces the flag off (see
 * config), so a unit test can never reach the live account by accident.
 */
export function isLivePosterWriteEnabled(): boolean {
  const cfg = loadConfig();
  return cfg.poster.writeEnabled && cfg.poster.writeToken.trim() !== '';
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

// -----------------------------------------------------------------------------
// 0058 — CENTRAL decrement write-back (store-accept -> central goods left)
// -----------------------------------------------------------------------------

/**
 * The intended Poster `storage.createWriteOff` call for the central decrement —
 * surfaced so the DRY-RUN log + the unit test can assert the EXACT payload that
 * WOULD be sent to the live `adia` account.
 *
 * Maps to the API in `docs/adia-poster-api.md` §5.2:
 *   storage_id              — the central's Poster storage (singleton = 8).
 *   type                    — write-off reason code (1 = generic write-off).
 *   date                    — "YYYY-MM-DD HH:mm:ss".
 *   ingredients[0][id]      — the product's Poster ingredient id.
 *   ingredients[0][type]    — "1" raw ingredient | "2" finished good (G/P).
 *   ingredients[0][weight]  — the qty leaving the central.
 */
export type PosterCentralWriteOffPayload = {
  readonly method: 'storage.createWriteOff';
  readonly storage_id: number;
  readonly type: number;
  readonly date: string;
  readonly ingredients: ReadonlyArray<{
    readonly id: number;
    readonly type: number;
    readonly weight: number;
  }>;
};

/** Result of a central-decrement write-back enqueue. */
export type CentralWritebackResult = {
  /** Which path ran: live (real call), dry_run (logged only), or skipped. */
  readonly mode: 'live' | 'dry_run' | 'skipped';
  /** The queue row id when one was written. */
  readonly queueId: number | null;
  /** The intended Poster payload (present on dry_run / live), for the log/test. */
  readonly payload: PosterCentralWriteOffPayload | null;
  /** Human-readable note for the log / report. */
  readonly note: string;
};

/** Resolve the central's Poster storage id + the product's Poster ingredient. */
async function resolveCentralWriteOffTargets(opts: {
  centralLocationId: number;
  productId: number;
}): Promise<
  | { storageId: number; ingredientId: number; ingredientType: number }
  | null
> {
  const { rows: locRows } = await query<{ poster_storage_id: number | null }>(
    'SELECT poster_storage_id FROM locations WHERE id = $1',
    [opts.centralLocationId],
  );
  const storageId = locRows[0]?.poster_storage_id ?? null;
  if (storageId === null) return null;

  const { rows: prodRows } = await query<{
    poster_ingredient_id: number | null;
    type: string;
  }>('SELECT poster_ingredient_id, type FROM products WHERE id = $1', [opts.productId]);
  const ingredientId = prodRows[0]?.poster_ingredient_id ?? null;
  if (ingredientId === null) return null;

  // Poster ingredient type: raw ingredients are "1"; finished / semi goods are
  // tracked as G/P "2" in Poster storage. The central holds finished goods.
  const ingredientType = prodRows[0]?.type === 'raw' ? 1 : 2;
  return { storageId: Number(storageId), ingredientId: Number(ingredientId), ingredientType };
}

/** Format a Date as Poster's "YYYY-MM-DD HH:mm:ss" (local time). */
function posterDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/**
 * 0058 — Decrement the CENTRAL warehouse's Poster storage when a store ACCEPTS a
 * shipment that left the central (the goods physically left central, so the POS
 * must reflect it). Best-effort + idempotent (direction='central_out' key).
 *
 * SAFETY — gated by the master flag `POSTER_WRITE_ENABLED` (see
 * `isLivePosterWriteEnabled`):
 *   * DEFAULT (flag off) -> DRY-RUN: build + LOG the intended
 *     `storage.createWriteOff` payload, enqueue a `pending` row, and return
 *     `mode='dry_run'`. NO live Poster call is made.
 *   * flag on + write token set -> LIVE: call Poster, enqueue a `sent` row (or
 *     `failed` + requeue on error).
 *
 * No-op (`mode='skipped'`, no row) when `qty <= 0`, or when the central has no
 * `poster_storage_id`, or the product has no `poster_ingredient_id` (nothing to
 * push to the POS). The local accept is unaffected either way — the caller runs
 * this AFTER the accept commits, inside a try/catch.
 */
export async function enqueueCentralDecrementWriteback(opts: {
  requestId: number;
  productId: number;
  centralLocationId: number;
  qty: number;
  actorUserId: number | null;
}): Promise<CentralWritebackResult> {
  if (!Number.isFinite(opts.qty) || opts.qty <= 0) {
    return { mode: 'skipped', queueId: null, payload: null, note: 'qty <= 0 — nothing to decrement' };
  }
  const targets = await resolveCentralWriteOffTargets({
    centralLocationId: opts.centralLocationId,
    productId: opts.productId,
  });
  if (targets === null) {
    return {
      mode: 'skipped',
      queueId: null,
      payload: null,
      note: 'no poster_storage_id on central or no poster_ingredient_id on product',
    };
  }

  const payload: PosterCentralWriteOffPayload = {
    method: 'storage.createWriteOff',
    storage_id: targets.storageId,
    type: 1,
    date: posterDate(new Date()),
    ingredients: [
      { id: targets.ingredientId, type: targets.ingredientType, weight: opts.qty },
    ],
  };

  // LIVE path — only when the master flag AND a write token are set. We DO NOT
  // implement the live HTTP call against the read-only client here; when a real
  // write method lands, call it in `callPosterCentralWriteOff` and mark 'sent'.
  if (isLivePosterWriteEnabled()) {
    try {
      await callPosterCentralWriteOff(payload);
      const queueId = await insertQueueRow({
        requestId: opts.requestId,
        productId: opts.productId,
        locationId: opts.centralLocationId,
        qty: opts.qty,
        status: 'sent',
        direction: 'central_out',
      });
      await safeAudit(
        { ...opts, locationId: opts.centralLocationId },
        'poster_writeback.central_sent',
        queueId,
      );
      return { mode: 'live', queueId, payload, note: 'central decrement written to Poster (live)' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const queueId = await insertQueueRow({
        requestId: opts.requestId,
        productId: opts.productId,
        locationId: opts.centralLocationId,
        qty: opts.qty,
        status: 'failed',
        direction: 'central_out',
        lastError: message,
      });
      await safeAudit(
        { ...opts, locationId: opts.centralLocationId },
        'poster_writeback.central_failed',
        queueId,
        message,
      );
      console.error('[poster-writeback] central live write failed, queued for retry:', message);
      return { mode: 'live', queueId, payload, note: `live write failed: ${message} — queued` };
    }
  }

  // DRY-RUN path (default) — log the intended payload, enqueue 'pending', NEVER
  // call live Poster. This is the path exercised by tests + by today's runtime.
  const queueId = await insertQueueRow({
    requestId: opts.requestId,
    productId: opts.productId,
    locationId: opts.centralLocationId,
    qty: opts.qty,
    status: 'pending',
    direction: 'central_out',
  });
  await safeAudit(
    { ...opts, locationId: opts.centralLocationId },
    'poster_writeback.central_dry_run',
    queueId,
  );
  console.info(
    '[poster-writeback] DRY-RUN central decrement (POSTER_WRITE_ENABLED off): ' +
      `request=${opts.requestId} would call ${payload.method} ` +
      JSON.stringify({
        storage_id: payload.storage_id,
        type: payload.type,
        date: payload.date,
        ingredients: payload.ingredients,
      }),
  );
  return { mode: 'dry_run', queueId, payload, note: 'dry-run (POSTER_WRITE_ENABLED off) — logged, not sent' };
}

/**
 * The real central write-off HTTP call. The live PosterClient is read-only, so
 * this throws until a write method is added — but it is ONLY reachable behind
 * `isLivePosterWriteEnabled()` (flag on + token), which is forced off in tests,
 * so no test ever hits it. Kept separate so the wiring is obvious and a future
 * write method has one place to land.
 */
async function callPosterCentralWriteOff(_payload: PosterCentralWriteOffPayload): Promise<void> {
  throw new Error(
    'Poster storage.createWriteOff is not implemented in the read-only client yet.',
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
  /** 0058 — write direction; part of the idempotency key. Default store_in. */
  direction?: PosterWritebackDirection;
  lastError?: string;
}): Promise<number> {
  const direction: PosterWritebackDirection = opts.direction ?? 'store_in';
  const { rows } = await query<{ id: number }>(
    `INSERT INTO poster_writeback_queue
       (request_id, product_id, location_id, qty, status, direction, last_error, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (request_id, product_id, direction) DO NOTHING
     RETURNING id`,
    [
      opts.requestId,
      opts.productId,
      opts.locationId,
      opts.qty,
      opts.status,
      direction,
      opts.lastError ?? null,
      opts.status === 'sent' ? new Date() : null,
    ],
  );
  if (rows[0] !== undefined) {
    return Number(rows[0].id);
  }
  // Conflict — a row already exists for this (request, product, direction).
  const existing = await query<{ id: number }>(
    `SELECT id FROM poster_writeback_queue
      WHERE request_id = $1 AND product_id = $2 AND direction = $3`,
    [opts.requestId, opts.productId, direction],
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
