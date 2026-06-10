/**
 * One-off cleanup — remove PROVABLE seed/demo rows that pollute the
 * Tranzaksiyalar list and the replenishment boards, after the owner reviewed
 * the live data ("seed'larni o'chirib tashla" + the bogus #15714 «кабартма» /
 * «томат» 49 990 self-routed requests).
 *
 * Everything happens inside ONE transaction (invariant 1) and is idempotent:
 * a second run finds nothing matching and is a clean no-op. Per-table counts
 * are printed BEFORE and AFTER so the diff is auditable, and a single
 * `audit_log` row records the cleanup (invariant 5 — never erase the trail).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DELETES — only rows whose seed/garbage origin is PROVABLE:
 *
 *   CLASS A — demo-seed fixtures (`scripts/seed-demo.ts`).
 *     That script tags every fabricated row with `note LIKE 'demo-seed%'`
 *     (its `MARKER` constant). So `note LIKE 'demo-seed%'` is a watertight
 *     fingerprint — Poster sync and the engine never write that note.
 *     Covers: stock_movements, replenishment_requests, production_orders,
 *     purchase_orders.
 *
 *   CLASS B — the buggy self-routed 49.99 requests the owner named (#15714).
 *     Shape: `qty_needed = 49.99 AND requester_location_id = target_location_id
 *     AND created_by IS NULL AND note IS NULL`. A request whose target equals
 *     its requester is a contradiction the CURRENT engine cannot emit
 *     (`createRequestInTx` inserts `target_location_id = NULL`; `advanceNew`
 *     resolves it to a DIFFERENT supplier up the topology). These 12 rows are
 *     stale output from an OLD engine build (their audit payload lacks the
 *     0065 tree keys), confirmed garbage by the owner. The predicate is exact:
 *     it matches those 12 rows and NOTHING else (verified — zero false hits on
 *     normal-shaped rows). Their `replenishment_transitions` cascade away.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT TOUCH (no provable seed origin — left for the owner):
 *
 *   - Poster-synced data: `sales` rows and the `adjust` / `sale`
 *     `stock_movements` (created_by IS NULL, no note) — the storage-leftover
 *     and sales sync. These must NEVER be deleted.
 *   - Normal-shaped engine requests with NULL creator (e.g. the 06-05 batch of
 *     CANCELLED requests) — legitimate scan history, not garbage.
 *   - Manual requests by real users (e.g. created_by = central-warehouse-
 *     manager, origin='manual'), even when self-routed at the central
 *     warehouse — real operator activity.
 *   - Any movement with a NULL note authored by a real user — real operations.
 *
 * Usage:  npx tsx scripts/delete-seed-replenishment-and-movements.ts
 *   (reads apps/backend/.env -> DATABASE_URL = adia_erp_dev)
 */
import { closePool, query, withTransaction, type TxClient } from '../src/db/index.js';
import { writeAudit } from '../src/lib/audit.js';

/**
 * CLASS A predicate — the demo-seed `note` fingerprint. Exported so a test can
 * assert it (and only it) is what we delete. `seed-demo.ts` writes
 * `note = 'demo-seed:...'` on every fabricated row.
 */
export const DEMO_SEED_NOTE_PREDICATE = `note LIKE 'demo-seed%'`;

/**
 * CLASS B predicate — the buggy self-routed 49.99 requests (#15714 family).
 * `requester_location_id = target_location_id` is the structural tell (the
 * current engine can never produce it); the other three clauses fence the
 * predicate so tightly it matches ONLY the 12 known-bad rows.
 */
export const BUGGY_SELF_ROUTE_REQUEST_PREDICATE = `qty_needed = 49.99
   AND target_location_id IS NOT NULL
   AND requester_location_id = target_location_id
   AND created_by IS NULL
   AND note IS NULL`;

type CountRow = { n: number };

