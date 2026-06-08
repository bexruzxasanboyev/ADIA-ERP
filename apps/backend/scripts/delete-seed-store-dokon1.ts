/**
 * One-off cleanup — remove the SEED store «Do'kon 1» (location id=42) from the
 * dev database, leaving only real Poster stores (poster_spot_id IS NOT NULL,
 * plus the owner-retained Чигатай id=14 which is out of scope here).
 *
 * Why this is safe:
 *   1. It refuses to run unless the target row is *exactly* the seed store
 *      (id=42 AND name='Do''kon 1' AND poster_spot_id IS NULL). A real Poster
 *      store can never match, so the script can never delete one.
 *   2. Everything happens inside ONE transaction (invariant 1): all FK
 *      dependents removed, the orphaned seed user reassigned, the audit row
 *      written, and the location deleted — all or nothing.
 *   3. Idempotent: re-running after a successful pass finds no id=42 row and
 *      exits as a clean no-op (0 rows touched).
 *
 * What it does NOT touch:
 *   - location id=14 («Чигатай», poster_spot_id NULL) — owner has not approved
 *     removing it. A pre-flight guard aborts if id=42 ever resolved to 14.
 *   - the seed user id=20 ('store-manager') is NOT deleted — it is reassigned
 *     to the real «Чигатай» (id=86, poster_spot_id=3) so login keeps working.
 *
 * Usage:  npx tsx scripts/delete-seed-store-dokon1.ts
 */
import { closePool, withTransaction, type TxClient } from '../src/db/index.js';
import { writeAudit } from '../src/lib/audit.js';

/** The seed store we intend to remove. */
const SEED_STORE_ID = 42;
const SEED_STORE_NAME = "Do'kon 1";

/** A real Poster store the orphaned seed user is reassigned to. */
const REASSIGN_TO_LOCATION_ID = 86; // «Чигатай», poster_spot_id=3

/** The orphaned seed user that must keep working after the store is gone. */
const SEED_USER_ID = 20; // username 'store-manager'

/** A store id we must never delete, regardless of input. */
const PROTECTED_LOCATION_ID = 14; // «Чигатай» (poster_spot_id NULL), owner-retained

type LocationRow = {
  id: number;
  name: string;
  type: string;
  poster_spot_id: number | null;
  manager_user_id: number | null;
};

/** Run one `DELETE ... WHERE <predicate referencing $1=locationId>` and report the count. */
async function deleteWhere(
  tx: TxClient,
  label: string,
  sql: string,
  locationId: number,
  deleted: Record<string, number>,
): Promise<void> {
  const res = await tx.query(sql, [locationId]);
  deleted[label] = res.rowCount;
}

