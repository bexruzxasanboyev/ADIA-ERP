/**
 * One-shot full Poster -> products/locations seed (runSeedSync, selector 'all').
 *
 * Re-runs the idempotent seed against LIVE Poster (POSTER_TOKEN in
 * apps/backend/.env, DB from DATABASE_URL). Used to re-apply enrichment after a
 * matcher improvement: товары are NOT re-created (syncMenuProducts only enriches
 * + drops), rows are not duplicated, only category_id / image_url /
 * workshop_location_id are refreshed and Г/П prepacks re-promoted to finished.
 *
 *   npm run poster:seed -w @adia/backend
 */
import { loadConfig } from '../src/config/index.js';
import { createPosterClientFromConfig } from '../src/integrations/poster/client.js';
import { runSeedSync } from '../src/integrations/poster/seedSync.js';
import { closePool } from '../src/db/pool.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.poster.token === '') {
    console.error('[seed] POSTER_TOKEN missing in apps/backend/.env — aborting.');
    process.exit(1);
  }
  console.log('[seed] starting full runSeedSync(all) against live Poster…');
  const client = createPosterClientFromConfig();
  const results = await runSeedSync(client, 'all');
  for (const r of results) {
    console.log(
      `[seed] ${r.entity} status=${r.status} in=${r.recordsIn} applied=${r.recordsApplied}` +
        (r.errorDetail ? ` :: ${r.errorDetail}` : ''),
    );
  }
  await closePool();
  console.log('[seed] done.');
}

main().catch(async (err) => {
  console.error('[seed] failed:', err);
  try {
    await closePool();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
