/**
 * One-off DEV data operation — attach each `sex_storage` location to its
 * matching `production` department by NAME, after refreshing the production /
 * sex_storage names from Poster.
 *
 * WHAT IT DOES (conservative, reversible):
 *   1. `syncStorages` — refresh the NAMES of every Poster-backed location
 *      (production / sex_storage). `type` is locked by ADR-0017 and never
 *      changes; only `name` is rotated. Store/raw/central rows are untouched
 *      beyond their own name refresh.
 *   2. `attachSexStoragesToDepts` — set `parent_id` of each sex_storage to its
 *      CONFIDENT name-matched production department (longest-token substring
 *      match, translit-aware). ONLY `parent_id` is written; `type` and
 *      `manager_user_id` are never touched. Unmatched rows and rows that
 *      already have a (different) human-set parent are LEFT AS-IS and reported.
 *
 * REVERSIBLE: the only mutation is `locations.parent_id`. The previous value of
 * every changed row is recorded in the `poster.sex_storage.attach` audit entry,
 * so the owner can restore it.
 *
 * IDEMPOTENT: a re-run that finds parents already correct is a no-op.
 *
 * Usage:
 *   npx tsx scripts/attach-sex-storages.ts            # refresh names + attach
 *   npx tsx scripts/attach-sex-storages.ts --dry-run  # report only, no writes
 *   npx tsx scripts/attach-sex-storages.ts --no-sync  # skip the Poster name refresh
 *
 * SAFETY: refuses to run unless DATABASE_URL points at a database whose name
 * contains "dev".
 */
import { closePool, query } from '../src/db/index.js';
import { loadConfig } from '../src/config/index.js';
import { createPosterClientFromConfig } from '../src/integrations/poster/client.js';
import {
  attachSexStoragesToDepts,
  syncStorages,
  type AttachPlanRow,
} from '../src/integrations/poster/seedSync.js';

function parseDbName(dbUrl: string): string {
  return (
    dbUrl.match(/\/([^/?]+)(?:\?|$)/)?.[1] ??
    dbUrl.match(/dbname=([^\s&]+)/)?.[1] ??
    ''
  );
}

type LocationRow = {
  id: number;
  name: string;
  type: string;
  parent_id: number | null;
  manager_user_id: number | null;
  poster_storage_id: number | null;
};

async function snapshotLocations(): Promise<LocationRow[]> {
  const { rows } = await query<LocationRow>(
    `SELECT id, name, type, parent_id, manager_user_id, poster_storage_id
       FROM locations WHERE type IN ('production', 'sex_storage')
      ORDER BY type, id`,
  );
  return rows;
}

function printLocations(label: string, rows: readonly LocationRow[]): void {
  console.log(`\n=== ${label} ===`);
  for (const r of rows) {
    console.log(
      `  id=${r.id}\ttype=${r.type}\tparent=${r.parent_id ?? '-'}\t` +
        `mgr=${r.manager_user_id ?? '-'}\tposter=${r.poster_storage_id ?? '-'}\tname="${r.name}"`,
    );
  }
}

function printPlan(rows: readonly AttachPlanRow[]): void {
  console.log('\n=== ATTACH PLAN ===');
  const order: AttachPlanRow['action'][] = [
    'set',
    'already',
    'skipped-has-parent',
    'unmatched',
  ];
  for (const action of order) {
    const group = rows.filter((r) => r.action === action);
    if (group.length === 0) continue;
    console.log(`\n  [${action}] (${group.length})`);
    for (const r of group) {
      const dept =
        r.matchedDeptName !== null
          ? `-> dept ${r.matchedDeptId} "${r.matchedDeptName}" (token="${r.matchedToken}")`
          : '(no confident match)';
      console.log(
        `    storage ${r.storageId} "${r.storageName}" (parent=${r.currentParentId ?? '-'}) ${dept}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const skipSync = args.has('--no-sync');

  // --- SAFETY GUARD: dev database only -------------------------------------
  const cfg = loadConfig();
  const dbName = parseDbName(cfg.databaseUrl);
  if (!/dev/i.test(dbName)) {
    throw new Error(
      `[attach-sex-storages] REFUSING to run: target database "${dbName}" is not a dev DB.`,
    );
  }
  console.log(`[attach-sex-storages] target database: ${dbName}`);
  console.log(`[attach-sex-storages] mode: ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY'}`);

  // 1) refresh names from Poster (name-only; type is locked by ADR-0017).
  if (!skipSync && !dryRun) {
    console.log('\n[attach-sex-storages] refreshing storage names from Poster…');
    const client = createPosterClientFromConfig();
    const res = await syncStorages(client, 'manual');
    console.log(
      `[attach-sex-storages] syncStorages: status=${res.status} in=${res.recordsIn} applied=${res.recordsApplied}` +
        (res.errorDetail !== undefined ? ` detail=${res.errorDetail}` : ''),
    );
  } else {
    console.log('\n[attach-sex-storages] skipping Poster name refresh.');
  }

  const before = await snapshotLocations();
  printLocations('locations BEFORE attach', before);

  // 2) build the plan + (unless dry-run) apply parent_id attaches.
  const result = await attachSexStoragesToDepts({ dryRun });
  printPlan(result.rows);

  const after = await snapshotLocations();
  printLocations('locations AFTER attach', after);

  console.log('\n================ SUMMARY ================');
  console.log('applied (parent_id set):', result.applied);
  console.log('matched but skipped (has parent):', result.rows.filter((r) => r.action === 'skipped-has-parent').length);
  console.log('already correct:', result.rows.filter((r) => r.action === 'already').length);
  console.log('UNMATCHED (need owner manual mapping):', result.rows.filter((r) => r.action === 'unmatched').length);
  console.log('========================================');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err: unknown) => {
    console.error('[attach-sex-storages] FAILED:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
