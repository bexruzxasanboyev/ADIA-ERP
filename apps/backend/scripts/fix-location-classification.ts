/**
 * One-off DEV data fix — reconcile `locations` classification with ADR-0017
 * (`src/integrations/poster/storageClassification.ts` is the source of truth;
 * this script does NOT modify it).
 *
 * The dev `locations` table accumulated stale demo/seed rows that conflict
 * with the live Poster storage classification. ADR-0017 says there is exactly
 * ONE central warehouse (Склад Центральный, poster_storage_id=8, id 15), and
 * the store-backing storages must live on their POS spot store rows.
 *
 * MERGES (source -> target), summing stock and repointing every FK:
 *   - id 4  "Markaziy Sklad"            -> id 15 "Склад Центральный" (true central)
 *   - id 12 "Склад Кукча [merged->spot]"-> id 6  "Кукча"   (spot 1 store)
 *   - id 13 "Склад Рабочий [merged->spot]"-> id 7 "Рабочий" (spot 2 store)
 *
 * RECLASSIFY (no merge — keep all data in place):
 *   - id 14 "Склад Чигатай" central_warehouse -> store, renamed "Чигатай"
 *     (its Чигатай store spot does not exist, so the storage backs a store
 *      directly).
 *
 * Invariants honoured:
 *   - stock PK (location_id, product_id): merge by SUM (UPSERT then delete src).
 *   - stock qty >= 0 CHECK: summing only ever increases.
 *   - stock_movements chk_movement_distinct (from <> to): repointed rows that
 *     become self-loops are DELETED and counted (none expected in dev, but the
 *     guard is unconditional).
 *   - user_locations PK (user_id, location_id) and location_flows UNIQUE
 *     (from, to, flow_type): repoint, but skip/delete rows that would collide
 *     with an already-existing target row.
 *
 * IDEMPOTENT: re-running after a successful merge is a safe no-op — the source
 * rows (4, 12, 13) are gone, and id 14 is already type='store'. Everything runs
 * inside ONE transaction; any verification failure ROLLs BACK.
 *
 * Usage:  npx tsx scripts/fix-location-classification.ts
 * SAFETY: refuses to run unless DATABASE_URL points at a database whose name
 * contains "dev".
 */
import { withTransaction, query, closePool, type TxClient } from '../src/db/index.js';
import { loadConfig } from '../src/config/index.js';

/** A source -> target merge pair. */
type MergePair = { src: number; target: number; label: string };

const MERGES: readonly MergePair[] = [
  { src: 4, target: 15, label: 'Markaziy Sklad -> Склад Центральный' },
  { src: 12, target: 6, label: 'Склад Кукча -> Кукча (spot 1)' },
  { src: 13, target: 7, label: 'Склад Рабочий -> Рабочий (spot 2)' },
];

const CHIGATAY_ID = 14;
const SOURCE_IDS = MERGES.map((m) => m.src);

/** Every (table, column) that references locations(id), excluding stock /
 * stock_movements / user_locations / location_flows which need special
 * handling because of unique/PK/self-loop constraints. */
const SIMPLE_FK_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'locations', column: 'parent_id' },
  { table: 'users', column: 'location_id' },
  { table: 'replenishment_requests', column: 'requester_location_id' },
  { table: 'replenishment_requests', column: 'target_location_id' },
  { table: 'production_orders', column: 'location_id' },
  { table: 'production_orders', column: 'target_location_id' },
  { table: 'purchase_orders', column: 'target_location_id' },
  { table: 'sales', column: 'store_id' },
  { table: 'sales_stats_daily', column: 'location_id' },
  { table: 'audit_log', column: 'active_location_id' },
  { table: 'forecasts', column: 'location_id' },
  { table: 'production_dialog_sessions', column: 'location_id' },
  { table: 'nakladnoy', column: 'location_id' },
];

type Totals = { stockQty: number; stockRows: number; movements: number; locations: number };