async function main(): Promise<void> {
  await withTransaction(async (tx) => {
    // --- 1. Verify the target is truly the seed store --------------------
    const found = await tx.query<LocationRow>(
      `SELECT id, name, type, poster_spot_id, manager_user_id
         FROM locations
        WHERE id = $1`,
      [SEED_STORE_ID],
    );

    if (found.rowCount === 0) {
      console.log(
        `[cleanup] location id=${SEED_STORE_ID} not found — already removed. No-op.`,
      );
      return;
    }

    const loc = found.rows[0];

    // Hard guard: never the protected store.
    if (loc.id === PROTECTED_LOCATION_ID) {
      throw new Error(
        `[cleanup] ABORT: target resolved to protected location id=${PROTECTED_LOCATION_ID} — refusing.`,
      );
    }

    // The seed-store fingerprint: id + exact name + NULL poster_spot_id.
    const matchesSeed =
      loc.id === SEED_STORE_ID &&
      loc.name === SEED_STORE_NAME &&
      loc.poster_spot_id === null &&
      loc.type === 'store';

    if (!matchesSeed) {
      throw new Error(
        `[cleanup] ABORT: location id=${SEED_STORE_ID} does not match the seed-store ` +
          `fingerprint (name='${loc.name}', poster_spot_id=${String(loc.poster_spot_id)}, ` +
          `type='${loc.type}'). Refusing to delete — this may be a real store.`,
      );
    }

    console.log(
      `[cleanup] target verified: id=${loc.id} name='${loc.name}' poster_spot_id=NULL — proceeding.`,
    );

    const deleted: Record<string, number> = {};

    // --- 2. Delete / null dependents in FK-safe order --------------------
    // audit_log: preserve history — SET NULL on the nullable active_location_id.
    {
      const res = await tx.query(
        `UPDATE audit_log SET active_location_id = NULL WHERE active_location_id = $1`,
        [SEED_STORE_ID],
      );
      deleted['audit_log.active_location_id (SET NULL)'] = res.rowCount;
    }

    await deleteWhere(tx, 'forecasts', `DELETE FROM forecasts WHERE location_id = $1`, SEED_STORE_ID, deleted);
    await deleteWhere(
      tx,
      'location_flows',
      `DELETE FROM location_flows WHERE from_location_id = $1 OR to_location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );
    await deleteWhere(tx, 'nakladnoy', `DELETE FROM nakladnoy WHERE location_id = $1`, SEED_STORE_ID, deleted);
    await deleteWhere(
      tx,
      'poster_writeback_queue',
      `DELETE FROM poster_writeback_queue WHERE location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );
    await deleteWhere(
      tx,
      'production_dialog_sessions',
      `DELETE FROM production_dialog_sessions WHERE location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );
    await deleteWhere(
      tx,
      'production_orders',
      `DELETE FROM production_orders WHERE location_id = $1 OR target_location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );
    await deleteWhere(
      tx,
      'purchase_orders',
      `DELETE FROM purchase_orders WHERE target_location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );
    await deleteWhere(
      tx,
      'replenishment_requests',
      `DELETE FROM replenishment_requests WHERE target_location_id = $1 OR requester_location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );
    await deleteWhere(tx, 'sales', `DELETE FROM sales WHERE store_id = $1`, SEED_STORE_ID, deleted);
    await deleteWhere(
      tx,
      'sales_stats_daily',
      `DELETE FROM sales_stats_daily WHERE location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );
    await deleteWhere(tx, 'stock', `DELETE FROM stock WHERE location_id = $1`, SEED_STORE_ID, deleted);
    await deleteWhere(
      tx,
      'stock_movements',
      `DELETE FROM stock_movements WHERE from_location_id = $1 OR to_location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );

    // --- 3. Handle the orphaned seed user (reassign, do NOT delete) ------
    // Clear locations.manager_user_id if it points at the seed user (it does:
    // store 42 is self-managed by user 20). Also clear any other location that
    // happens to be managed by the seed user, so nothing dangles.
    const mgrCleared = await tx.query(
      `UPDATE locations SET manager_user_id = NULL WHERE manager_user_id = $1`,
      [SEED_USER_ID],
    );
    deleted['locations.manager_user_id (cleared, SET NULL)'] = mgrCleared.rowCount;

    // Reassign user_locations rows for the seed user from store 42 -> store 86,
    // skipping any that would collide with an existing (user, location) row.
    const ulMoved = await tx.query(
      `UPDATE user_locations ul
          SET location_id = $1
        WHERE ul.user_id = $2
          AND ul.location_id = $3
          AND NOT EXISTS (
            SELECT 1 FROM user_locations x
             WHERE x.user_id = $2 AND x.location_id = $1
          )`,
      [REASSIGN_TO_LOCATION_ID, SEED_USER_ID, SEED_STORE_ID],
    );
    deleted['user_locations (reassigned 42->86)'] = ulMoved.rowCount;

    // Any user_locations still pointing at 42 (e.g. a collision left a dup, or
    // another user) must be removed so the location can be deleted.
    await deleteWhere(
      tx,
      'user_locations (residual on 42 removed)',
      `DELETE FROM user_locations WHERE location_id = $1`,
      SEED_STORE_ID,
      deleted,
    );

    // Repoint the seed user's primary location to the real store.
    const userMoved = await tx.query<{ id: number; username: string; location_id: number }>(
      `UPDATE users
          SET location_id = $1
        WHERE id = $2 AND location_id = $3
      RETURNING id, username, location_id`,
      [REASSIGN_TO_LOCATION_ID, SEED_USER_ID, SEED_STORE_ID],
    );
    deleted['users.location_id (reassigned 42->86)'] = userMoved.rowCount;

    // Any *other* user still on 42 would block the delete — repoint them too,
    // defensively (none expected).
    const otherUsers = await tx.query(
      `UPDATE users SET location_id = $1 WHERE location_id = $2`,
      [REASSIGN_TO_LOCATION_ID, SEED_STORE_ID],
    );
    deleted['users.location_id (other residual reassigned)'] = otherUsers.rowCount;

    // products.workshop_location_id never points at a store, but null it
    // defensively so a stray row can't block the delete.
    await deleteOrNullWorkshop(tx, deleted);

    // --- 4. Audit-log the removal (system action) ------------------------
    await writeAudit(tx, {
      actorUserId: null,
      action: 'location.delete',
      entity: 'locations',
      entityId: SEED_STORE_ID,
      payload: {
        reason: 'remove seed store «Do\'kon 1» (poster_spot_id IS NULL)',
        name: loc.name,
        reassigned_user_id: SEED_USER_ID,
        reassigned_to_location_id: REASSIGN_TO_LOCATION_ID,
        rows_affected: deleted,
      },
    });

    // --- 5. Delete the location row last ---------------------------------
    const locDeleted = await tx.query(
      `DELETE FROM locations WHERE id = $1 AND name = $2 AND poster_spot_id IS NULL`,
      [SEED_STORE_ID, SEED_STORE_NAME],
    );
    deleted['locations (the seed store)'] = locDeleted.rowCount;

    if (locDeleted.rowCount !== 1) {
      throw new Error(
        `[cleanup] ABORT: expected to delete exactly 1 location, deleted ${locDeleted.rowCount}. Rolling back.`,
      );
    }

    console.log('[cleanup] rows affected per table:');
    for (const [k, v] of Object.entries(deleted)) {
      console.log(`  ${k}: ${v}`);
    }
    console.log(
      `[cleanup] user id=${SEED_USER_ID} ('store-manager') reassigned to location id=${REASSIGN_TO_LOCATION_ID}.`,
    );
  });

  // --- 6. Verify (outside the tx, fresh read) ----------------------------
  await verify();
}

