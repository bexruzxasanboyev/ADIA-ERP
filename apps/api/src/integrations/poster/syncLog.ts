/**
 * Poster sync log helper — every sync run starts with an insert, ends with a
 * status/counters update. Failures are notified to PM via the `notifications`
 * table (`type='poster_sync_failed'`).
 *
 * Why one helper: every entity (spots/storages/ingredients/products/leftovers/
 * transactions) records the same shape, and the workers must never forget the
 * `finished_at` + status update on the error path.
 */
import { query } from '../../db/index.js';

export type SyncEntity =
  | 'spots'
  | 'storages'
  | 'ingredients'
  | 'products'
  | 'leftovers'
  | 'transactions';

export type SyncTrigger = 'poll' | 'webhook' | 'manual';

export type SyncSummary = {
  readonly recordsIn: number;
  readonly recordsApplied: number;
};

/** Insert a `started` row and return its id. */
export async function startSyncRun(
  entity: SyncEntity,
  trigger: SyncTrigger,
): Promise<number> {
  // poster_sync_status enum has no 'started' value; we initialise as 'partial'
  // and overwrite on completion. 'partial' means "in progress / unknown outcome"
  // until the finishing update lands. This keeps the enum constrained without
  // adding an extra value just for the in-flight window.
  const { rows } = await query<{ id: number }>(
    `INSERT INTO poster_sync_log (entity, status, trigger, started_at)
     VALUES ($1, 'partial', $2, now())
     RETURNING id`,
    [entity, trigger],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('poster_sync_log insert returned no id');
  return id;
}

/** Mark a sync run finished with ok/partial/failed. */
export async function finishSyncRun(
  id: number,
  status: 'ok' | 'partial' | 'failed',
  summary: SyncSummary,
  errorDetail: string | null = null,
): Promise<void> {
  await query(
    `UPDATE poster_sync_log
        SET status = $1,
            records_in = $2,
            records_applied = $3,
            error_detail = $4,
            finished_at = now()
      WHERE id = $5`,
    [status, summary.recordsIn, summary.recordsApplied, errorDetail, id],
  );
}

/**
 * Drop a `poster_sync_failed` notification for every active PM user.
 * Best-effort — failures are swallowed (a sync-failure path must never throw
 * a SECOND error and hide the first).
 */
export async function notifyPosterSyncFailed(
  entity: SyncEntity,
  errorDetail: string,
): Promise<void> {
  try {
    const { rows } = await query<{ id: number }>(
      `SELECT id FROM users WHERE role = 'pm' AND is_active = TRUE`,
    );
    for (const row of rows) {
      await query(
        `INSERT INTO notifications (recipient_user_id, type, title, body, payload)
         VALUES ($1, 'poster_sync_failed', $2, $3, $4)`,
        [
          row.id,
          `Poster sync failed: ${entity}`,
          errorDetail.slice(0, 500),
          JSON.stringify({ entity, error: errorDetail }),
        ],
      );
    }
  } catch (err) {
    console.error('[poster] notifyPosterSyncFailed swallow:', (err as Error).message);
  }
}