async function snapshot(tx: TxClient): Promise<Totals> {
  const { rows } = await tx.query<{
    stock_qty: number;
    stock_rows: number;
    movements: number;
    locations: number;
  }>(
    `SELECT
       (SELECT COALESCE(SUM(qty), 0) FROM stock)            AS stock_qty,
       (SELECT COUNT(*) FROM stock)                         AS stock_rows,
       (SELECT COUNT(*) FROM stock_movements)               AS movements,
       (SELECT COUNT(*) FROM locations)                     AS locations`,
  );
  const r = rows[0];
  return {
    stockQty: Number(r.stock_qty),
    stockRows: Number(r.stock_rows),
    movements: Number(r.movements),
    locations: Number(r.locations),
  };
}

async function locationsByType(tx: TxClient): Promise<Record<string, number>> {
  const { rows } = await tx.query<{ type: string; n: string }>(
    `SELECT type, COUNT(*)::int AS n FROM locations GROUP BY type ORDER BY type`,
  );
  return Object.fromEntries(rows.map((r) => [r.type, Number(r.n)]));
}

async function namesByType(tx: TxClient, type: string): Promise<string[]> {
  const { rows } = await tx.query<{ name: string }>(
    `SELECT name FROM locations WHERE type = $1 ORDER BY name`,
    [type],
  );
  return rows.map((r) => r.name);
}

