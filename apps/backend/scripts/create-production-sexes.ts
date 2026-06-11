/**
 * DEV data operation — create one `production` department per UNATTACHED
 * `sex_storage` location, and link the storage to its new department.
 *
 * Owner directive: "create the 18 sexes from Poster". Poster has NO production
 * department concept — only storages. ADIA models a production department as a
 * `locations.type='production'` row whose physical storage is a
 * `type='sex_storage'` row linked by `parent_id`. The Poster sync seeds the
 * sex_storage rows ("Склад Песочный", "Склад Самсы"…) but cannot know which
 * department they belong under. For every sex_storage still unparented we mint
 * a department named after the storage's product and attach the storage to it.
 *
 * WHAT IT DOES (conservative, reversible — NO deletes):
 *   For each `type='sex_storage'` location with `parent_id IS NULL`:
 *     1. Derive a clean department name: strip a leading "Склад "/"Sklad "
 *        prefix, append " sexi"  (e.g. "Склад Песочный" -> "Песочный sexi").
 *     2. Reuse an existing `type='production'` department with that exact name,
 *        or INSERT a new one (manager_user_id = NULL, is_active = true).
 *     3. Set the sex_storage's `parent_id` to that department id.
 *   Every create and every attach is recorded in `audit_log` (reversible: the
 *   new rows can be detached / archived; parent_id can be restored to NULL).
 *
 * IDEMPOTENT: a storage that is already parented is skipped; a department that
 * already exists by name is reused. A re-run yields 0 changes.
 *
 * Usage:
 *   npx tsx scripts/create-production-sexes.ts --dry-run  # plan only, no writes
 *   npx tsx scripts/create-production-sexes.ts            # apply
 *
 * SAFETY: refuses to run unless DATABASE_URL points at a DB whose name has "dev".
 */
import { closePool, query, withTransaction, type TxClient } from '../src/db/index.js';
import { loadConfig } from '../src/config/index.js';
import { writeAudit } from '../src/lib/audit.js';

/** Extract the database name from a libpq URL / keyword string. */
function parseDbName(dbUrl: string): string {
  return (
    dbUrl.match(/\/([^/?]+)(?:\?|$)/)?.[1] ??
    dbUrl.match(/dbname=([^\s&]+)/)?.[1] ??
    ''
  );
}

/**
 * Strip a leading storage-prefix word ("Склад "/"Sklad ") and append " sexi".
 * Whitespace is collapsed so a clean, readable Cyrillic department name results
 * regardless of stray spacing. If the storage name has no prefix the whole
 * name is kept and " sexi" appended.
 */