/** count(*) for a table under an arbitrary (parameterless) WHERE fragment. */
async function countWhere(runner: TxClient, table: string, predicate: string): Promise<number> {
  const { rows } = await runner.query<CountRow>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${predicate}`,
  );
  return rows[0]?.n ?? 0;
}

/** Run a `DELETE ... WHERE <predicate>` (no params — fragments are literals). */
async function deleteWhere(
  tx: TxClient,
  label: string,
  table: string,
  predicate: string,
  deleted: Record<string, number>,
): Promise<void> {
  const res = await tx.query(`DELETE FROM ${table} WHERE ${predicate}`);
  deleted[label] = res.rowCount;
}

/** Snapshot the per-class counts in every affected table (for before/after). */
async function snapshot(runner: TxClient): Promise<Record<string, number>> {
  return {
    'A: stock_movements (demo-seed note)': await countWhere(
      runner,
      'stock_movements',
      DEMO_SEED_NOTE_PREDICATE,
    ),
    'A: replenishment_requests (demo-seed note)': await countWhere(
      runner,
      'replenishment_requests',
      DEMO_SEED_NOTE_PREDICATE,
    ),
    'A: production_orders (demo-seed note)': await countWhere(
      runner,
      'production_orders',
      DEMO_SEED_NOTE_PREDICATE,
    ),
    'A: purchase_orders (demo-seed note)': await countWhere(
      runner,
      'purchase_orders',
      DEMO_SEED_NOTE_PREDICATE,
    ),
    'B: replenishment_requests (49.99 self-route)': await countWhere(
      runner,
      'replenishment_requests',
      BUGGY_SELF_ROUTE_REQUEST_PREDICATE,
    ),
  };
}

function printCounts(title: string, counts: Record<string, number>): void {
  console.log(`[cleanup] ${title}:`);
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k}: ${v}`);
  }
}

async function main(): Promise<void> {
  // BEFORE snapshot (fresh read on the pool).
  const before = await snapshot({ query });
  printCounts('counts BEFORE', before);

  const deleted: Record<string, number> = {};

  await withTransaction(async (tx) => {
    // --- CLASS A — demo-seed fixtures ------------------------------------
    // Order: movements first (they reference demo PO/PU via SET-NULL columns,
    // and a demo PU references a demo movement via received_movement_id — both
    // SET NULL, so any order is safe; this order keeps the log readable).
    await deleteWhere(
      tx,
      'A1 stock_movements',
      'stock_movements',
      DEMO_SEED_NOTE_PREDICATE,
      deleted,
    );
    await deleteWhere(
      tx,
      'A2 replenishment_requests',
      'replenishment_requests',
      DEMO_SEED_NOTE_PREDICATE,
      deleted,
    );
    await deleteWhere(
      tx,
      'A3 production_orders',
      'production_orders',
      DEMO_SEED_NOTE_PREDICATE,
      deleted,
    );
    await deleteWhere(
      tx,
      'A4 purchase_orders',
      'purchase_orders',
      DEMO_SEED_NOTE_PREDICATE,
      deleted,
    );

    // --- CLASS B — buggy self-routed 49.99 requests ----------------------
    // replenishment_transitions / waiters / dialog_sessions cascade via FK
    // ON DELETE CASCADE; production/purchase orders & movements SET NULL.
    await deleteWhere(
      tx,
      'B1 replenishment_requests (49.99 self-route)',
      'replenishment_requests',
      BUGGY_SELF_ROUTE_REQUEST_PREDICATE,
      deleted,
    );

    // --- Audit the cleanup (system actor) --------------------------------
    await writeAudit(tx, {
      actorUserId: null,
      action: 'seed.cleanup',
      entity: 'replenishment_requests',
      entityId: null,
      payload: {
        reason:
          'remove provable seed/demo rows + buggy self-routed 49.99 requests ' +
          '(owner: "seed\'larni o\'chirib tashla"; #15714 «кабартма»/«томат»)',
        criteria: {
          classA_demo_seed_note: DEMO_SEED_NOTE_PREDICATE,
          classB_self_route_4999: BUGGY_SELF_ROUTE_REQUEST_PREDICATE,
        },
        rows_deleted: deleted,
      },
    });
  });

  printCounts('rows DELETED', deleted);

  // AFTER snapshot — every class must read zero now (proves the delete + that
  // a re-run is a no-op).
  const after = await snapshot({ query });
  printCounts('counts AFTER', after);

  const residual = Object.entries(after).filter(([, v]) => v > 0);
  if (residual.length > 0) {
    throw new Error(
      `[cleanup] ABORT: classes still present after delete: ${residual
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    );
  }
  console.log('[cleanup] OK — all targeted classes are now empty (idempotent re-run is a no-op).');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[cleanup] failed:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