async function main(): Promise<void> {
  // --- SAFETY GUARD: dev database only -------------------------------------
  const cfg = loadConfig();
  const dbUrl = cfg.databaseUrl;
  // Extract the database name from the connection string (last path segment,
  // before any query string). Works for both URI and key/value forms.
  const dbName =
    dbUrl.match(/\/([^/?]+)(?:\?|$)/)?.[1] ??
    dbUrl.match(/dbname=([^\s&]+)/)?.[1] ??
    '';
  if (!/dev/i.test(dbName)) {
    throw new Error(
      `[fix-location] REFUSING to run: target database "${dbName}" is not a dev DB. ` +
        `This destructive merge is dev-only.`,
    );
  }
  console.log(`[fix-location] target database: ${dbName}`);

  const result = await withTransaction(async (tx) => {
    const before = await snapshot(tx);
    const beforeByType = await locationsByType(tx);

    // --- IDEMPOTENCY CHECK: already merged? ----------------------------------
    const { rows: srcRows } = await tx.query<{ id: number }>(
      `SELECT id FROM locations WHERE id = ANY($1::int[])`,
      [SOURCE_IDS],
    );
    const remainingSources = srcRows.map((r) => r.id);
    const { rows: chigatayRows } = await tx.query<{ type: string; name: string }>(
      `SELECT type, name FROM locations WHERE id = $1`,
      [CHIGATAY_ID],
    );
    const chigatay = chigatayRows[0];

    const alreadyMerged = remainingSources.length === 0;
    const chigatayDone = chigatay !== undefined && chigatay.type === 'store';

    if (alreadyMerged && chigatayDone) {
      console.log('[fix-location] already migrated — no source rows, id 14 is a store. No-op.');
      return { before, after: before, beforeByType, afterByType: beforeByType, selfLoops: 0, skipped: true };
    }

    let selfLoopsRemoved = 0;

    // ------------------------------------------------------------------ MERGES
    for (const { src, target, label } of MERGES) {
      if (!remainingSources.includes(src)) {
        console.log(`[fix-location] skip merge ${src}->${target} (source gone): ${label}`);
        continue;
      }
      console.log(`[fix-location] merging ${src} -> ${target}: ${label}`);

      // 1) stock — sum into target (UPSERT), then delete source rows.
      //    ON CONFLICT sums qty; min/max keep the target's values (the
      //    surviving location owns its own par levels). New (no conflict) rows
      //    carry the source qty but adopt manual mode + the summed qty as a
      //    safe placeholder for max_level (>= min_level CHECK).
      await tx.query(
        `INSERT INTO stock (location_id, product_id, qty, min_level, max_level, minmax_mode)
           SELECT $2, product_id, qty, min_level, max_level, minmax_mode
             FROM stock WHERE location_id = $1
         ON CONFLICT (location_id, product_id)
         DO UPDATE SET qty = stock.qty + EXCLUDED.qty`,
        [src, target],
      );
      await tx.query(`DELETE FROM stock WHERE location_id = $1`, [src]);

      // 2) stock_movements — repoint both endpoints, then delete self-loops
      //    that the repoint would create (chk_movement_distinct: from <> to).
      await tx.query(
        `UPDATE stock_movements SET from_location_id = $2 WHERE from_location_id = $1`,
        [src, target],
      );
      await tx.query(
        `UPDATE stock_movements SET to_location_id = $2 WHERE to_location_id = $1`,
        [src, target],
      );
      const { rowCount: loops } = await tx.query(
        `DELETE FROM stock_movements
          WHERE from_location_id IS NOT NULL
            AND from_location_id = to_location_id
            AND (from_location_id = $1 OR from_location_id = $2)`,
        [src, target],
      );
      if (loops > 0) {
        selfLoopsRemoved += loops;
        console.log(`[fix-location]   removed ${loops} self-loop movement(s) on ${target}`);
      }

      // 3) user_locations — PK (user_id, location_id). Delete source rows that
      //    would collide with an existing target row; repoint the rest.
      await tx.query(
        `DELETE FROM user_locations ul
          WHERE ul.location_id = $1
            AND EXISTS (SELECT 1 FROM user_locations t
                         WHERE t.user_id = ul.user_id AND t.location_id = $2)`,
        [src, target],
      );
      await tx.query(
        `UPDATE user_locations SET location_id = $2 WHERE location_id = $1`,
        [src, target],
      );

      // 4) location_flows — UNIQUE (from, to, flow_type) + CHECK (from <> to).
      //    Repoint to_location_id, dropping rows that would self-loop or
      //    collide with an existing target flow.
      await tx.query(
        `DELETE FROM location_flows f
          WHERE f.to_location_id = $1
            AND ( f.from_location_id = $2
                  OR EXISTS (SELECT 1 FROM location_flows e
                              WHERE e.from_location_id = f.from_location_id
                                AND e.to_location_id = $2
                                AND e.flow_type = f.flow_type) )`,
        [src, target],
      );
      await tx.query(`UPDATE location_flows SET to_location_id = $2 WHERE to_location_id = $1`, [src, target]);
      // Same treatment for from_location_id (none in dev, but be defensive).
      await tx.query(
        `DELETE FROM location_flows f
          WHERE f.from_location_id = $1
            AND ( f.to_location_id = $2
                  OR EXISTS (SELECT 1 FROM location_flows e
                              WHERE e.to_location_id = f.to_location_id
                                AND e.from_location_id = $2
                                AND e.flow_type = f.flow_type) )`,
        [src, target],
      );
      await tx.query(`UPDATE location_flows SET from_location_id = $2 WHERE from_location_id = $1`, [src, target]);

      // 5) all remaining simple FK columns — straight repoint.
      for (const { table, column } of SIMPLE_FK_COLUMNS) {
        await tx.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [src, target]);
      }

      // 6) inherit the source's poster_storage_id when the target has none.
      await tx.query(
        `UPDATE locations tgt
            SET poster_storage_id = src.poster_storage_id
           FROM locations src
          WHERE tgt.id = $2 AND src.id = $1
            AND tgt.poster_storage_id IS NULL
            AND src.poster_storage_id IS NOT NULL`,
        [src, target],
      );

      // 7) delete the now-orphaned source location row.
      await tx.query(`DELETE FROM locations WHERE id = $1`, [src]);
    }

    // ---------------------------------------------------- RECLASSIFY id 14
    if (!chigatayDone) {
      console.log(`[fix-location] reclassifying id ${CHIGATAY_ID}: central_warehouse -> store, name "Чигатай"`);
      await tx.query(
        `UPDATE locations SET type = 'store', name = 'Чигатай' WHERE id = $1`,
        [CHIGATAY_ID],
      );
    }

    // ------------------------------------------------------------- VERIFY
    const after = await snapshot(tx);
    const afterByType = await locationsByType(tx);

    // (a) no orphan FKs — every location-referencing column resolves.
    const allFkCols = [
      ...SIMPLE_FK_COLUMNS,
      { table: 'stock', column: 'location_id' },
      { table: 'stock_movements', column: 'from_location_id' },
      { table: 'stock_movements', column: 'to_location_id' },
      { table: 'user_locations', column: 'location_id' },
      { table: 'location_flows', column: 'from_location_id' },
      { table: 'location_flows', column: 'to_location_id' },
    ];
    for (const { table, column } of allFkCols) {
      const { rows } = await tx.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM ${table} t
          WHERE t.${column} IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = t.${column})`,
      );
      const orphans = Number(rows[0].n);
      if (orphans > 0) {
        throw new Error(`[verify] ${orphans} orphan FK(s) in ${table}.${column}`);
      }
    }

    // (b) stock conservation — sum preserved (merging adds, never drops).
    if (Math.abs(after.stockQty - before.stockQty) > 1e-6) {
      throw new Error(`[verify] stock qty changed: before=${before.stockQty} after=${after.stockQty}`);
    }

    // (c) movement conservation — equal modulo intentionally-removed self-loops.
    if (after.movements !== before.movements - selfLoopsRemoved) {
      throw new Error(
        `[verify] movements: before=${before.movements} after=${after.movements} ` +
          `selfLoopsRemoved=${selfLoopsRemoved} (expected after = before - selfLoops)`,
      );
    }

    // (d) source rows gone; id 14 is a store.
    const { rows: stillThere } = await tx.query<{ id: number }>(
      `SELECT id FROM locations WHERE id = ANY($1::int[])`,
      [SOURCE_IDS],
    );
    if (stillThere.length > 0) {
      throw new Error(`[verify] source rows still present: ${stillThere.map((r) => r.id).join(',')}`);
    }
    const { rows: ch } = await tx.query<{ type: string }>(`SELECT type FROM locations WHERE id = $1`, [CHIGATAY_ID]);
    if (ch[0]?.type !== 'store') {
      throw new Error(`[verify] id ${CHIGATAY_ID} type is "${ch[0]?.type}", expected "store"`);
    }

    // (e) central_warehouse is exactly {Склад Центральный}.
    const central = await namesByType(tx, 'central_warehouse');
    if (central.length !== 1 || central[0] !== 'Склад Центральный') {
      throw new Error(`[verify] central_warehouse set is ${JSON.stringify(central)}, expected ["Склад Центральный"]`);
    }

    // (f) target stores absorbed the data (15 central keeps stock; 6/7/14 stores have stock).
    const { rows: tgtStock } = await tx.query<{ location_id: number; n: string }>(
      `SELECT location_id, COUNT(*)::int AS n FROM stock WHERE location_id = ANY($1::int[]) GROUP BY location_id`,
      [[6, 7, 15, 14]],
    );
    console.log(`[fix-location] target stock rows: ${JSON.stringify(tgtStock)}`);

    const storeNames = await namesByType(tx, 'store');
    console.log(`[fix-location] VERIFY PASSED.`);
    console.log(`[fix-location] central_warehouse: ${JSON.stringify(central)}`);
    console.log(`[fix-location] store: ${JSON.stringify(storeNames)}`);

    return { before, after, beforeByType, afterByType, selfLoops: selfLoopsRemoved, skipped: false };
  });

  console.log('\n================ SUMMARY ================');
  console.log('skipped (already migrated):', result.skipped);
  console.log('locations by type BEFORE :', JSON.stringify(result.beforeByType));
  console.log('locations by type AFTER  :', JSON.stringify(result.afterByType));
  console.log('total stock qty   BEFORE :', result.before.stockQty);
  console.log('total stock qty   AFTER  :', result.after.stockQty);
  console.log('stock rows        BEFORE :', result.before.stockRows);
  console.log('stock rows        AFTER  :', result.after.stockRows);
  console.log('movements         BEFORE :', result.before.movements);
  console.log('movements         AFTER  :', result.after.movements);
  console.log('self-loops removed       :', result.selfLoops);
  console.log('locations count   BEFORE :', result.before.locations);
  console.log('locations count   AFTER  :', result.after.locations);
  console.log('========================================');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[fix-location] FAILED (rolled back):', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