export function deriveDeptName(storageName: string): string {
  const cleaned = storageName
    .trim()
    .replace(/^(склад|sklad)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cleaned} sexi`;
}

type SexStorageRow = {
  readonly id: number;
  readonly name: string;
  readonly parent_id: number | null;
};

type DeptRow = { readonly id: number; readonly name: string };

type PlanRow = {
  readonly storageId: number;
  readonly storageName: string;
  readonly deptName: string;
  /** Set once known: the id of the reused or newly created department. */
  deptId: number | null;
  /** 'reuse-dept' | 'create-dept' — how the department was resolved. */
  deptAction: 'reuse-dept' | 'create-dept';
};

/** Load all unparented sex_storage rows (the ones that need a department). */
async function loadUnparentedStorages(): Promise<SexStorageRow[]> {
  const { rows } = await query<SexStorageRow>(
    `SELECT id, name, parent_id
       FROM locations
      WHERE type = 'sex_storage' AND parent_id IS NULL
      ORDER BY id`,
  );
  return rows;
}

/** Find an existing production department by EXACT name (idempotency). */
async function findDeptByName(runner: TxClient, name: string): Promise<DeptRow | null> {
  const { rows } = await runner.query<DeptRow>(
    `SELECT id, name FROM locations WHERE type = 'production' AND name = $1 LIMIT 1`,
    [name],
  );
  return rows[0] ?? null;
}

/**
 * Build the plan and (unless dryRun) apply it inside ONE transaction so the
 * department creates, parent_id attaches and audit rows commit or roll back
 * together. Returns the resolved plan rows for reporting.
 */
async function run(dryRun: boolean): Promise<{
  readonly plan: PlanRow[];
  readonly createdDepts: number;
  readonly reusedDepts: number;
  readonly attached: number;
}> {
  const storages = await loadUnparentedStorages();

  return withTransaction(async (tx) => {
    const plan: PlanRow[] = [];
    let createdDepts = 0;
    let reusedDepts = 0;
    let attached = 0;

    // Track depts created earlier in THIS run so two storages mapping to the
    // same derived name share one department (defensive — names are unique here).
    const createdByName = new Map<string, number>();

    for (const storage of storages) {
      const deptName = deriveDeptName(storage.name);

      // Resolve department: prefer one made earlier this run, then an existing
      // row by exact name, else create.
      let deptId = createdByName.get(deptName) ?? null;
      let deptAction: PlanRow['deptAction'] = 'reuse-dept';

      if (deptId === null) {
        const existing = await findDeptByName(tx, deptName);
        if (existing !== null) {
          deptId = existing.id;
          deptAction = 'reuse-dept';
          reusedDepts += 1;
        } else if (dryRun) {
          // No write in dry-run: report it as a would-be create.
          deptAction = 'create-dept';
        } else {
          const { rows } = await tx.query<{ id: number }>(
            `INSERT INTO locations (name, type, manager_user_id, is_active)
             VALUES ($1, 'production', NULL, TRUE)
             RETURNING id`,
            [deptName],
          );
          deptId = rows[0].id;
          deptAction = 'create-dept';
          createdDepts += 1;
          createdByName.set(deptName, deptId);
          await writeAudit(tx, {
            actorUserId: null,
            action: 'location.create',
            entity: 'locations',
            entityId: deptId,
            payload: {
              reason: 'create-production-sexes',
              name: deptName,
              type: 'production',
              derivedFromStorageId: storage.id,
              derivedFromStorageName: storage.name,
            },
          });
        }
      } else {
        reusedDepts += 1;
      }

      plan.push({
        storageId: storage.id,
        storageName: storage.name,
        deptName,
        deptId,
        deptAction,
      });

      // Attach the storage to the department (parent_id only — the single,
      // reversible mutation on the storage row).
      if (!dryRun && deptId !== null) {
        await tx.query(
          `UPDATE locations SET parent_id = $1, updated_at = now() WHERE id = $2`,
          [deptId, storage.id],
        );
        attached += 1;
        await writeAudit(tx, {
          actorUserId: null,
          action: 'location.attach_parent',
          entity: 'locations',
          entityId: storage.id,
          payload: {
            reason: 'create-production-sexes',
            storageName: storage.name,
            previousParentId: null,
            newParentId: deptId,
            deptName,
          },
        });
      }
    }

    return { plan, createdDepts, reusedDepts, attached };
  });
}

function printPlan(plan: readonly PlanRow[]): void {
  console.log('\n=== PLAN (sex_storage -> production department) ===');
  for (const r of plan) {
    const dept = r.deptId !== null ? `#${r.deptId}` : '(new)';
    console.log(
      `  storage ${r.storageId} "${r.storageName}"  ->  [${r.deptAction}] "${r.deptName}" ${dept}`,
    );
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');

  // --- SAFETY GUARD: dev database only -------------------------------------
  const cfg = loadConfig();
  const dbName = parseDbName(cfg.databaseUrl);
  if (!/dev/i.test(dbName)) {
    throw new Error(
      `[create-production-sexes] REFUSING to run: target database "${dbName}" is not a dev DB.`,
    );
  }
  console.log(`[create-production-sexes] target database: ${dbName}`);
  console.log(`[create-production-sexes] mode: ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY'}`);

  const result = await run(dryRun);
  printPlan(result.plan);

  console.log('\n================ SUMMARY ================');
  console.log(`unparented sex_storage rows processed: ${result.plan.length}`);
  console.log(`departments created: ${result.createdDepts}`);
  console.log(`departments reused (already existed): ${result.reusedDepts}`);
  console.log(`storages attached (parent_id set): ${result.attached}`);
  if (dryRun) console.log('(dry-run: NO writes were performed)');
  console.log('========================================');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[create-production-sexes] FAILED:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