/** products.workshop_location_id never matches a store; null defensively. */
async function deleteOrNullWorkshop(tx: TxClient, deleted: Record<string, number>): Promise<void> {
  const res = await tx.query(
    `UPDATE products SET workshop_location_id = NULL WHERE workshop_location_id = $1`,
    [SEED_STORE_ID],
  );
  deleted['products.workshop_location_id (SET NULL)'] = res.rowCount;
}

async function verify(): Promise<void> {
  const { query } = await import('../src/db/index.js');

  const gone = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM locations WHERE id = $1`,
    [SEED_STORE_ID],
  );
  console.log(`[verify] «Do'kon 1» (id=${SEED_STORE_ID}) present: ${gone.rows[0].n === 0 ? 'NO (gone)' : 'YES (FAIL)'}`);

  const stores = await query<{ id: number; name: string; poster_spot_id: number | null }>(
    `SELECT id, name, poster_spot_id FROM locations WHERE type = 'store' ORDER BY id`,
  );
  console.log('[verify] remaining stores:');
  for (const s of stores.rows) {
    console.log(`  id=${s.id} name='${s.name}' poster_spot_id=${String(s.poster_spot_id)}`);
  }

  const user = await query<{ id: number; username: string; location_id: number | null; loc_name: string | null }>(
    `SELECT u.id, u.username, u.location_id, l.name AS loc_name
       FROM users u LEFT JOIN locations l ON l.id = u.location_id
      WHERE u.id = $1`,
    [SEED_USER_ID],
  );
  const u = user.rows[0];
  console.log(
    `[verify] user id=${u.id} ('${u.username}') -> location_id=${String(u.location_id)} ('${String(u.loc_name)}')`,
  );

  // Hard self-checks
  if (gone.rows[0].n !== 0) throw new Error('[verify] FAIL: seed store still present.');
  if (u.location_id !== REASSIGN_TO_LOCATION_ID || u.loc_name === null) {
    throw new Error('[verify] FAIL: seed user not pointing at a valid real store.');
  }
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[cleanup] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
